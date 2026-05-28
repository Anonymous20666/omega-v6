'use strict';

/**
 * Centralized adaptive presence scheduler per session.
 */
class PresenceManager {
    constructor({ logger, lifecycle, minIntervalMs = 45000 }) {
        this.logger = logger;
        this.lifecycle = lifecycle;
        this.minIntervalMs = minIntervalMs;
        this.active = new Map();
    }

    start(sessionKey, sock) {
        if (this.active.has(sessionKey)) return;
        const key = `presence:${sessionKey}`;
        this.lifecycle.addInterval(key, async () => {
            try {
                if (!sock?.user?.id) return;
                await sock.sendPresenceUpdate?.('available');
            } catch (err) {
                this.logger?.warn?.(`[Presence] ${sessionKey}: ${err.message}`);
            }
        }, this.minIntervalMs);
        this.active.set(sessionKey, key);
    }

    stop(sessionKey) {
        const key = this.active.get(sessionKey);
        if (!key) return;
        this.lifecycle.clearInterval(key);
        this.active.delete(sessionKey);
    }

    stopAll() {
        for (const sessionKey of Array.from(this.active.keys())) this.stop(sessionKey);
    }
}

module.exports = { PresenceManager };
