'use strict';

class MetadataService {
    constructor({ cacheManager, logger }) {
        this.cache = cacheManager?.caches?.metadata;
        this.logger = logger;
    }

    async getGroupMeta(sock, jid) {
        const cached = this.cache?.get(jid);
        if (cached) return cached;
        const meta = await sock.groupMetadata(jid);
        this.cache?.set(jid, meta, 10 * 60 * 1000);
        return meta;
    }
}

module.exports = { MetadataService };
