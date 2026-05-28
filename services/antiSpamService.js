'use strict';

class AntiSpamService {
    constructor({ rateLimitService }) {
        this.rateLimitService = rateLimitService;
    }

    isSpam(chatJid, sender) {
        const key = `${chatJid}:${sender}`;
        return !this.rateLimitService.allow(key);
    }
}

module.exports = { AntiSpamService };
