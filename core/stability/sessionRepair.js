'use strict';
// core/stability/sessionRepair.js
// ═══════════════════════════════════════════════════════════════════
// SESSION REPAIR ENGINE — Automatic session integrity and recovery
//
// WHY THIS EXISTS:
//   WhatsApp sessions break in several well-known ways:
//
//   1. BAD MAC / DECRYPT FAILURES — Signal protocol keys get out of sync.
//      The fix is to prune stale signal session files (session-*.json)
//      which forces the Signal ratchet to reset. The bot stays online.
//
//   2. CORRUPTED CREDS.JSON — The credentials file gets truncated on
//      an unclean shutdown. Detected by trying to parse it. Fix: restore
//      from backup if available, otherwise purge and prompt re-link.
//
//   3. CREDENTIAL EXPIRY — WhatsApp revokes credentials periodically.
//      Detected by the 'loggedOut' disconnect reason. Fix: clean session
//      and notify owner to re-pair.
//
//   4. SIGNAL FILE EXPLOSION — Sessions accumulate hundreds of
//      session-*.json and sender-key-*.json files. This causes slow
//      startups, high I/O, and eventually decrypt failures. Pruning
//      keeps the directory healthy.
//
//   5. GHOST SESSIONS — Folders without valid creds.json. Waste memory
//      and confuse the session loader. We sweep these on startup.
//
//   This module runs passively (no user-visible impact) and only
//   takes action when it detects a real problem.
// ═══════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const logger = require('../logger');

const SESSIONS_DIR       = path.join(__dirname, '../../data/sessions');
const MAX_SIGNAL_FILES   = 250;    // Per session dir — prune oldest above this
const MAX_SENDER_KEY_FILES = 500;  // sender-key files accumulate faster
const BACKUP_SUFFIX      = '.bak';

// ── PER-SESSION DECRYPT FAILURE TRACKER ────────────────────────────
// WHY: We count decrypt failures per session. When they spike (>8 in
// 90s), we auto-prune signal files for that session. This clears the
// bad key state without needing a full reconnect.
const _decryptFailures = new Map();   // sessionKey -> [timestamp, ...]
const FAILURE_WINDOW_MS   = 90_000;  // 90-second sliding window
const FAILURE_THRESHOLD   = 8;       // Prune trigger
const PRUNE_COOLDOWN_MS   = 3 * 60_000; // Don't prune same session more than once per 3min
const _lastPrune          = new Map();   // sessionKey -> timestamp

function recordDecryptFailure(sessionKey) {
    const now = Date.now();
    const times = (_decryptFailures.get(sessionKey) || []).filter(t => now - t < FAILURE_WINDOW_MS);
    times.push(now);
    _decryptFailures.set(sessionKey, times);

    if (times.length >= FAILURE_THRESHOLD) {
        const lastPruneTime = _lastPrune.get(sessionKey) || 0;
        if (now - lastPruneTime > PRUNE_COOLDOWN_MS) {
            _lastPrune.set(sessionKey, now);
            _decryptFailures.set(sessionKey, []); // reset counter
            logger.warn(`[SessionRepair] Decrypt spike on ${sessionKey} (${times.length} failures in ${FAILURE_WINDOW_MS / 1000}s) — pruning signal files`);
            pruneSignalFiles(sessionKey).catch((err) => logger.warn(`[SessionRepair] Async prune failed for ${sessionKey}: ${err.message}`));
        }
    }
}

// ── SIGNAL FILE PRUNER ──────────────────────────────────────────────
// WHY: Signal session files (session-*.json) represent encrypted
// ratchet states for each contact. Old ones are never cleaned up by
// Baileys and cause Bad MAC errors when the remote side has rotated
// their keys. Pruning keeps only the most recent N files.
async function pruneSignalFiles(sessionKey) {
    const sessionDir = path.join(SESSIONS_DIR, sessionKey);
    try { await fs.promises.access(sessionDir); } catch { return 0; }

    let pruned = 0;
    try {
        const allFiles = await fs.promises.readdir(sessionDir);

        // Prune session-*.json (Signal ratchet states)
        const signalFiles = (await Promise.all(
            allFiles
                .filter(f => f.startsWith('session-') && f.endsWith('.json'))
                .map(async (f) => ({ name: f, mt: await _safeMtime(path.join(sessionDir, f)) }))
        )).sort((a, b) => b.mt - a.mt); // newest first

        if (signalFiles.length > MAX_SIGNAL_FILES) {
            const toDelete = signalFiles.slice(MAX_SIGNAL_FILES);
            for (const { name } of toDelete) {
                try { await fs.promises.unlink(path.join(sessionDir, name)); pruned++; } catch {}
            }
        }

        // Prune sender-key-*.json (group message key states)
        const senderKeyFiles = (await Promise.all(
            allFiles
                .filter(f => f.startsWith('sender-key-') && f.endsWith('.json'))
                .map(async (f) => ({ name: f, mt: await _safeMtime(path.join(sessionDir, f)) }))
        )).sort((a, b) => b.mt - a.mt);

        if (senderKeyFiles.length > MAX_SENDER_KEY_FILES) {
            const toDelete = senderKeyFiles.slice(MAX_SENDER_KEY_FILES);
            for (const { name } of toDelete) {
                try { await fs.promises.unlink(path.join(sessionDir, name)); pruned++; } catch {}
            }
        }

        if (pruned > 0) logger.info(`[SessionRepair] Pruned ${pruned} stale signal/key files from ${sessionKey}`);
    } catch (err) {
        logger.warn(`[SessionRepair] Prune failed for ${sessionKey}: ${err.message}`);
    }
    return pruned;
}

async function _safeMtime(fp) {
    try { return (await fs.promises.stat(fp)).mtimeMs; } catch { return 0; }
}

// ── CREDENTIALS VALIDATOR ───────────────────────────────────────────
// WHY: An empty or malformed creds.json on startup causes Baileys to
// throw a cryptic error. We validate before loading and restore from
// backup if possible.
async function validateCredentials(sessionKey) {
    const sessionDir = path.join(SESSIONS_DIR, sessionKey);
    const credsPath  = path.join(sessionDir, 'creds.json');
    const backupPath = credsPath + BACKUP_SUFFIX;

    try {
        await fs.promises.access(credsPath);
    } catch {
        // Try to restore backup
        try {
            await fs.promises.access(backupPath);
            try {
                await fs.promises.copyFile(backupPath, credsPath);
                logger.warn(`[SessionRepair] Restored creds.json from backup for ${sessionKey}`);
                return { valid: true, restored: true };
            } catch {}
        } catch {}
        return { valid: false, reason: 'missing' };
    }

    try {
        const raw  = await fs.promises.readFile(credsPath, 'utf8');
        if (!raw || raw.trim() === '') throw new Error('empty');
        const creds = JSON.parse(raw);
        if (!creds || typeof creds !== 'object') throw new Error('invalid structure');

        // Valid — write a fresh backup
        try { await fs.promises.copyFile(credsPath, backupPath); } catch {}

        const isRegistered = creds.registered === true;
        return { valid: true, registered: isRegistered };
    } catch (err) {
        logger.warn(`[SessionRepair] Corrupt creds for ${sessionKey}: ${err.message}`);
        // Try backup
        try { await fs.promises.access(backupPath); } catch {
            return { valid: false, reason: 'corrupt' };
        }
        try {
                const backupRaw   = await fs.promises.readFile(backupPath, 'utf8');
                const backupCreds = JSON.parse(backupRaw);
                if (backupCreds && typeof backupCreds === 'object') {
                    await fs.promises.copyFile(backupPath, credsPath);
                    logger.warn(`[SessionRepair] Restored corrupt creds from backup for ${sessionKey}`);
                    return { valid: true, restored: true, registered: backupCreds.registered === true };
                }
            } catch {}
        return { valid: false, reason: 'corrupt' };
    }
}

// ── GHOST SESSION SWEEPER ────────────────────────────────────────────
// WHY: Directories without valid creds waste memory on startup as
// the loader tries to boot them. We nuke them before the boot loop.
async function sweepGhostSessions(options = {}) {
    const destructive = options.destructive === true;
    try { await fs.promises.access(SESSIONS_DIR); } catch { return 0; }

    let swept = 0;
    let checked = 0;
    try {
        for (const entry of await fs.promises.readdir(SESSIONS_DIR)) {
            const dirPath = path.join(SESSIONS_DIR, entry);
            try {
                if (!(await fs.promises.stat(dirPath)).isDirectory()) continue;
                checked++;
                const result = await validateCredentials(entry);
                if (!result.valid) {
                    if (destructive) {
                        await fs.promises.rm(dirPath, { recursive: true, force: true });
                        logger.warn(`[SessionRepair] Swept ghost session: ${entry} (reason: ${result.reason})`);
                        swept++;
                    } else {
                        logger.warn(`[SessionRepair] Ghost session detected (kept): ${entry} (reason: ${result.reason})`);
                    }
                }
            } catch {}
        }
    } catch (err) {
        logger.warn(`[SessionRepair] Ghost sweep error: ${err.message}`);
    }
    if (destructive && swept > 0) logger.success(`[SessionRepair] Ghost sweep: removed ${swept}/${checked} dead sessions`);
    return swept;
}

// ── PROACTIVE FULL AUDIT ─────────────────────────────────────────────
// WHY: Run periodically (not just on startup) so sessions that degrade
// over time get cleaned up automatically without manual intervention.
async function runFullAudit() {
    try { await fs.promises.access(SESSIONS_DIR); } catch { return; }
    logger.info('[SessionRepair] Running full session audit...');

    let totalPruned = 0;
    try {
        for (const entry of await fs.promises.readdir(SESSIONS_DIR)) {
            const dirPath = path.join(SESSIONS_DIR, entry);
            try {
                if (!(await fs.promises.stat(dirPath)).isDirectory()) continue;
                const result = await validateCredentials(entry);
                if (!result.valid) continue; // ghost sweep will handle

                // Prune oversized signal dirs
                const pruned = await pruneSignalFiles(entry);
                totalPruned += pruned;
            } catch {}
        }
    } catch {}

    if (totalPruned > 0) logger.info(`[SessionRepair] Audit pruned ${totalPruned} total signal files`);
}

// ── SCHEDULE PERIODIC AUDIT ─────────────────────────────────────────
// Run a full audit every 30 minutes
const _auditInterval = setInterval(() => { runFullAudit().catch(() => {}); }, 30 * 60_000);
_auditInterval.unref(); // don't block process exit

// ── LOGGED-OUT HANDLER ───────────────────────────────────────────────
// WHY: When WhatsApp logs out a session (credential expiry, ban, etc.)
// we clean up the session files immediately so a stale folder doesn't
// confuse the bot on next startup.
function handleLoggedOut(sessionKey) {
    const sessionDir = path.join(SESSIONS_DIR, sessionKey);
    logger.warn(`[SessionRepair] Session ${sessionKey} logged out — cleaning credentials`);

    // Remove creds.json so the session isn't auto-booted next restart
    const credsPath = path.join(sessionDir, 'creds.json');
    fs.promises.unlink(credsPath).catch(() => {});

    // Notify owner via Telegram
    try {
        const { notifyOwner } = require('./crashGuard');
        const parts = sessionKey.split('_');
        const phone = parts[1] || sessionKey;
        notifyOwner(`⚠️ *SESSION LOGGED OUT*\nBot +${phone} has been logged out by WhatsApp.\n\nUse /pair in Telegram to re-link.`);
    } catch {}
}

module.exports = {
    recordDecryptFailure,
    pruneSignalFiles,
    validateCredentials,
    sweepGhostSessions,
    runFullAudit,
    handleLoggedOut,
};
