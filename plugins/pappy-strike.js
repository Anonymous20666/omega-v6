// plugins/pappy-strike.js
const { downloadMediaMessage } = require('gifted-baileys');
const taskManager = require('../core/taskManager');
const stealth = require('../core/stealthEngine');

module.exports = {
    category: 'STRIKE',
    commands: [
        { cmd: '.strike', role: 'owner' }, 
        { cmd: '.flashtag', role: 'owner' }, 
        { cmd: '.vanish', role: 'owner' }
    ],
    
    execute: async ({ sock, msg, args, text, user, botId }) => {
        const senderJid = msg.key.remoteJid;
        await sock.sendMessage(senderJid, { delete: msg.key }).catch(() => {});

        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
        const cmd = text.split(' ')[0].toLowerCase();

        if (cmd === '.flashtag') {
            const count = parseInt(args[0]) || 1;
            const textContent = args.slice(1).join(' ') || '⚡';
            if (!senderJid.endsWith('@g.us')) return;
            const meta = await require('../core/groupCache').getGroupMeta(sock, senderJid).catch(() => null);
            if (!meta) return;
            const participants = meta.participants.map(p => p.id);

            const getPayload = () => (quotedMsg && stanzaId) 
                ? { forward: { key: { remoteJid: senderJid, fromMe: false, id: stanzaId }, message: quotedMsg }, contextInfo: { mentionedJid: participants } }
                : { text: textContent, mentions: participants };

            taskManager.submit(`FLASH_${botId}_${Date.now()}`, async (abortSignal) => {
                for (let i = 0; i < count; i++) {
                    if (abortSignal.aborted) break;
                    await sock.sendMessage(senderJid, getPayload()).catch(() => {});
                    await new Promise(res => setTimeout(res, 100)); 
                }
            }, { priority: 4, timeout: 60000 });
        }

        if (cmd === '.strike') {
            const target = args[0];
            const count = parseInt(args[1]) || 1;
            const textContent = args.slice(2).join(' ');

            if (!target?.endsWith('@g.us') || isNaN(count)) return sock.sendMessage(senderJid, { text: "❌ .strike [targetJid] [count] [message or reply]" });

            // Base Payload
            let getMassPayload = () => ({ groupStatusMessage: { text: textContent || '🔱', font: 1, backgroundArgb: 0xFF000000 } });

            // RESTORED: Advanced Media Extraction
            if (quotedMsg) {
                const quotedType = Object.keys(quotedMsg)[0];
                if (['videoMessage', 'imageMessage'].includes(quotedType)) {
                    try {
                        const buffer = await downloadMediaMessage({ key: msg.key, message: quotedMsg }, 'buffer', {}, { logger: console });
                        getMassPayload = () => ({ groupStatusMessage: { [quotedType === 'videoMessage' ? 'video' : 'image']: buffer, caption: textContent || quotedMsg[quotedType].caption || '' } });
                    } catch (e) { console.error("Media download failed", e); }
                }
            }

            taskManager.submit(`STRIKE_${botId}_${Date.now()}`, async (abortSignal) => {
                for (let i = 0; i < count; i++) {
                    if (abortSignal.aborted) break;
                    const payload = getMassPayload();
                    
                    // Only apply Spintax to text payloads
                    if (payload.groupStatusMessage && payload.groupStatusMessage.text) {
                        payload.groupStatusMessage.text = stealth.mutateMessage(payload.groupStatusMessage.text);
                    } else if (payload.groupStatusMessage && payload.groupStatusMessage.caption) {
                        payload.groupStatusMessage.caption = stealth.mutateMessage(payload.groupStatusMessage.caption);
                    }

                    await sock.sendMessage(target, payload).catch(() => {});
                    await new Promise(res => setTimeout(res, 500 + Math.random() * 1000)); 
                }
                sock.sendMessage(senderJid, { text: `✅ *STRIKE COMPLETE:* Delivered ${count} payloads.` });
            }, { priority: 4 });
        }

        if (cmd === '.vanish') {
            const target = args[0];
            if (!target?.endsWith('@g.us')) return;
            const mutated = stealth.mutateMessage(args.slice(1).join(' ') || '💨');
            if (quotedMsg && stanzaId) {
                await sock.sendMessage(target, { forward: { key: { remoteJid: senderJid, fromMe: false, id: stanzaId }, message: quotedMsg } });
            } else {
                await stealth.simulateHumanInteraction(sock, target, mutated, null);
                await sock.sendMessage(target, { text: mutated });
            }
            await new Promise(res => setTimeout(res, 2000));
            await sock.groupLeave(target).catch(() => {});
            return sock.sendMessage(senderJid, { text: `💨 Dropped payload and vanished from ${target}` });
        }
    }
};
