'use strict';

class MediaRouter {
    constructor({ mediaWorker }) {
        this.mediaWorker = mediaWorker;
    }

    canHandle(ctx) {
        const m = ctx.msg?.message || {};
        return !!(m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage);
    }

    async handle(ctx) {
        this.mediaWorker.submit(async () => {
            ctx.flags.mediaQueued = true;
        }, 6);
    }
}

module.exports = { MediaRouter };
