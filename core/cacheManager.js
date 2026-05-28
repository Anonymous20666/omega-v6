'use strict';

class LruTtlCache {
    constructor({ max = 5000, ttlMs = 5 * 60 * 1000 } = {}) {
        this.max = max;
        this.ttlMs = ttlMs;
        this.map = new Map();
    }

    _expired(entry) {
        return !entry || (entry.expiresAt > 0 && Date.now() > entry.expiresAt);
    }

    get(key) {
        const entry = this.map.get(key);
        if (this._expired(entry)) {
            this.map.delete(key);
            return null;
        }
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }

    set(key, value, ttlMs = this.ttlMs) {
        const expiresAt = ttlMs > 0 ? (Date.now() + ttlMs) : 0;
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, { value, expiresAt });
        this.prune();
    }

    has(key) {
        return this.get(key) !== null;
    }

    delete(key) {
        this.map.delete(key);
    }

    prune() {
        for (const [k, v] of this.map.entries()) {
            if (this._expired(v)) this.map.delete(k);
        }
        while (this.map.size > this.max) {
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
    }

    size() {
        return this.map.size;
    }
}

class CacheManager {
    constructor(metrics) {
        this.metrics = metrics;
        this.caches = {
            metadata: new LruTtlCache({ max: 8000, ttlMs: 15 * 60 * 1000 }),
            message: new LruTtlCache({ max: 20000, ttlMs: 30 * 60 * 1000 }),
            aiDedup: new LruTtlCache({ max: 10000, ttlMs: 2 * 60 * 1000 }),
            sender: new LruTtlCache({ max: 15000, ttlMs: 20 * 60 * 1000 }),
            profile: new LruTtlCache({ max: 4000, ttlMs: 60 * 60 * 1000 }),
            sticker: new LruTtlCache({ max: 3000, ttlMs: 60 * 60 * 1000 }),
        };
    }

    sweep() {
        let total = 0;
        for (const [name, cache] of Object.entries(this.caches)) {
            cache.prune();
            const size = cache.size();
            total += size;
            this.metrics?.setGauge?.(`cache.${name}.size`, size);
        }
        this.metrics?.setGauge?.('cache.total.size', total);
        return total;
    }
}

module.exports = { CacheManager, LruTtlCache };
