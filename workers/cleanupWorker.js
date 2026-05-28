'use strict';

class CleanupWorker {
    constructor({ lifecycle, logger, cacheManager }) {
        this.lifecycle = lifecycle;
        this.logger = logger;
        this.cacheManager = cacheManager;
    }

    start() {
        this.lifecycle.addInterval('cleanup-worker', () => {
            const total = this.cacheManager?.sweep?.() || 0;
            this.logger?.info?.(`[CleanupWorker] cache-size=${total}`);
        }, 60000);
    }
}

module.exports = { CleanupWorker };
