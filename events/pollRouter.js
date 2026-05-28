'use strict';

class PollRouter {
    canHandle(ctx) {
        const m = ctx.msg?.message || {};
        return !!(m.pollCreationMessage || m.pollUpdateMessage);
    }

    async handle(ctx) {
        ctx.flags.pollSeen = true;
    }
}

module.exports = { PollRouter };
