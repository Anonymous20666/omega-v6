'use strict';

const os = require('os');
const { performance } = require('perf_hooks');

class CoreHealthMonitor {
    constructor({ logger, lifecycle, metrics, socketManager, cacheManager, reconnectManager }) {
        this.logger = logger;
        this.lifecycle = lifecycle;
        this.metrics = metrics;
        this.socketManager = socketManager;
        this.cacheManager = cacheManager;
        this.reconnectManager = reconnectManager;
        this.lastTick = performance.now();
    }

    start() {
        this.lifecycle.addInterval('core-health', () => this.tick(), 15000);
    }

    tick() {
        const now = performance.now();
        const lagMs = Math.max(0, now - this.lastTick - 15000);
        this.lastTick = now;

        const mem = process.memoryUsage();
        const rssMb = Math.round(mem.rss / (1024 * 1024));
        const cpuCount = os.cpus()?.length || 1;

        this.metrics?.setGauge?.('health.eventLoopLagMs', lagMs);
        this.metrics?.setGauge?.('health.rssMb', rssMb);
        this.metrics?.setGauge?.('health.cpuCount', cpuCount);

        this.cacheManager?.sweep?.();
        this.socketManager?.cleanupZombies?.();

        if (rssMb > 1200) {
            this.logger?.warn?.(`[Health] High RSS: ${rssMb}MB`);
        }
        if (lagMs > 500) {
            this.logger?.warn?.(`[Health] Event loop lag spike: ${Math.round(lagMs)}ms`);
        }
    }

    /**
     * Called by external monitors before they attempt a reconnect.
     * Returns true if it is safe to reconnect (no other reconnect in flight).
     * This is the single coordination gate that prevents triple-reconnect storms.
     */
    canReconnect(sessionKey) {
        if (!this.reconnectManager) return true;
        const s = this.reconnectManager.get(sessionKey);
        // Block if already reconnecting or a lock is held
        if (s.status === 'RECONNECTING') return false;
        if (this.reconnectManager.locks?.has(sessionKey)) return false;
        return true;
    }
}

module.exports = { CoreHealthMonitor };
