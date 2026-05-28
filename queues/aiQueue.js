'use strict';

class AiQueue {
    constructor({ logger, concurrency = 2, dedupTtlMs = 60000 }) {
        this.logger = logger;
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
        this.dedup = new Map();
        this.dedupTtlMs = dedupTtlMs;
    }

    enqueue(key, task, priority = 5) {
        const now = Date.now();
        const last = this.dedup.get(key) || 0;
        if (now - last < this.dedupTtlMs) return false;
        this.dedup.set(key, now);

        this.queue.push({ key, task, priority, ts: now });
        this.queue.sort((a, b) => a.priority - b.priority || a.ts - b.ts);
        this._drain();
        return true;
    }

    _drain() {
        while (this.running < this.concurrency && this.queue.length > 0) {
            const item = this.queue.shift();
            this.running += 1;
            Promise.resolve(item.task())
                .catch((err) => this.logger?.warn?.(`[AiQueue] Task failed: ${err.message}`))
                .finally(() => {
                    this.running -= 1;
                    setImmediate(() => this._drain());
                });
        }
    }
}

module.exports = { AiQueue };
