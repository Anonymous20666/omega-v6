// modules/permission.js
const { ownerWhatsAppJids } = require('../config')
const ownerManager = require('./ownerManager');

const STATIC_OWNER_SET = new Set((ownerWhatsAppJids || []).map((j) => String(j || '').trim()).filter(Boolean));

function normalizeJid(jid) {
    return String(jid || '').trim().replace(/:\d+(?=@)/g, '');
}

function extractDigits(jid) {
    return normalizeJid(jid).replace(/[^0-9]/g, '');
}

function isOwnerFromAnySource(sender) {
    const raw = String(sender || '').trim();
    if (!raw) return false;
    const norm = normalizeJid(raw);
    const digits = extractDigits(raw);
    const staticDigits = new Set(Array.from(STATIC_OWNER_SET).map(extractDigits).filter(Boolean));

    if (STATIC_OWNER_SET.has(raw) || STATIC_OWNER_SET.has(norm) || staticDigits.has(digits)) {
        return true;
    }

    return ownerManager.isOwner(raw) || ownerManager.isOwner(norm) || ownerManager.isOwner(digits);
}

/**
 * Determines the role of a user based on their JID and group context.
 * @param {Object} msg - The Baileys message object.
 * @param {boolean} [isGroupAdmin=false] - Whether the user is an admin in the current group.
 * @returns {string} The assigned role ('owner', 'admin', or 'public').
 */
function getUserRole(msg, isGroupAdmin = false) {
    try {
        if (!msg || !msg.key) return 'public';

        // Extract the exact ID of the sender safely
        const sender = msg.key.fromMe 
            ? msg.key.remoteJid 
            : (msg.key.participant || msg.key.remoteJid);

        if (!sender) return 'public';

        // 1. Check if the sender is an Owner (static env + dynamic owner registry)
        if (isOwnerFromAnySource(sender)) return 'owner';

        // 2. Check if the sender is an Admin in a group
        if (isGroupAdmin) {
            return 'admin';
        }

        // 3. Otherwise, they are a normal public user
        return 'public';
    } catch (error) {
        // 🧠 SaaS Fix: If the message payload is weird, default to lowest permission
        return 'public'; 
    }
}

module.exports = { getUserRole }
