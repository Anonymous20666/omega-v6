'use strict';

class RateLimitService {
    constructor({ windowMs = 15000, max = 20 } = {}) {
        this.windowMs = windowMs;
        this.max = max;
        this.map = new Map();
    }

    allow(key) {
        const now = Date.now();
        const arr = this.map.get(key) || [];
        const next = arr.filter((ts) => now - ts <= this.windowMs);
        if (next.length >= this.max) {
            this.map.set(key, next);
            return false;
        }
        next.push(now);
        this.map.set(key, next);
        return true;
    }
}

module.exports = { RateLimitService };
