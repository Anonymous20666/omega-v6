'use strict';

class GroupRouter {
    constructor({ metadataService }) {
        this.metadataService = metadataService;
    }

    canHandle(ctx) {
        return !!ctx.isGroup;
    }

    async handle(ctx) {
        // lazy metadata refresh path
        if (ctx.flags.needsGroupMeta && ctx.sock?.groupMetadata) {
            await this.metadataService.getGroupMeta(ctx.sock, ctx.jid).catch(() => {});
        }
    }
}

module.exports = { GroupRouter };
