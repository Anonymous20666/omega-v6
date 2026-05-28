// plugins/pappy-radar.js
// 📡 OMEGA RADAR: Telegram Intel Bridge (SaaS Edition)

const { ownerTelegramId } = require('../config');
const logger = require('../core/logger');
const eventBus = require('../core/eventBus');
const { isRadarEnabled, setRadarEnabled } = require('../core/radarControl');

// 🧠 SaaS Fix: Utility delay to prevent Telegram Rate Limits (429)
const delay = ms => new Promise(res => setTimeout(res, ms));

module.exports = {
    category: 'INTEL',
    commands: [
        { cmd: '.radars', role: 'owner' },
        { cmd: '.radar', role: 'owner' }
    ],
    
    init() {
        // Guard: only register the system.boot listener once
        if (eventBus.listenerCount('system.boot') > 0) return;

        eventBus.on('system.boot', async (sock) => {
            const botId = sock.user?.id?.split(':')[0] || 'Unknown Node';

            // 1. Initial Radar Dump on Boot — only once per botId per session
            setTimeout(async () => {
                if (!isRadarEnabled(botId)) {
                    logger.info(`[Radar] Boot dump skipped (disabled) for node +${botId}`);
                    return;
                }
                try {
                    const groups = await require('../core/groupCache').getAllGroups(sock);
                    const jids = Object.keys(groups);
                    if (jids.length === 0 || !global.tgBot) return;
                    
                    let tgMessage = `📡 <b>OMEGA BOOT: RADAR DUMP [+${botId}]</b>\n\nMonitoring <b>${jids.length}</b> sectors:\n\n`;
                    for (const jid of jids) {
                        tgMessage += `📁 <b>${groups[jid].subject || "Unknown"}</b>\n🆔 <code>${jid}</code>\n\n`;
                    }
                    
                    // Safe chunking with delays to prevent Telegram API bans
                    const chunks = tgMessage.match(/[\s\S]{1,4000}/g) || [];
                    for (const chunk of chunks) {
                        await global.tgBot.telegram.sendMessage(ownerTelegramId, chunk, { parse_mode: 'HTML' }).catch(()=>{});
                        await delay(1000); // 1-second delay between chunks
                    }
                } catch (e) {
                    logger.error(`[Radar] Boot scan failed for node +${botId}: ${e.message}`);
                }
            }, 8000);

            // 2. Real-time Territory Acquisition Listener
            // Safe to attach here because it's localized to this specific booted socket
            sock.ev.on('groups.upsert', async (newGroups) => {
                if (!isRadarEnabled(botId)) return;
                for (const group of newGroups) {
                    if (global.tgBot) {
                        global.tgBot.telegram.sendMessage(
                            ownerTelegramId, 
                            `🚨 <b>NEW TERRITORY ACQUIRED [+${botId}]</b> 🚨\n\n📁 <b>Name:</b> ${group.subject || "Unknown"}\n🆔 <b>JID:</b> <code>${group.id}</code>`, 
                            { parse_mode: 'HTML' }
                        ).catch(() => {});
                    }
                }
            });
        });
    },

    // 🧠 SaaS Fix: Updated signature to match the object destructuring in our Command Router
    execute: async ({ sock, msg, args, text, user, botId }) => {
        const chat = msg.key.remoteJid;
        const cmd = text.split(' ')[0].toLowerCase();
        const botNumber = sock.user?.id?.split(':')[0] || 'Unknown Node';

        logger.info(`[Radar] Command received: ${cmd}`);

        if (cmd === '.radars') {
            if (!isRadarEnabled(botNumber)) {
                return sock.sendMessage(chat, { text: '🟡 Radar is currently OFF for this node. Use *.radar on* to re-enable alerts.' });
            }
            logger.info(`[Radar] Executing .radars command`);
            await sock.sendMessage(chat, { 
                text: "📡 *SCANNING SECTORS...*\n_Transmitting data securely to your Telegram._" 
            });
            
            try {
                const groups = await require('../core/groupCache').getAllGroups(sock);
                const jids = Object.keys(groups);
                
                logger.info(`[Radar] Found ${jids.length} groups`);
                
                if (global.tgBot) {
                    let radarMsg = `📡 <b>OMEGA RADAR: MANUAL DUMP [+${botNumber}]</b>\n\nMonitoring <b>${jids.length}</b> sectors:\n\n`;
                    for (const jid of jids) {
                        radarMsg += `📁 <b>${groups[jid].subject || "Unknown"}</b>\n🆔 <code>${jid}</code>\n\n`;
                    }
                    
                    const chunks = radarMsg.match(/[\s\S]{1,4000}/g) || [];
                    for (const chunk of chunks) {
                        await global.tgBot.telegram.sendMessage(ownerTelegramId, chunk, { parse_mode: 'HTML' }).catch(()=>{});
                        await delay(1000);
                    }
                    await sock.sendMessage(chat, { text: "✅ Radar data transmitted to Telegram." });
                } else {
                    logger.warn(`[Radar] Telegram bot not available`);
                    return sock.sendMessage(chat, { text: "❌ Telegram Control Panel is currently offline." });
                }
            } catch (err) { 
                logger.error(`[Radar] Manual scan failed: ${err.message}`);
                return sock.sendMessage(chat, { text: "❌ Radar scan failed. Check logs." }); 
            }
        }

        if (cmd === '.radar') {
            const mode = String(args[0] || '').toLowerCase();

            if (!mode || mode === 'status') {
                const status = isRadarEnabled(botNumber) ? 'ON' : 'OFF';
                return sock.sendMessage(chat, {
                    text: `📡 Radar for +${botNumber} is *${status}*\n\nUse:\n• *.radar on*\n• *.radar off*\n• *.radar status*`
                });
            }

            if (mode !== 'on' && mode !== 'off') {
                return sock.sendMessage(chat, { text: '❌ Usage: *.radar on* | *.radar off* | *.radar status*' });
            }

            const enabled = mode === 'on';
            setRadarEnabled(botNumber, enabled);
            return sock.sendMessage(chat, { text: `✅ Radar set to *${enabled ? 'ON' : 'OFF'}* for +${botNumber}.` });
        }
    }
};
