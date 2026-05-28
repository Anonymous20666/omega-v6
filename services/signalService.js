'use strict';

const fs = require('fs').promises;
const path = require('path');

class SignalService {
    constructor({ logger, sessionsDir }) {
        this.logger = logger;
        this.sessionsDir = sessionsDir;
    }

    async snapshotSession(sessionKey) {
        const src = path.join(this.sessionsDir, sessionKey);
        const dstDir = path.join(this.sessionsDir, '_backup', sessionKey);
        await fs.mkdir(dstDir, { recursive: true });
        const files = await fs.readdir(src);
        await Promise.all(files.map(async (name) => {
            if (!name.endsWith('.json')) return;
            const from = path.join(src, name);
            const to = path.join(dstDir, name);
            const raw = await fs.readFile(from);
            await fs.writeFile(to, raw);
        }));
        this.logger?.info?.(`[SignalService] snapshot complete ${sessionKey}`);
    }
}

module.exports = { SignalService };
