'use strict';

class AiRouter {
    constructor({ aiWorker, logger }) {
        this.aiWorker = aiWorker;
        this.logger = logger;
    }

    canHandle(ctx) {
        if (!ctx.text) return false;
        const t = String(ctx.text).toLowerCase();
        return t.includes('pappy') || t.startsWith('ai ') || t.startsWith('/ai ');
    }

    async handle(ctx) {
        const dedupKey = `${ctx.botId}:${ctx.sender}:${(ctx.text || '').slice(0, 80)}`;
        this.aiWorker.submit(dedupKey, async () => {
            this.logger?.info?.(`[AiRouter] queued ${ctx.sender}`);
        }, 7);
    }
}

module.exports = { AiRouter };
