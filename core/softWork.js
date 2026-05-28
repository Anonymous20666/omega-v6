// core/softWork.js
// 🎯 SOFT WORK SYSTEM - Rate limiting & gentle command execution to prevent node bans

'use strict';

const logger = require('./logger');

/**
 * SOFT WORK SYSTEM:
 * - Delays commands that are known to trigger bans (aggressive commands)
 * - Uses rate limiting per sender/command
 * - Applies exponential backoff for repeated commands
 * - Ensures gentle behavior to avoid WhatsApp flags
 */

// Command risk levels
const COMMAND_RISK_LEVELS = {
    // HIGH RISK: Can trigger 24h-72h bans
    '.ban': 'critical',
    '.kick': 'critical',
    '.demote': 'critical',
    '.promote': 'critical',
    '.announce': 'critical',
    '.tagall': 'critical',
    '.gcast': 'high',
    '.broadcast': 'high',
    '.invite': 'high',
    '.delete': 'high',
    '.tag': 'high',
    '.ggstatus': 'high',
    '.godcast': 'high',
    
    // MEDIUM RISK: May trigger temporary issues
    '.sticker': 'medium',
    '.img': 'medium',
    '.play': 'medium',
    '.autojoin': 'medium',
    '.msg': 'medium',
    '.reply': 'medium',
    
    // LOW RISK: Safe commands
    '.menu': 'low',
    '.help': 'low',
    '.status': 'low',
    '.ping': 'low',
    '.info': 'low',
};

// Delay configurations (milliseconds)
const RISK_DELAYS = {
    critical: { min: 5000, max: 15000 },   // 5-15 seconds
    high: { min: 2000, max: 8000 },         // 2-8 seconds
    medium: { min: 500, max: 2000 },        // 500ms-2s
    low: { min: 0, max: 100 },              // 0-100ms
};

// Rate limit tracking: sender -> { cmd: { count, lastTime, blocked } }
const _rateLimits = new Map();

// Per-sender command tracking for exponential backoff
const _senderCmdHistory = new Map();

/**
 * Get risk level for a command
 */
function getRiskLevel(cmd) {
    const normalized = String(cmd || '').toLowerCase().trim();
    return COMMAND_RISK_LEVELS[normalized] || 'low';
}

/**
 * Calculate soft delay based on risk level and rate limiting
 */
function calculateSoftDelay(cmd, sender) {
    const risk = getRiskLevel(cmd);
    const { min, max } = RISK_DELAYS[risk] || RISK_DELAYS.low;
    
    // Base delay with randomization
    let delay = min + Math.random() * (max - min);
    
    // Get sender history
    const history = _senderCmdHistory.get(sender) || {};
    const cmdHistory = history[cmd] || { count: 0, lastTime: 0 };
    
    // Exponential backoff: if same command executed within 30 seconds, increase delay
    const timeSinceLastCmd = Date.now() - cmdHistory.lastTime;
    if (timeSinceLastCmd < 30000 && cmdHistory.count > 0) {
        const backoffFactor = Math.min(cmdHistory.count, 5);
        delay *= (1 + backoffFactor * 0.5); // 50% increase per repeat
    }
    
    // Per-command rate limiting
    const limitKey = `${sender}:${cmd}`;
    let rateLimit = _rateLimits.get(limitKey) || { count: 0, lastTime: 0, blocked: false };
    
    // Reset if time window passed (60 seconds)
    if (Date.now() - rateLimit.lastTime > 60000) {
        rateLimit = { count: 0, lastTime: Date.now(), blocked: false };
    }
    
    // Check rate limits by risk level
    const maxPerMinute = {
        critical: 2,  // 2 per minute max
        high: 5,      // 5 per minute max
        medium: 10,   // 10 per minute max
        low: 30,      // 30 per minute max
    };
    
    const limit = maxPerMinute[risk] || maxPerMinute.low;
    if (rateLimit.count >= limit) {
        // Rate limit exceeded - apply penalty
        const penaltyFactor = Math.min(rateLimit.count - limit + 1, 10);
        delay *= (1 + penaltyFactor * 2); // 2x increase per violation
        rateLimit.blocked = true;
    }
    
    rateLimit.count++;
    rateLimit.lastTime = Date.now();
    _rateLimits.set(limitKey, rateLimit);
    
    // Update sender history
    if (!_senderCmdHistory.has(sender)) {
        _senderCmdHistory.set(sender, {});
    }
    const senderHistory = _senderCmdHistory.get(sender);
    senderHistory[cmd] = {
        count: cmdHistory.count + 1,
        lastTime: Date.now(),
    };
    
    // Cleanup old history entries (keep only last 50 entries per sender)
    if (Object.keys(senderHistory).length > 50) {
        const sorted = Object.entries(senderHistory).sort((a, b) => b[1].lastTime - a[1].lastTime);
        _senderCmdHistory.set(sender, Object.fromEntries(sorted.slice(0, 25)));
    }
    
    return Math.ceil(delay);
}

/**
 * Apply soft delay to command execution
 */
async function applySoftDelay(cmd, sender) {
    const delay = calculateSoftDelay(cmd, sender);
    if (delay > 0) {
        if (typeof logger.debug === 'function') {
            logger.debug(`[SoftWork] Delaying ${cmd} from ${sender} for ${delay}ms (risk: ${getRiskLevel(cmd)})`);
        }
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    return delay;
}

/**
 * Wrap a command executor with soft work protection
 */
async function executeWithSoftWork(cmd, sender, executeFn) {
    try {
        const delay = await applySoftDelay(cmd, sender);
        const result = await executeFn();
        return result;
    } catch (err) {
        logger.error(`[SoftWork] Command execution failed: ${err.message}`, { cmd, sender });
        throw err;
    }
}

/**
 * Get current rate limit status for a sender
 */
function getRateLimitStatus(sender) {
    const limits = {};
    for (const [key, value] of _rateLimits.entries()) {
        if (key.startsWith(`${sender}:`)) {
            const cmd = key.split(':')[1];
            limits[cmd] = {
                count: value.count,
                blocked: value.blocked,
                resetIn: Math.max(0, 60000 - (Date.now() - value.lastTime)),
            };
        }
    }
    return limits;
}

/**
 * Reset rate limits for a command or sender
 */
function resetRateLimit(sender, cmd = null) {
    if (cmd) {
        _rateLimits.delete(`${sender}:${cmd}`);
    } else {
        for (const key of _rateLimits.keys()) {
            if (key.startsWith(`${sender}:`)) {
                _rateLimits.delete(key);
            }
        }
    }
}

/**
 * Cleanup old entries periodically
 */
setInterval(() => {
    // Clean rate limits older than 5 minutes
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    for (const [key, value] of _rateLimits.entries()) {
        if (value.lastTime < fiveMinutesAgo) {
            _rateLimits.delete(key);
        }
    }
    
    // Clean sender history older than 10 minutes
    const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
    for (const [sender, history] of _senderCmdHistory.entries()) {
        const cleaned = {};
        for (const [cmd, data] of Object.entries(history)) {
            if (data.lastTime > tenMinutesAgo) {
                cleaned[cmd] = data;
            }
        }
        if (Object.keys(cleaned).length === 0) {
            _senderCmdHistory.delete(sender);
        } else {
            _senderCmdHistory.set(sender, cleaned);
        }
    }
}, 60000).unref();

module.exports = {
    getRiskLevel,
    calculateSoftDelay,
    applySoftDelay,
    executeWithSoftWork,
    getRateLimitStatus,
    resetRateLimit,
    COMMAND_RISK_LEVELS,
};
