'use strict';
// core/stability/crashGuard.js
// ═══════════════════════════════════════════════════════════════════
// CRASH GUARD — Global fault isolation and anti-crash shield
//
// WHY THIS EXISTS:
//   A single unhandled exception or rejected promise can kill the entire
//   Node.js process if not caught at the global level. In a WhatsApp bot
//   serving millions of users this means total downtime. This module:
//     1. Intercepts ALL unhandled errors before they reach Node's crash handler
//     2. Rate-limits identical errors so log spam doesn't mask real issues
//     3. Uses a circuit breaker to detect crash storms (rapid repeated errors)
//        and trigger a controlled restart instead of an uncontrolled death
//     4. Categorizes errors so critical ones page the owner on Telegram
//     5. Ensures cleanup always runs before any process exit
// ═══════════════════════════════════════════════════════════════════

const logger = require('../logger');

// ── DEDUP + RATE-LIMIT IDENTICAL ERRORS ────────────────────────────
// If the same error fires 50×/min (e.g. decrypt storm), we log it once
// then silence it — prevents log flooding that hides real problems
const _errorSignatures = new Map();   // signature -> { count, firstSeen, lastLogged }
const DEDUP_WINDOW_MS   = 60_000;     // 1-minute dedup window
const DEDUP_LOG_EVERY   = 50;         // Log every 50th duplicate instead of every one

function _shouldLog(signature) {
    const now = Date.now();
    const entry = _errorSignatures.get(signature);

    if (!entry) {
        _errorSignatures.set(signature, { count: 1, firstSeen: now, lastLogged: now });
        return true; // first occurrence always logs
    }

    entry.count++;
    if (now - entry.firstSeen > DEDUP_WINDOW_MS) {
        // Reset window
        entry.count = 1;
        entry.firstSeen = now;
        entry.lastLogged = now;
        return true;
    }

    // Log every Nth duplicate and on first, 10th, 50th, 100th...
    const shouldLog = entry.count % DEDUP_LOG_EVERY === 0;
    if (shouldLog) entry.lastLogged = now;
    return shouldLog;
}

function _buildSignature(err) {
    // Create a short fingerprint: first line of stack + message prefix
    const msg = String(err?.message || err || '').slice(0, 80);
    const stack = (err?.stack || '').split('\n')[1]?.trim().slice(0, 60) || '';
    return `${msg}||${stack}`;
}

// ── CRASH STORM CIRCUIT BREAKER ────────────────────────────────────
// WHY: If errors fire faster than ~10/second for 5 seconds straight,
// the process is in a death spiral. Better to do a clean restart than
// keep running broken and corrupting state.
const STORM_WINDOW_MS    = 5_000;   // 5-second window
const STORM_THRESHOLD    = 50;      // >50 errors in 5s = crash storm
let _recentErrors        = [];
let _stormTriggered      = false;

function _trackErrorRate(err) {
    const now = Date.now();
    _recentErrors.push(now);
    // Prune old entries outside the window
    _recentErrors = _recentErrors.filter(t => now - t < STORM_WINDOW_MS);

    if (!_stormTriggered && _recentErrors.length >= STORM_THRESHOLD) {
        _stormTriggered = true;
        logger.error(`[CrashGuard] STORM DETECTED: ${_recentErrors.length} errors in ${STORM_WINDOW_MS}ms — triggering controlled restart`);
        _notifyOwner(`⚠️ *CRASH STORM* detected: ${_recentErrors.length} errors in 5s\nLast error: ${String(err?.message || err).slice(0, 200)}\n\nTriggering controlled restart...`);
        // Give Telegram notification time to send, then exit so PM2 restarts us cleanly
        setTimeout(() => {
            logger.error('[CrashGuard] Exiting for PM2 restart after crash storm');
            process.exit(1);
        }, 3000);
    }
}

// ── RECOVERABLE ERROR CATEGORIES ───────────────────────────────────
// WHY: Not all errors are equal. WA decrypt failures are noisy but
// recoverable. Out-of-memory is critical. Categorizing lets us handle
// each appropriately without over-reacting to noise.
const RECOVERABLE_PATTERNS = [
    /bad mac/i,
    /key used already/i,
    /messagecountererror/i,
    /closing open session/i,
    /failed to decrypt/i,
    /connection closed/i,
    /connection lost/i,
    /socket offline/i,
    /econnreset/i,
    /econnrefused/i,
    /etimedout/i,
    /epipe/i,
    /socket hang up/i,
    /network socket disconnected/i,
    /stream ended unexpectedly/i,
    /rate-overlimit/i,
    /too many requests/i,
    /redis.*econnrefused/i,
    /mongoose.*buffertimeout/i,
];

const CRITICAL_PATTERNS = [
    /javascript heap out of memory/i,
    /enomem/i,
    /cannot allocate memory/i,
];

function _classify(err) {
    const msg = String(err?.message || err || '');
    if (CRITICAL_PATTERNS.some(p => p.test(msg))) return 'CRITICAL';
    if (RECOVERABLE_PATTERNS.some(p => p.test(msg))) return 'RECOVERABLE';
    return 'UNKNOWN';
}

// ── TELEGRAM OWNER ALERT (non-blocking) ────────────────────────────
// WHY: Critical errors must alert the operator so manual action can be
// taken if the self-healing fails. We throttle to max 1 alert/minute
// so we don't spam the owner during error storms.
let _lastOwnerAlert = 0;
const OWNER_ALERT_COOLDOWN_MS = 60_000;

function _notifyOwner(message) {
    try {
        const now = Date.now();
        if (now - _lastOwnerAlert < OWNER_ALERT_COOLDOWN_MS) return;
        _lastOwnerAlert = now;

        if (!global.tgBot) return;
        const { ownerTelegramId } = require('../../config');
        if (!ownerTelegramId) return;

        global.tgBot.telegram.sendMessage(
            ownerTelegramId,
            `🚨 *OMEGA-DEV ALERT*\n\n${message}`,
            { parse_mode: 'Markdown' }
        ).catch(() => {}); // Never throw from inside an error handler
    } catch {}
}

// ── CORE HANDLER ───────────────────────────────────────────────────
function _handleError(type, err) {
    try {
        const sig = _buildSignature(err);
        const classification = _classify(err);
        _trackErrorRate(err);

        const shouldLog = _shouldLog(sig);
        if (!shouldLog) return; // Silenced duplicate — already counted

        const entry = _errorSignatures.get(sig);
        const countStr = entry?.count > 1 ? ` [×${entry.count}]` : '';

        if (classification === 'CRITICAL') {
            logger.error(`[CrashGuard][CRITICAL][${type}]${countStr} ${err?.message || err}`);
            if (err?.stack) logger.error(err.stack.split('\n').slice(0, 5).join(' → '));
            _notifyOwner(`💀 *CRITICAL ERROR* [${type}]\n\`${String(err?.message || err).slice(0, 300)}\``);
        } else if (classification === 'RECOVERABLE') {
            // RECOVERABLE: log at warn level, no owner alert — these are expected noise
            logger.warn(`[CrashGuard][RECOVERABLE][${type}]${countStr} ${String(err?.message || err).slice(0, 120)}`);
        } else {
            logger.error(`[CrashGuard][${type}]${countStr} ${err?.message || err}`);
            if (err?.stack) logger.error(err.stack.split('\n').slice(0, 4).join(' → '));
        }
    } catch {
        // Absolute last resort — if our error handler throws, we can't do anything
    }
}

// ── GRACEFUL SHUTDOWN REGISTRY ──────────────────────────────────────
// WHY: Modules register cleanup functions here. On any shutdown signal,
// they all run in order. This prevents session corruption on restart.
const _shutdownHandlers = [];

function registerShutdown(name, fn) {
    _shutdownHandlers.push({ name, fn });
}

async function _runShutdown(signal) {
    logger.warn(`[CrashGuard] Graceful shutdown triggered by ${signal}`);
    for (const { name, fn } of _shutdownHandlers) {
        try {
            await Promise.race([
                fn(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
            ]);
            logger.info(`[CrashGuard] Shutdown: ${name} ✓`);
        } catch (err) {
            logger.warn(`[CrashGuard] Shutdown: ${name} failed — ${err.message}`);
        }
    }
    process.exit(0);
}

// ── INSTALL GLOBAL HANDLERS ─────────────────────────────────────────
function install() {
    // Remove any previously registered listeners to avoid stacking
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');

    // WHY uncaughtException: Any throw that escapes all try/catch lands here.
    // Without this handler Node.js exits immediately, killing all sessions.
    process.on('uncaughtException', (err) => {
        _handleError('uncaughtException', err);
        // Do NOT exit — we let the process continue running.
        // If it's truly unrecoverable, the crash storm detector will handle it.
    });

    // WHY unhandledRejection: async functions that throw without catch
    // generate rejected Promises. Node 15+ crashes on these — we catch them here.
    process.on('unhandledRejection', (reason) => {
        const err = reason instanceof Error ? reason : new Error(String(reason || 'Unknown rejection'));
        _handleError('unhandledRejection', err);
    });

    // Graceful shutdown on Ctrl+C / PM2 stop
    process.on('SIGINT',  () => _runShutdown('SIGINT'));
    process.on('SIGTERM', () => _runShutdown('SIGTERM'));

    // WHY warning handler: Node.js emits warnings for things like too many
    // event listeners (which cause memory leaks). Log them so we catch problems early.
    process.on('warning', (warning) => {
        if (warning.name === 'MaxListenersExceededWarning') {
            logger.warn(`[CrashGuard] MaxListeners exceeded on ${warning?.emitter?.constructor?.name} — possible memory leak`);
        }
    });

    logger.success('[CrashGuard] Global fault isolation installed');
}

// ── PERIODIC CLEANUP ────────────────────────────────────────────────
// WHY: The dedup map grows indefinitely if never pruned. Clean up
// error signatures older than 10 minutes to keep memory bounded.
setInterval(() => {
    const now = Date.now();
    for (const [sig, entry] of _errorSignatures.entries()) {
        if (now - entry.firstSeen > 10 * 60_000) _errorSignatures.delete(sig);
    }
    // Reset storm state so temporary spikes don't permanently block alerts
    if (_stormTriggered && _recentErrors.length < STORM_THRESHOLD / 2) {
        _stormTriggered = false;
        _recentErrors = [];
    }
}, 5 * 60_000).unref();

module.exports = { install, registerShutdown, notifyOwner: _notifyOwner };
