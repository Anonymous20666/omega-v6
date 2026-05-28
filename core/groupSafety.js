'use strict';

const runtimeFlags = require('./runtimeFlags');

const ALLOWED_GROUP_META_COMMANDS = new Set([
    '.mute',
    '.unmute',
    '.setname',
    '.setdesc',
    '.setgrppfp',
]);

const META_COOLDOWN_MS = Math.max(3000, Number(process.env.GROUP_META_COOLDOWN_MS || 12000));

if (!global._groupMetaGuardState) {
    global._groupMetaGuardState = new Map();
}

function guardGroupMetadataMutation({ jid, command, action }) {
    if (!runtimeFlags.groupMetadataGuard) return { ok: true, reason: 'disabled' };

    const groupJid = String(jid || '');
    if (!groupJid.endsWith('@g.us')) {
        return { ok: false, reason: 'not-group' };
    }

    const normalizedCmd = String(command || '').trim().toLowerCase();
    if (!ALLOWED_GROUP_META_COMMANDS.has(normalizedCmd)) {
        return { ok: false, reason: `command-not-allowed:${normalizedCmd || 'unknown'}` };
    }

    const key = `${groupJid}:${String(action || 'meta')}`;
    const now = Date.now();
    const last = Number(global._groupMetaGuardState.get(key) || 0);
    if (now - last < META_COOLDOWN_MS) {
        return {
            ok: false,
            reason: 'cooldown',
            waitMs: META_COOLDOWN_MS - (now - last),
        };
    }

    global._groupMetaGuardState.set(key, now);
    return { ok: true, reason: 'allowed' };
}

module.exports = {
    guardGroupMetadataMutation,
};
