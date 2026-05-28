'use strict';

const fs = require('fs').promises;
const path = require('path');

class SessionIntegrity {
    constructor({ logger, sessionsDir }) {
        this.logger = logger;
        this.sessionsDir = sessionsDir;
    }

    async validate(sessionKey) {
        const dir = path.join(this.sessionsDir, sessionKey);
        const creds = path.join(dir, 'creds.json');
        try {
            const raw = await fs.readFile(creds, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            return { valid: !!parsed?.registered, registered: !!parsed?.registered };
        } catch (err) {
            this.logger?.warn?.(`[SessionIntegrity] Invalid ${sessionKey}: ${err.message}`);
            return { valid: false, registered: false };
        }
    }

    async listValidSessions() {
        try {
            const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
            const result = [];
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const sessionKey = entry.name;
                const check = await this.validate(sessionKey);
                if (check.valid) result.push(sessionKey);
            }
            return result;
        } catch {
            return [];
        }
    }

    async quarantine(sessionKey, reason = 'integrity-failure') {
        const src = path.join(this.sessionsDir, sessionKey);
        const dst = path.join(this.sessionsDir, '_quarantine', `${sessionKey}.${Date.now()}`);
        try {
            await fs.mkdir(path.dirname(dst), { recursive: true });
            await fs.rename(src, dst);
            this.logger?.warn?.(`[SessionIntegrity] Quarantined ${sessionKey} (${reason})`);
        } catch (err) {
            this.logger?.error?.(`[SessionIntegrity] Quarantine failed ${sessionKey}: ${err.message}`);
        }
    }
}

module.exports = { SessionIntegrity };
