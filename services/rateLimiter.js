// services/rateLimiter.js
// Per-sender + per-group rate limiting — protects against spam
// Heavy/owner commands are exempt

const EXEMPT_CMDS = new Set([
    '.godcast', '.gcast', '.gstatus', '.ggstatus', '.updategstatus',
    '.setnewgcstatus', '.groupstatus', '.advanced_status', '.broadcast',
    '.acceptall', '.rejectall', '.accept', '.reject', '.stoprequest',
    '.tag', '.deleteall', '.song', '.img', '.img2', '.pic', '.video',
    '.menu', '.invitecard', '.join'
]);

class RateLimiter {
    constructor() {
        this._senderMap = new Map();
        this._groupMap  = new Map();
        setInterval(() => {
            const cutoff = Date.now() - 10000;
            for (const [k, v] of this._senderMap) {
                const f = v.filter(t => t > cutoff);
                if (!f.length) this._senderMap.delete(k); else this._senderMap.set(k, f);
            }
            for (const [k, v] of this._groupMap) {
                const f = v.filter(t => t > cutoff);
                if (!f.length) this._groupMap.delete(k); else this._groupMap.set(k, f);
            }
        }, 30000).unref();
    }

    async check(sender, groupId, cmdName) {
        // Exempt heavy/owner commands from rate limiting entirely
        if (cmdName && EXEMPT_CMDS.has(cmdName)) return true;

        const now    = Date.now();
        const window = 5000;

        // Per-sender: max 8 commands per 5s
        const senderTimes = (this._senderMap.get(sender) || []).filter(t => now - t < window);
        if (senderTimes.length >= 8) return false;
        senderTimes.push(now);
        this._senderMap.set(sender, senderTimes);

        // Per-group: max 50 commands per 5s
        if (groupId) {
            const groupTimes = (this._groupMap.get(groupId) || []).filter(t => now - t < window);
            if (groupTimes.length >= 50) return false;
            groupTimes.push(now);
            this._groupMap.set(groupId, groupTimes);
        }

        return true;
    }
}
module.exports = new RateLimiter();
