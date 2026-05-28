'use strict';

const PREFIX_RE = /^[.!/#]/;

class CommandRouter {
    constructor({ engine, logger }) {
        this.engine = engine;
        this.logger = logger;
    }

    canHandle(ctx) {
        return PREFIX_RE.test(String(ctx.text || '').trim());
    }

    async handle(ctx) {
        await this.engine.triggerMessage({
            sock: ctx.sock,
            msg: ctx.msg,
            text: ctx.text,
            isGroup: ctx.isGroup,
            sender: ctx.sender,
            botId: ctx.botId,
            isGroupAdmin: ctx.isGroupAdmin,
        });
    }
}

module.exports = { CommandRouter };
