'use strict';

class MediaQueue {
    constructor({ logger, concurrency = 3 }) {
        this.logger = logger;
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    enqueue(task, priority = 5) {
        this.queue.push({ task, priority, ts: Date.now() });
        this.queue.sort((a, b) => a.priority - b.priority || a.ts - b.ts);
        this._drain();
    }

    _drain() {
        while (this.running < this.concurrency && this.queue.length) {
            const next = this.queue.shift();
            this.running += 1;
            Promise.resolve(next.task())
                .catch((err) => this.logger?.warn?.(`[MediaQueue] Task failed: ${err.message}`))
                .finally(() => {
                    this.running -= 1;
                    setImmediate(() => this._drain());
                });
        }
    }
}

module.exports = { MediaQueue };
