'use strict';

class RetryQueue {
    constructor({ logger, concurrency = 2 }) {
        this.logger = logger;
        this.concurrency = concurrency;
        this.items = [];
        this.running = 0;
    }

    push(task, { delayMs = 0, attempts = 3, backoffMs = 1000 } = {}) {
        this.items.push({ task, attempts, backoffMs, runAt: Date.now() + delayMs });
        this._drain();
    }

    _nextReadyIndex() {
        const now = Date.now();
        return this.items.findIndex((i) => i.runAt <= now);
    }

    _drain() {
        while (this.running < this.concurrency) {
            const idx = this._nextReadyIndex();
            if (idx === -1) break;
            const item = this.items.splice(idx, 1)[0];
            this.running += 1;
            Promise.resolve()
                .then(() => item.task())
                .catch((err) => {
                    if (item.attempts > 1) {
                        this.items.push({
                            task: item.task,
                            attempts: item.attempts - 1,
                            backoffMs: Math.min(item.backoffMs * 2, 30000),
                            runAt: Date.now() + item.backoffMs,
                        });
                    } else {
                        this.logger?.warn?.(`[RetryQueue] Dropped task: ${err.message}`);
                    }
                })
                .finally(() => {
                    this.running -= 1;
                    setImmediate(() => this._drain());
                });
        }

        if (this.items.length > 0) {
            setTimeout(() => this._drain(), 250);
        }
    }
}

module.exports = { RetryQueue };
