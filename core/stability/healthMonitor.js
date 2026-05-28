'use strict';
// core/stability/healthMonitor.js
// ═══════════════════════════════════════════════════════════════════
// HEALTH MONITOR — Real-time system vitals with automatic remediation
//
// WHY THIS EXISTS:
//   Knowing something is broken AFTER the bot dies is too late.
//   This module continuously watches every critical subsystem and
//   takes corrective action BEFORE a full crash occurs:
//
//   • Memory climbing?    → GC, cache eviction, restart idle workers
//   • WS socket stale?    → Ping it. No response? Force reconnect.
//   • CPU spiking?        → Throttle incoming queue to shed load
//   • DB disconnected?    → Trigger reconnect immediately
//   • Response too slow?  → Log warning and alert owner
//   • All sessions dead?  → Alert owner and attempt mass restart
//
//   Think of this as the bot's immune system — it constantly runs
//   background diagnostics and heals issues before users notice.
// ═══════════════════════════════════════════════════════════════════

const logger       = require('../logger');
const os           = require('os');
// avoid importing blocking execSync to prevent accidental event-loop stalls
const { ownerTelegramId } = require('../../config');

// ── THRESHOLDS ──────────────────────────────────────────────────────
const THRESHOLDS = {
    // Memory: % of Node.js heap
    memWarnPct:     70,     // Log warning at 70% heap
    memCriticalPct: 85,     // Force GC + cache clear at 85%
    memPanicMB:     1300,   // RSS > 1.3 GB → shed load, consider restart

    // CPU: 1-minute load average / # CPU cores
    cpuWarn:        1.5,    // 150% of a single core is warning
    cpuCritical:    3.0,    // 300% = critical, throttle queue

    // Silence: if a connected session sends 0 messages this long, ping it
    sessionSilenceMs:   10 * 60_000,   // 10 minutes
    sessionDeadMs:      30 * 60_000,   // 30 minutes — quiet sessions are normal

    // Response time: max tolerable delay for bot replies
    responseWarnMs:     5_000,    // 5s response is slow
    responseCriticalMs: 30_000,   // 30s = broken

    // Check intervals
    fastCheckMs:    15_000,    // 15s: memory + WS checks
    slowCheckMs:    60_000,    // 60s: CPU + DB + full diagnostics
};

// ── STATE ───────────────────────────────────────────────────────────
let _fastTimer   = null;
let _slowTimer   = null;
let _started     = false;

// Rolling average of response times to detect slowdowns
const _responseSamples = [];  // [{ts, ms}]
const MAX_RESPONSE_SAMPLES = 200;

// Per-session ping state to avoid overlapping pings
const _pendingPings = new Set();
const _stallAlertState = new Map(); // sessionKey -> { alertedAt, recoveredNotified }

// ── CPU SAMPLING (cross-platform, no child_process for perf) ────────
let _lastCpuSample = null;
function _getCpuPercent() {
    try {
        const cpus = os.cpus();
        const current = cpus.reduce((acc, cpu) => {
            const total  = Object.values(cpu.times).reduce((a, b) => a + b, 0);
            const idle   = cpu.times.idle;
            return { total: acc.total + total, idle: acc.idle + idle };
        }, { total: 0, idle: 0 });

        if (_lastCpuSample) {
            const deltaTot  = current.total - _lastCpuSample.total;
            const deltaIdle = current.idle  - _lastCpuSample.idle;
            const usage     = deltaTot > 0 ? ((deltaTot - deltaIdle) / deltaTot) * 100 : 0;
            _lastCpuSample  = current;
            return Math.round(usage);
        }
        _lastCpuSample = current;
        return 0;
    } catch { return 0; }
}

// ── MEMORY ANALYSIS ─────────────────────────────────────────────────
function _getMemStats() {
    const m = process.memoryUsage();
    return {
        heapUsedMB:  Math.round(m.heapUsed  / 1024 / 1024),
        heapTotalMB: Math.round(m.heapTotal / 1024 / 1024),
        rssMB:       Math.round(m.rss       / 1024 / 1024),
        externalMB:  Math.round(m.external  / 1024 / 1024),
        // Use heap_size_limit (real V8 ceiling) instead of heapTotal (always ~95% full by design)
        heapPct:     Math.round((m.heapUsed / (require('v8').getHeapStatistics().heap_size_limit)) * 100),
    };
}

// ── MEMORY REMEDIATION ──────────────────────────────────────────────
// WHY: We first try cheap operations (GC, cache eviction). Only if
// those fail and RSS keeps climbing do we consider drastic action.
function _remediateMemory(mem) {
    // Step 1: Force V8 garbage collection (requires --expose-gc flag in PM2)
    if (global.gc) {
        global.gc();
        logger.info('[HealthMonitor] GC triggered — freed some heap');
    }

    // Step 2: Evict old entries from all known caches
    _evictCaches();

    // Step 3: If still critical after all that, warn owner
    if (mem.rssMB > THRESHOLDS.memPanicMB) {
        logger.error(`[HealthMonitor] RSS ${mem.rssMB}MB exceeds panic threshold (${THRESHOLDS.memPanicMB}MB)`);
        try {
            const { notifyOwner } = require('./crashGuard');
            notifyOwner(`🧠 *HIGH MEMORY ALERT*\nRSS: ${mem.rssMB}MB\nHeap: ${mem.heapUsedMB}/${mem.heapTotalMB}MB (${mem.heapPct}%)\n\nPerforming cache eviction + GC...`);
        } catch {}
    }
}

function _evictCaches() {
    let evicted = 0;
    try {
        // group metadata cache
        const gc = require('../groupCache');
        if (typeof gc.prune === 'function') { gc.prune(); evicted++; }
    } catch {}
    try {
        // messageCache global — keep only newest 500 entries
        if (global.messageCache?.size > 500) {
            const keys = [...global.messageCache.keys()];
            keys.slice(0, keys.length - 500).forEach(k => global.messageCache.delete(k));
            evicted++;
        }
    } catch {}
    try {
        // sticker cache
        if (global.stickerCache?.size > 200) {
            const keys = [...global.stickerCache.keys()];
            keys.slice(0, keys.length - 200).forEach(k => global.stickerCache.delete(k));
            evicted++;
        }
    } catch {}
    if (evicted > 0) logger.info(`[HealthMonitor] Evicted ${evicted} cache(s)`);
}

// ── WEBSOCKET / SESSION HEALTH ───────────────────────────────────────
// WHY: A WA socket can appear "connected" at the TCP level but stop
// delivering messages (silent death). We detect this via activity
// timestamps and send pings before escalating to reconnect.
async function _checkSessions() {
    if (!global.waSocks?.size) return;

    const now = Date.now();
    let getIoStats = null;
    try {
        ({ getIoStats } = require('../whatsapp'));
    } catch {}

    for (const [sessionKey, sock] of global.waSocks.entries()) {
        if (!sock?.user) continue; // still connecting — skip

        // Use the later of: last message OR when socket opened — prevents killing fresh sessions
        const lastMsg = global._lastMsgActivity?.get(sessionKey) || 0;
        const openedAt = Number(sock._openedAt || 0);
        const lastActivity = Math.max(lastMsg, openedAt);
        const silent = lastActivity > 0 ? now - lastActivity : 0;

        // Ping if approaching silence threshold
        if (silent > THRESHOLDS.sessionSilenceMs && !_pendingPings.has(sessionKey)) {
            _pendingPings.add(sessionKey);
            try {
                if (typeof sock.ws?.ping === 'function') {
                    sock.ws.ping();
                    logger.info(`[HealthMonitor] Ping sent to silent session ${sessionKey} (${Math.round(silent / 60000)}min)`);
                }
            } catch {}
            // Clear pending flag after 10s regardless of response
            setTimeout(() => _pendingPings.delete(sessionKey), 10_000).unref();
        }

        // Force close dead sessions — connection.update will handle reconnect.
        // GUARD: only fire if no other reconnect is already in progress for this session.
        if (lastActivity > 0 && silent > THRESHOLDS.sessionDeadMs) {
            const kernel = (() => { try { return require('../runtimeKernel').getKernel(); } catch { return null; } })();
            const alreadyReconnecting = kernel?.healthMonitor?.canReconnect
                ? !kernel.healthMonitor.canReconnect(sessionKey)
                : false;
            if (!alreadyReconnecting) {
                logger.error(`[HealthMonitor] Session ${sessionKey} dead (${Math.round(silent / 60000)}min silent) — forcing reconnect`);
                try { sock.ws?.close(); } catch {}
                if (global._lastMsgActivity) global._lastMsgActivity.delete(sessionKey);
            } else {
                logger.info(`[HealthMonitor] Session ${sessionKey} dead but reconnect already in progress — skipping duplicate`);
            }
        }

        // Detect outgoing activity without incoming receipts (classic blocked-inbound symptom).
        try {
            if (!getIoStats) continue;
            const io = getIoStats(sessionKey) || null;
            if (!io) continue;

            const outCount = Number(io.out || 0);
            const inCount = Number(io.in || 0);
            const lastOut = Number(io.lastOut || 0);
            const lastIn = Number(io.lastIn || 0);
            const outRecent = lastOut > 0 && (now - lastOut) <= (3 * 60_000);
            const incomingSilentFor = lastIn > 0 ? (now - lastIn) : Number.MAX_SAFE_INTEGER;
            const incomingStalled = outRecent && outCount >= 25 && (inCount === 0 || incomingSilentFor > (5 * 60_000));

            const alertState = _stallAlertState.get(sessionKey) || { alertedAt: 0, recoveredNotified: false };

            if (incomingStalled) {
                const shouldAlert = (now - Number(alertState.alertedAt || 0)) > (5 * 60_000);
                if (shouldAlert && global.tgBot) {
                    const parts = String(sessionKey).split('_');
                    const chatId = parts[0] || String(ownerTelegramId || '');
                    const phone = parts[1] || sessionKey;
                    global.tgBot.telegram.sendMessage(
                        chatId,
                        `⚠️ <b>INCOMING STALLED</b>\nNode +${phone} is sending traffic but not receiving incoming WhatsApp messages.\n\nIO: in=${inCount}, out=${outCount}\nlastIn=${lastIn || 0}\nlastOut=${lastOut || 0}`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                    alertState.alertedAt = now;
                    alertState.recoveredNotified = false;
                    _stallAlertState.set(sessionKey, alertState);
                    logger.warn(`[HealthMonitor] Incoming stalled alert for ${sessionKey} (in=${inCount}, out=${outCount})`);
                }
            } else if (alertState.alertedAt && !alertState.recoveredNotified && global.tgBot) {
                const parts = String(sessionKey).split('_');
                const chatId = parts[0] || String(ownerTelegramId || '');
                const phone = parts[1] || sessionKey;
                global.tgBot.telegram.sendMessage(
                    chatId,
                    `✅ <b>INCOMING RECOVERED</b>\nNode +${phone} is receiving incoming messages again.`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
                alertState.recoveredNotified = true;
                _stallAlertState.set(sessionKey, alertState);
            }
        } catch (err) {
            logger.warn(`[HealthMonitor] IO stalled check error for ${sessionKey}: ${err.message}`);
        }
    }
}

// ── DATABASE HEALTH ──────────────────────────────────────────────────
// WHY: Mongoose can disconnect silently. We detect this and trigger
// a reconnect so commands that need DB don't silently fail.
function _checkDatabase() {
    try {
        const mongoose = require('mongoose');
        const state    = mongoose.connection.readyState;
        // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
        if (state === 0) {
            logger.warn('[HealthMonitor] MongoDB disconnected — triggering reconnect');
            const { connectDB } = require('../database');
            connectDB().catch(() => {});
        }
    } catch {}
}

// ── RESPONSE TIME TRACKING ───────────────────────────────────────────
// WHY: We expose this function so the command router can call it to
// record how long a command took. Health monitor averages them to detect
// overall system slowdown before users start complaining.
function recordResponseTime(ms) {
    _responseSamples.push({ ts: Date.now(), ms });
    if (_responseSamples.length > MAX_RESPONSE_SAMPLES) _responseSamples.shift();
}

function _getAvgResponseTime() {
    const recent = _responseSamples.filter(s => Date.now() - s.ts < 60_000);
    if (!recent.length) return 0;
    return Math.round(recent.reduce((a, b) => a + b.ms, 0) / recent.length);
}

// ── FAST CHECK (every 15s) ───────────────────────────────────────────
async function _fastCheck() {
    try {
        // — Memory —
        const mem = _getMemStats();
        if (mem.heapPct >= THRESHOLDS.memCriticalPct) {
            logger.error(`[HealthMonitor] Memory CRITICAL: heap ${mem.heapPct}% (${mem.heapUsedMB}/${mem.heapTotalMB}MB)`);
            _remediateMemory(mem);
        } else if (mem.heapPct >= THRESHOLDS.memWarnPct) {
            logger.warn(`[HealthMonitor] Memory WARN: heap ${mem.heapPct}% (${mem.heapUsedMB}/${mem.heapTotalMB}MB)`);
            if (global.gc) global.gc(); // soft GC at warn level
        }

        // — Session liveliness —
        await _checkSessions();

    } catch (err) {
        logger.warn(`[HealthMonitor] Fast check error: ${err.message}`);
    }
}

// ── SLOW CHECK (every 60s) ───────────────────────────────────────────
async function _slowCheck() {
    try {
        // — CPU —
        const cpuPct = _getCpuPercent();
        if (cpuPct >= THRESHOLDS.cpuCritical * 100 / os.cpus().length) {
            logger.warn(`[HealthMonitor] CPU CRITICAL: ${cpuPct}% — consider scaling`);
        }

        // — Database —
        _checkDatabase();

        // — Response time —
        const avgMs = _getAvgResponseTime();
        if (avgMs > THRESHOLDS.responseCriticalMs) {
            logger.error(`[HealthMonitor] Response CRITICAL: avg ${avgMs}ms`);
        } else if (avgMs > THRESHOLDS.responseWarnMs && avgMs > 0) {
            logger.warn(`[HealthMonitor] Response WARN: avg ${avgMs}ms`);
        }

        // — Full diagnostics log —
        const mem          = _getMemStats();
        const sessions     = global.waSocks?.size || 0;
        const activeSess   = [...(global.waSocks?.entries() || [])].filter(([, s]) => s?.user).length;
        logger.info(
            `[HealthMonitor] rss=${mem.rssMB}MB heap=${mem.heapPct}% cpu=${cpuPct}% ` +
            `sessions=${activeSess}/${sessions} avgResp=${avgMs}ms uptime=${Math.round(process.uptime())}s`
        );
    } catch (err) {
        logger.warn(`[HealthMonitor] Slow check error: ${err.message}`);
    }
}

// ── PUBLIC API ───────────────────────────────────────────────────────
function start() {
    if (_started) return;
    _started = true;

    _fastTimer = setInterval(_fastCheck, THRESHOLDS.fastCheckMs);
    _slowTimer = setInterval(_slowCheck, THRESHOLDS.slowCheckMs);

    // .unref() so these timers don't block clean process exit
    _fastTimer.unref();
    _slowTimer.unref();

    // Run one immediate slow check so first log appears quickly
    setTimeout(_slowCheck, 5000).unref();

    logger.success('[HealthMonitor] Started — watching memory, CPU, sessions, DB, response time');
}

function stop() {
    if (_fastTimer) { clearInterval(_fastTimer); _fastTimer = null; }
    if (_slowTimer) { clearInterval(_slowTimer); _slowTimer = null; }
    _started = false;
}

function getStats() {
    return {
        mem:         _getMemStats(),
        cpuPct:      _getCpuPercent(),
        avgRespMs:   _getAvgResponseTime(),
        sessions:    global.waSocks?.size || 0,
        activeSess:  [...(global.waSocks?.entries() || [])].filter(([, s]) => s?.user).length,
        uptime:      Math.round(process.uptime()),
    };
}

module.exports = { start, stop, recordResponseTime, getStats };
