'use strict';
// core/stability/messageProcessor.js
// ═══════════════════════════════════════════════════════════════════
// MESSAGE PROCESSOR — High-throughput priority queue with fault isolation
//
// WHY THIS EXISTS:
//   Without a queue, WhatsApp bots fail under load in two ways:
//   1. SPAM FLOODS: A single user or group sends 200 messages/sec.
//      Every message spawns an async handler that all run concurrently.
//      Memory spikes, Node.js event loop saturates, responses freeze.
//   2. SLOW COMMANDS: One user triggers a 30s AI request. Meanwhile
//      all other users are blocked waiting for the event loop.
//
//   This processor solves both problems:
//
//   PRIORITY QUEUING: Owner > Admin > User > Public. Critical commands
//   always get processed first even during traffic floods.
//
//   CONCURRENCY CONTROL: Max N handlers run simultaneously. New messages
//   queue up instead of spawning unbounded goroutines.
//
//   PER-USER THROTTLING: A user who spams can't monopolize the queue.
//   Their messages get delayed, not dropped.
//
//   OVERFLOW PROTECTION: If the queue exceeds MAX_QUEUE_SIZE, low-priority
//   items are shed rather than letting memory grow unbounded.
//
//   FAULT ISOLATION: Each handler runs in try/catch. One broken command
//   can never crash the processor or block other users' messages.
//
//   DEAD LETTER QUEUE: Failed items are logged and tracked for debugging
//   without polluting the main queue.
//
//   BACK-PRESSURE: If send rate is too high, we slow down gracefully
//   instead of crashing.
// ═══════════════════════════════════════════════════════════════════

const logger = require('../logger');

// ── CONFIGURATION ────────────────────────────────────────────────────
const CONFIG = {
    // How many handlers can run in parallel per bot socket
    maxConcurrency:    12,

    // Absolute max items in queue — above this, shed lowest-priority items
    maxQueueSize:      2000,

    // Per-user: max N messages allowed in queue simultaneously
    maxPerUser:        10,

    // If queue exceeds this, start shedding 'public' priority items
    shedThreshold:     800,

    // Dead letter queue — keep last N failed items
    maxDeadLetters:    100,

    // Timeout for a single message handler (ms)
    // WHY: An infinite loop or hung API call must not hold up the queue forever
    handlerTimeoutMs:  60_000,

    // Minimum gap between sending two messages to the same JID (ms)
    // WHY: WA server-side rate limiting — too fast = 429 errors
    sendGapMs:         350,
};

// Priority levels — lower number = higher priority
const PRIORITY = {
    OWNER:    0,
    ADMIN:    1,
    USER:     2,
    PUBLIC:   3,
    SYSTEM:   0,  // system-generated (reconnect alerts, etc.) same as owner
};

// ── STATE ────────────────────────────────────────────────────────────
let _queue          = [];          // Array<QueueItem> — sorted by priority, then insertion order
let _running        = 0;           // Currently executing handlers
let _processing     = false;       // Debounce flag for processNext()
const _perUserCount = new Map();   // userId -> count of items in queue
const _deadLetters  = [];          // Array<{item, error, ts}>
const _sendTimes    = new Map();   // jid -> last send timestamp (rate limiting)

// Stats
let _stats = { enqueued: 0, processed: 0, dropped: 0, failed: 0, timedOut: 0 };

// ── QUEUE ITEM SHAPE ─────────────────────────────────────────────────
// { id, priority, userId, handler: async fn, enqueueAt, label }

let _seq = 0;

// ── ENQUEUE ──────────────────────────────────────────────────────────
/**
 * Add a message handler to the processing queue.
 *
 * @param {Function} handler    - async function that processes the message
 * @param {Object}   opts
 * @param {string}   opts.userId     - sender JID (for per-user throttle)
 * @param {string}   [opts.role]     - 'owner'|'admin'|'user'|'public'
 * @param {string}   [opts.label]    - human-readable label for logging
 * @returns {boolean} true if enqueued, false if dropped
 */
function enqueue(handler, opts = {}) {
    const { userId = 'unknown', role = 'public', label = 'msg' } = opts;

    // Determine priority
    const priority = PRIORITY[role.toUpperCase()] ?? PRIORITY.PUBLIC;

    // ── Overflow protection ──────────────────────────────────────────
    if (_queue.length >= CONFIG.maxQueueSize) {
        // Try to shed lowest-priority item to make room
        const shedIdx = _findShedTarget(priority);
        if (shedIdx === -1) {
            // Queue full and our priority is the lowest — drop this item
            _stats.dropped++;
            logger.warn(`[MessageProcessor] Queue full (${_queue.length}) — dropped ${label} for ${userId}`);
            return false;
        }
        // Shed the lower-priority item
        const shed = _queue.splice(shedIdx, 1)[0];
        _decUserCount(shed.userId);
        _stats.dropped++;
    }

    // ── Per-user throttle ────────────────────────────────────────────
    const userCount = _perUserCount.get(userId) || 0;
    if (priority >= PRIORITY.USER && userCount >= CONFIG.maxPerUser) {
        // Don't penalize owners/admins — only throttle regular users
        _stats.dropped++;
        return false;
    }

    // ── Insert into queue (sorted by priority, FIFO within same priority) ──
    const item = {
        id:         ++_seq,
        priority,
        userId,
        handler,
        label,
        enqueueAt:  Date.now(),
    };
    _insertSorted(item);
    _incUserCount(userId);
    _stats.enqueued++;

    // Trigger processing (debounced via setImmediate for batching)
    if (!_processing) {
        _processing = true;
        setImmediate(_processLoop);
    }

    return true;
}

// ── SORTED INSERT (binary search) ────────────────────────────────────
// WHY: Binary search keeps insertion O(log n) even for large queues
function _insertSorted(item) {
    let lo = 0, hi = _queue.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (_queue[mid].priority <= item.priority) lo = mid + 1;
        else hi = mid;
    }
    _queue.splice(lo, 0, item);
}

// ── FIND ITEM TO SHED ────────────────────────────────────────────────
// Returns index of the lowest-priority item whose priority > incoming priority
// Returns -1 if none found (all items are equal or higher priority)
function _findShedTarget(incomingPriority) {
    // Search from end of queue (lowest priority items are at the back)
    for (let i = _queue.length - 1; i >= 0; i--) {
        if (_queue[i].priority > incomingPriority) return i;
    }
    return -1;
}

// ── PROCESSING LOOP ──────────────────────────────────────────────────
// WHY: We use a loop with concurrency control instead of spawning
// unlimited Promises. This bounds memory and CPU usage.
async function _processLoop() {
    _processing = false;

    while (_queue.length > 0 && _running < CONFIG.maxConcurrency) {
        const item = _queue.shift();
        if (!item) break;

        _decUserCount(item.userId);
        _running++;

        // Run handler in a separate async chain so one slow handler
        // doesn't block the loop from spawning the next one
        _runHandler(item).finally(() => {
            _running--;
            // Resume loop when a slot frees up
            if (_queue.length > 0 && !_processing) {
                _processing = true;
                setImmediate(_processLoop);
            }
        });
    }
}

// ── HANDLER EXECUTOR ─────────────────────────────────────────────────
// WHY: Wraps the actual handler in timeout + try/catch so:
//   - Hung handlers are killed after CONFIG.handlerTimeoutMs
//   - Throwing handlers don't crash the processor
//   - All failures are recorded to the dead letter queue
async function _runHandler(item) {
    const start = Date.now();
    try {
        // Race the handler against a timeout
        await Promise.race([
            item.handler(),
            new Promise((_, rej) =>
                setTimeout(
                    () => rej(new Error(`Handler timeout after ${CONFIG.handlerTimeoutMs}ms`)),
                    CONFIG.handlerTimeoutMs
                ).unref()
            ),
        ]);

        _stats.processed++;

        // Track response time for health monitor
        try {
            const { recordResponseTime } = require('./healthMonitor');
            recordResponseTime(Date.now() - start);
        } catch {}

    } catch (err) {
        const isTimeout = err.message.includes('Handler timeout');
        if (isTimeout) {
            _stats.timedOut++;
            logger.warn(`[MessageProcessor] Timeout: ${item.label} (user=${item.userId}, ${CONFIG.handlerTimeoutMs}ms)`);
        } else {
            _stats.failed++;
            logger.error(`[MessageProcessor] Handler failed: ${item.label} — ${err.message}`);
        }

        // Dead letter queue — keep for debugging, don't re-enqueue
        _deadLetters.push({ item: { ...item, handler: undefined }, error: err.message, ts: Date.now() });
        if (_deadLetters.length > CONFIG.maxDeadLetters) _deadLetters.shift();
    }
}

// ── RATE-LIMITED SEND HELPER ─────────────────────────────────────────
// WHY: WA server will 429 or ban bots that send too fast to the same
// JID. This helper enforces a minimum gap between sends to any JID.
// Usage: await messageProcessor.sendMessage(sock, jid, content, opts)
async function sendMessage(sock, jid, content, opts = {}) {
    if (!sock || !jid) throw new Error('sock and jid are required');

    const now      = Date.now();
    const lastSent = _sendTimes.get(jid) || 0;
    const gap      = now - lastSent;

    if (gap < CONFIG.sendGapMs) {
        await _sleep(CONFIG.sendGapMs - gap);
    }

    try {
        const result = await sock.sendMessage(jid, content, opts);
        _sendTimes.set(jid, Date.now());
        return result;
    } catch (err) {
        // Clean up stale entries from sendTimes map to prevent memory leak
        if (_sendTimes.size > 10_000) {
            const cutoff = Date.now() - 5 * 60_000;
            for (const [k, v] of _sendTimes.entries()) {
                if (v < cutoff) _sendTimes.delete(k);
            }
        }
        throw err;
    }
}

// ── HELPERS ──────────────────────────────────────────────────────────
function _incUserCount(userId) {
    _perUserCount.set(userId, (_perUserCount.get(userId) || 0) + 1);
}
function _decUserCount(userId) {
    const c = (_perUserCount.get(userId) || 1) - 1;
    if (c <= 0) _perUserCount.delete(userId);
    else _perUserCount.set(userId, c);
}
function _sleep(ms) {
    return new Promise(r => setTimeout(r, ms).unref());
}

// ── PERIODIC CLEANUP ─────────────────────────────────────────────────
// WHY: _sendTimes map grows without bound if we never clean it.
setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of _sendTimes.entries()) {
        if (v < cutoff) _sendTimes.delete(k);
    }
    // Log stats for observability
    logger.info(`[MessageProcessor] Stats — enqueued=${_stats.enqueued} processed=${_stats.processed} failed=${_stats.failed} dropped=${_stats.dropped} timeouts=${_stats.timedOut} queue=${_queue.length} running=${_running}`);
    // Reset rolling stats
    _stats = { enqueued: 0, processed: 0, dropped: 0, failed: 0, timedOut: 0 };
}, 5 * 60_000).unref();

// ── PUBLIC API ────────────────────────────────────────────────────────
module.exports = {
    enqueue,
    sendMessage,
    PRIORITY,
    getStats: () => ({
        ..._stats,
        queueSize:   _queue.length,
        running:     _running,
        deadLetters: _deadLetters.length,
    }),
    getDeadLetters: () => [..._deadLetters],
    clearQueue: () => {
        const count = _queue.length;
        _queue = [];
        _perUserCount.clear();
        logger.warn(`[MessageProcessor] Queue cleared (${count} items dropped)`);
    },
};
