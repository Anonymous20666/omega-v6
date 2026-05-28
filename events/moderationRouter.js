'use strict';

class ModerationRouter {
    constructor({ antiSpamService }) {
        this.antiSpamService = antiSpamService;
    }

    canHandle(ctx) {
        return !!ctx.isGroup;
    }

    async handle(ctx) {
        if (this.antiSpamService.isSpam(ctx.jid, ctx.sender)) {
            ctx.flags.isThrottled = true;
        }
    }
}

module.exports = { ModerationRouter };
