'use strict';

/**
 * Non-blocking dispatcher that routes to specialized handlers.
 * Keep this function lightweight: parse, route, return.
 */
class MessageRouter {
    constructor({ logger, routers = [] }) {
        this.logger = logger;
        this.routers = routers;
    }

    async dispatch(ctx) {
        const tasks = [];
        for (const router of this.routers) {
            try {
                if (!router.canHandle(ctx)) continue;
                tasks.push(Promise.resolve().then(() => router.handle(ctx)));
            } catch (err) {
                this.logger?.warn?.(`[MessageRouter] Router error: ${err.message}`);
            }
        }

        // Do not block upstream loop on slow handlers.
        Promise.allSettled(tasks).catch(() => {});
    }
}

module.exports = { MessageRouter };
