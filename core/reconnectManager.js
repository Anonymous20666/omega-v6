'use strict';

const STATES = Object.freeze({
    CONNECTING: 'CONNECTING',
    OPEN: 'OPEN',
    RECONNECTING: 'RECONNECTING',
    DISCONNECTED: 'DISCONNECTED',
    DEAD: 'DEAD',
    DESTROYED: 'DESTROYED',
});

class ReconnectManager {
    constructor({ logger, lifecycle, metrics, baseDelayMs = 1500, maxDelayMs = 120000, maxAttempts = 50 }) {
        this.logger = logger;
        this.lifecycle = lifecycle;
        this.metrics = metrics;
        this.baseDelayMs = baseDelayMs;
        this.maxDelayMs = maxDelayMs;
        this.maxAttempts = maxAttempts;
        this.state = new Map();
        this.locks = new Set();
    }

    get(sessionKey) {
        return this.state.get(sessionKey) || { status: STATES.DISCONNECTED, attempts: 0, cooldownUntil: 0 };
    }

    setState(sessionKey, status) {
        const s = this.get(sessionKey);
        s.status = status;
        this.state.set(sessionKey, s);
        this.metrics?.setGauge?.(`socket.${sessionKey}.state`, Object.values(STATES).indexOf(status));
    }

    computeDelay(attempt) {
        const exp = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** Math.max(0, attempt - 1)));
        const jitter = Math.floor(Math.random() * 1000);
        return Math.min(this.maxDelayMs, exp + jitter);
    }

    async schedule(sessionKey, reconnectFn, reasonOrOptions = 'close') {
        if (this.locks.has(sessionKey)) {
            this.logger?.info?.(`[Reconnect] ${sessionKey} already locked — skipping duplicate schedule`);
            return false;
        }
        const s = this.get(sessionKey);
        if (s.status === STATES.DESTROYED || s.status === STATES.DEAD) return false;

        const opts = (reasonOrOptions && typeof reasonOrOptions === 'object' && !Array.isArray(reasonOrOptions))
            ? reasonOrOptions
            : { reason: reasonOrOptions };
        const reason = String(opts.reason || 'close');
        const requestedDelay = Number(opts.delayMs);

        s.attempts += 1;
        if (s.attempts > this.maxAttempts) {
            s.status = STATES.DEAD;
            this.state.set(sessionKey, s);
            this.logger?.error?.(`[Reconnect] Max attempts reached for ${sessionKey}`);
            return false;
        }

        this.locks.add(sessionKey);
        s.status = STATES.RECONNECTING;
        const delayMs = Number.isFinite(requestedDelay) && requestedDelay >= 0
            ? Math.min(this.maxDelayMs, requestedDelay)
            : this.computeDelay(s.attempts);
        s.cooldownUntil = Date.now() + delayMs;
        this.state.set(sessionKey, s);
        this.metrics?.inc?.('reconnect.scheduled');

        this.lifecycle?.addTimeout(`reconnect:${sessionKey}`, async () => {
            try {
                await reconnectFn();
            } finally {
                this.locks.delete(sessionKey);
            }
        }, delayMs);

        this.logger?.warn?.(`[Reconnect] ${sessionKey} scheduled in ${delayMs}ms (${reason})`);
        return true;
    }

    markOpen(sessionKey) {
        const s = this.get(sessionKey);
        s.status = STATES.OPEN;
        s.attempts = 0;
        s.cooldownUntil = 0;
        this.state.set(sessionKey, s);
        this.locks.delete(sessionKey);
    }

    destroy(sessionKey) {
        const s = this.get(sessionKey);
        s.status = STATES.DESTROYED;
        this.state.set(sessionKey, s);
        this.locks.delete(sessionKey);
        this.lifecycle?.clearTimeout?.(`reconnect:${sessionKey}`);
    }
}

module.exports = { ReconnectManager, SOCKET_STATES: STATES };
