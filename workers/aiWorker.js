'use strict';

class AiWorker {
    constructor({ logger, aiQueue, timeoutMs = 25000 }) {
        this.logger = logger;
        this.aiQueue = aiQueue;
        this.timeoutMs = timeoutMs;
    }

    submit(key, fn, priority = 5) {
        return this.aiQueue.enqueue(key, async () => {
            await Promise.race([
                Promise.resolve().then(fn),
                new Promise((_, reject) => setTimeout(() => reject(new Error('ai-timeout')), this.timeoutMs)),
            ]);
        }, priority);
    }
}

module.exports = { AiWorker };
