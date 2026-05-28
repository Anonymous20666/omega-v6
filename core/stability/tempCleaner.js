'use strict';
// core/stability/tempCleaner.js
// ═══════════════════════════════════════════════════════════════════
// TEMP CLEANER — Automatic resource and log lifecycle management
//
// WHY THIS EXISTS:
//   Long-running bots accumulate temporary files that are never cleaned:
//
//   • temp_media/: Every .song, .img, .video, .sticker command downloads
//     files here. Without cleanup, disk fills up and I/O slows down.
//     We saw 10+ MB of stale music files from days ago in the data dir.
//
//   • data/logs/: System logs rotate daily but old PM2 logs don't.
//     Log files can grow to hundreds of MB, eating disk and causing
//     the log write stream to stall under high load.
//
//   • data/yt_cache/ and data/sticker_cache/: YouTube and sticker
//     downloads cache infinitely. Old entries waste disk space.
//
//   • Orphaned temp files: Failed downloads leave partial files that
//     block the same operation on retry.
//
//   This cleaner runs on a schedule and is intentionally conservative:
//   it only deletes files OLDER than a safe age threshold.
// ═══════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const logger = require('../logger');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const DATA_DIR = path.join(__dirname, '../../data');

// ── CLEANUP TARGETS ──────────────────────────────────────────────────
// Each entry defines: directory, max file age (ms), optional extensions filter
// WHY: Different directories have different churn rates and safety windows.
const TARGETS = [
    {
        // Media downloads — songs, videos, images for bot commands
        // After the file is sent to WA, it's never needed again.
        dir:        path.join(DATA_DIR, 'temp_media'),
        maxAgeMs:   15 * 60_000,    // 15 minutes — more than enough to send
        label:      'temp_media',
        extensions: ['.mp3', '.mp4', '.webm', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.opus', '.m4a', '.tmp'],
    },
    {
        // YouTube cache — yt-dlp output and metadata
        dir:        path.join(DATA_DIR, 'yt_cache'),
        maxAgeMs:   4 * 60 * 60_000,  // 4 hours
        label:      'yt_cache',
    },
    {
        // Sticker cache — WebP conversions
        dir:        path.join(DATA_DIR, 'sticker_cache'),
        maxAgeMs:   12 * 60 * 60_000,  // 12 hours
        label:      'sticker_cache',
    },
    {
        // PM2 out/error logs — these can grow huge. Keep only 50MB total.
        // We use size-based rotation here instead of age-based.
        dir:        path.join(DATA_DIR, 'logs'),
        maxSizeBytes: 50 * 1024 * 1024,  // 50 MB per log file
        label:      'pm2_logs',
        sizeRotate: true,
        filenames:  ['pm2-out.log', 'pm2-err.log'],
    },
    {
        // System logs older than 3 days
        dir:        path.join(DATA_DIR, 'logs'),
        maxAgeMs:   3 * 24 * 60 * 60_000,  // 3 days
        label:      'system_logs',
        prefix:     'system-',
        extensions: ['.log'],
    },
];

// ── FILE AGE CLEANUP ─────────────────────────────────────────────────
async function _cleanByAge(target) {
    const { dir, maxAgeMs, label, extensions, prefix } = target;
    try { await fs.promises.access(dir); } catch { return 0; }

    const cutoff = Date.now() - maxAgeMs;
    let deleted = 0;
    let freed   = 0;

    try {
        for (const entry of await fs.promises.readdir(dir)) {
            // Filter by extension if specified
            if (extensions && !extensions.includes(path.extname(entry).toLowerCase())) continue;
            // Filter by prefix if specified
            if (prefix && !entry.startsWith(prefix)) continue;

            const fp = path.join(dir, entry);
            try {
                const stat = await fs.promises.stat(fp);
                if (stat.isDirectory()) continue; // skip subdirs
                if (stat.mtimeMs < cutoff) {
                    freed += stat.size;
                    await fs.promises.unlink(fp);
                    deleted++;
                }
            } catch {}
        }
    } catch (err) {
        logger.warn(`[TempCleaner] ${label} scan error: ${err.message}`);
    }

    if (deleted > 0) {
        logger.info(`[TempCleaner] ${label}: deleted ${deleted} file(s), freed ${_fmt(freed)}`);
    }
    return deleted;
}

// ── SIZE-BASED LOG ROTATION ──────────────────────────────────────────
// WHY: PM2 logs (pm2-out.log, pm2-err.log) are written to continuously.
// If they grow past 50MB the write stream starts blocking, causing micro-
// freezes in the main event loop. We truncate rather than delete so PM2
// can keep writing without needing a restart.
async function _rotateLargeLog(filePath, maxBytes) {
    try {
        await fs.promises.access(filePath);
        const stat = await fs.promises.stat(filePath);
        if (stat.size <= maxBytes) return;

        // Keep the last 5MB (most recent logs are most useful)
        const keepBytes = 5 * 1024 * 1024;
        const fd = await fs.promises.open(filePath, 'r');
        const buf = Buffer.alloc(keepBytes);
        await fd.read(buf, 0, keepBytes, stat.size - keepBytes);
        await fd.close();

        // Overwrite with just the tail
        await fs.promises.writeFile(filePath, buf);
        logger.info(`[TempCleaner] Rotated ${path.basename(filePath)}: ${_fmt(stat.size)} → ${_fmt(keepBytes)}`);
    } catch (err) {
        logger.warn(`[TempCleaner] Log rotation failed for ${path.basename(filePath)}: ${err.message}`);
    }
}

// ── ORPHAN FILE CLEANER ──────────────────────────────────────────────
// WHY: Files that are still being written (mtime within last 30s) should
// not be deleted. This function identifies truly orphaned partial files
// — those modified long ago but never completed (e.g. failed downloads).
async function _cleanOrphans(dir, staleMs = 10 * 60_000) {
    try { await fs.promises.access(dir); } catch { return 0; }
    const cutoff = Date.now() - staleMs;
    let cleaned = 0;

    try {
        for (const entry of await fs.promises.readdir(dir)) {
            // Partial download markers
            if (!entry.endsWith('.tmp') && !entry.endsWith('.part') && !entry.endsWith('.download')) continue;
            const fp = path.join(dir, entry);
            try {
                const stat = await fs.promises.stat(fp);
                if (!stat.isDirectory() && stat.mtimeMs < cutoff) {
                    await fs.promises.unlink(fp);
                    cleaned++;
                }
            } catch {}
        }
    } catch {}
    return cleaned;
}

// ── MAIN CLEANUP RUNNER ──────────────────────────────────────────────
async function runCleanup() {
    let totalDeleted = 0;

    for (const target of TARGETS) {
        try {
            if (target.sizeRotate) {
                // Size-based rotation for PM2 logs
                for (const filename of (target.filenames || [])) {
                    await _rotateLargeLog(path.join(target.dir, filename), target.maxSizeBytes);
                }
            } else {
                totalDeleted += (await _cleanByAge(target)) || 0;
            }
        } catch (err) {
            logger.warn(`[TempCleaner] Error cleaning ${target.label}: ${err.message}`);
        }
    }

    // Clean orphaned partial downloads
    const orphans = await _cleanOrphans(path.join(DATA_DIR, 'temp_media'));
    if (orphans > 0) logger.info(`[TempCleaner] Removed ${orphans} orphaned partial download(s)`);

    totalDeleted += orphans;
}

// ── DISK USAGE CHECK ─────────────────────────────────────────────────
// WHY: If disk is nearly full, bot operations start failing silently
// (downloads fail, session writes fail). We alert before that happens.
async function checkDiskUsage() {
    try {
        // df -k /opt — returns percentage used
        const { stdout } = await execFileAsync('sh', ['-lc', 'df -k /opt 2>/dev/null || df -k /'], { timeout: 3000 });
        const output = stdout.toString();
        const lines  = output.trim().split('\n');
        const last   = lines[lines.length - 1];
        const match  = last.match(/(\d+)%/);
        if (!match) return;

        const usedPct = parseInt(match[1]);
        if (usedPct >= 90) {
            logger.error(`[TempCleaner] DISK CRITICAL: ${usedPct}% used — running emergency cleanup`);
            // Emergency: aggressively clean everything
            await _emergencyClean();
            try {
                const { notifyOwner } = require('./crashGuard');
                notifyOwner(`💾 *DISK CRITICAL*\nDisk usage: ${usedPct}%\nEmergency cleanup triggered.`);
            } catch {}
        } else if (usedPct >= 80) {
            logger.warn(`[TempCleaner] Disk WARN: ${usedPct}% used`);
        }
    } catch {}
}

async function _emergencyClean() {
    // Clear ALL temp_media regardless of age
    try {
        const dir = path.join(DATA_DIR, 'temp_media');
        if (await fs.promises.access(dir).then(() => true).catch(() => false)) {
            for (const f of await fs.promises.readdir(dir)) {
                try { await fs.promises.unlink(path.join(dir, f)); } catch {}
            }
        }
    } catch {}
    // Clear yt_cache entirely
    try {
        const dir = path.join(DATA_DIR, 'yt_cache');
        if (await fs.promises.access(dir).then(() => true).catch(() => false)) {
            for (const f of await fs.promises.readdir(dir)) {
                try { await fs.promises.unlink(path.join(dir, f)); } catch {}
            }
        }
    } catch {}
}

// ── FORMATTING HELPER ────────────────────────────────────────────────
function _fmt(bytes) {
    if (bytes < 1024)       return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ── SCHEDULE ─────────────────────────────────────────────────────────
let _cleanTimer  = null;
let _diskTimer   = null;

function start() {
    // Run immediately on start to clean up anything left from last run
    setTimeout(() => runCleanup().catch(() => {}), 5000).unref();

    // Then every 10 minutes
    _cleanTimer = setInterval(() => runCleanup().catch(() => {}), 10 * 60_000);
    _cleanTimer.unref();

    // Disk check every 15 minutes
    _diskTimer = setInterval(() => checkDiskUsage().catch(() => {}), 15 * 60_000);
    _diskTimer.unref();

    logger.success('[TempCleaner] Started — auto-cleaning temp_media, logs, caches');
}

function stop() {
    if (_cleanTimer) { clearInterval(_cleanTimer); _cleanTimer = null; }
    if (_diskTimer)  { clearInterval(_diskTimer);  _diskTimer  = null; }
}

module.exports = { start, stop, runCleanup, checkDiskUsage };
