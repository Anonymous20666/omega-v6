'use strict';

const { SOCKET_STATES } = require('./reconnectManager');

/**
 * Ensures one live socket per session key and cleans up stale/zombie sockets.
 */
class SocketManager {
    constructor({ logger, metrics }) {
        this.logger = logger;
        this.metrics = metrics;
        this.sockets = new Map();
        this.meta = new Map();
    }

    register(sessionKey, sock) {
        const existing = this.sockets.get(sessionKey);
        if (existing && existing !== sock) {
            try { existing.ws?.close?.(); } catch {}
            this.logger?.warn?.(`[SocketManager] Replaced stale socket ${sessionKey}`);
        }
        this.sockets.set(sessionKey, sock);
        this.meta.set(sessionKey, { state: SOCKET_STATES.CONNECTING, updatedAt: Date.now() });
        this.metrics?.setGauge?.('socket.count', this.sockets.size);
        return sock;
    }

    get(sessionKey) {
        return this.sockets.get(sessionKey) || null;
    }

    entries() {
        return this.sockets.entries();
    }

    setState(sessionKey, state) {
        const m = this.meta.get(sessionKey) || { state, updatedAt: Date.now() };
        m.state = state;
        m.updatedAt = Date.now();
        this.meta.set(sessionKey, m);
    }

    remove(sessionKey) {
        const sock = this.sockets.get(sessionKey);
        if (sock) {
            try { sock.ws?.close?.(); } catch {}
            this.sockets.delete(sessionKey);
        }
        this.meta.delete(sessionKey);
        this.metrics?.setGauge?.('socket.count', this.sockets.size);
    }

    cleanupZombies(maxIdleMs = 10 * 60 * 1000) {
        const now = Date.now();
        for (const [sessionKey, m] of this.meta.entries()) {
            if ((now - Number(m.updatedAt || 0)) > maxIdleMs && m.state !== SOCKET_STATES.OPEN) {
                this.logger?.warn?.(`[SocketManager] Zombie cleanup ${sessionKey}`);
                this.remove(sessionKey);
            }
        }
    }
}

module.exports = { SocketManager };
