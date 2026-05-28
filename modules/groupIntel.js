// modules/groupIntel.js
const { escapeHTML } = require('../core/sanitizer');
const logger = require('../core/logger');

/**
 * Fetches and formats intelligence on all participating groups.
 * @param {Object} sock - The Baileys socket connection.
 * @returns {Promise<{chunks: string[], totalGroups: number}>}
 */
async function getGroupIntelReport(sock) {
    try {
        if (!sock || !sock.groupFetchAllParticipating) {
            return { chunks: ["⚠️ Socket offline or uninitialized."], totalGroups: 0 };
        }

        const groups = await sock.groupFetchAllParticipating();
        let report = "╔══════════════════╗\n     Ω GROUP INTEL\n╚══════════════════╝\n\n";
        let messageChunks = [];
        let totalGroups = 0;

        for (const jid in groups) {
            // 🧠 SaaS Fix: Inner try/catch. If one group is corrupted, skip it instead of crashing the whole loop.
            try {
                const group = groups[jid];
                const groupName = escapeHTML(group.subject || 'Unknown Group');
                const memberCount = group.participants?.length || 0;
                const admins = group.participants?.filter(p => p.admin)?.length || 0;
                
                const entry = `📌 <b>${groupName}</b>\n🆔 <code>${jid}</code>\n👥 Members: ${memberCount} | 🛡️ Admins: ${admins}\n\n`;
                
                // Telegram message limit is 4096 chars. We split at 3800 to be safe.
                if ((report.length + entry.length) > 3800) {
                    messageChunks.push(report);
                    report = ""; 
                }
                report += entry;
                totalGroups++;
            } catch (innerError) {
                logger.warn(`[GroupIntel] Failed to parse group ${jid}`);
            }
        }
        
        if (report.length > 0) messageChunks.push(report);
        return { chunks: messageChunks, totalGroups };

    } catch (e) {
        logger.error("Group Intel Fetch Failed:", e.message);
        return { chunks: ["⚠️ Failed to fetch group intelligence. The WhatsApp node may be syncing."], totalGroups: 0 };
    }
}

module.exports = { getGroupIntelReport };
