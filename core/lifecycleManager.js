'use strict';

/**
 * Tracks timers/listeners and provides deterministic cleanup hooks.
 */
class LifecycleManager {
    constructor(logger) {
        this.logger = logger;
        this.intervals = new Map();
        this.timeouts = new Map();
        this.cleanups = new Map();
    }

    addInterval(key, fn, ms) {
        this.clearInterval(key);
        const timer = setInterval(fn, ms);
        this.intervals.set(key, timer);
        return timer;
    }

    addTimeout(key, fn, ms) {
        this.clearTimeout(key);
        const timer = setTimeout(() => {
            this.timeouts.delete(key);
            fn();
        }, ms);
        this.timeouts.set(key, timer);
        return timer;
    }

    registerCleanup(key, fn) {
        this.cleanups.set(key, fn);
    }

    clearInterval(key) {
        const timer = this.intervals.get(key);
        if (timer) {
            clearInterval(timer);
            this.intervals.delete(key);
        }
    }

    clearTimeout(key) {
        const timer = this.timeouts.get(key);
        if (timer) {
            clearTimeout(timer);
            this.timeouts.delete(key);
        }
    }

    async shutdown(reason = 'manual') {
        for (const key of Array.from(this.intervals.keys())) this.clearInterval(key);
        for (const key of Array.from(this.timeouts.keys())) this.clearTimeout(key);

        for (const [key, fn] of this.cleanups.entries()) {
            try {
                await fn();
            } catch (err) {
                this.logger?.warn?.(`[Lifecycle] Cleanup failed ${key}: ${err.message}`);
            }
        }
        this.cleanups.clear();
        this.logger?.info?.(`[Lifecycle] Shutdown complete (${reason})`);
    }
}

module.exports = { LifecycleManager };
