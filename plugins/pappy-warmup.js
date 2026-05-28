// plugins/pappy-warmup.js
'use strict';

const fs   = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('gifted-baileys');
const { broadcastQueue } = require('../core/bullEngine');
const logger = require('../core/logger');

const CONFIG_FILE = path.join(__dirname, '../data/warmup-config.json');

function getScopedConfigPath(botId) {
    const n = String(botId || '').replace(/[^0-9]/g, '');
    return n ? path.join(__dirname, `../data/warmup-config-${n}.json`) : CONFIG_FILE;
}

function getScopedMediaPath(botId, ext) {
    const n = String(botId || '').replace(/[^0-9]/g, '');
    return n
        ? path.join(__dirname, `../data/warmup-media-${n}.${ext}`)
        : path.join(__dirname, `../data/warmup-media.${ext}`);
}

function loadConfig(botId) {
    const p = getScopedConfigPath(botId);
    // Load node-specific config if it exists and has a payload
    if (fs.existsSync(p)) {
        try {
            const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
            if (cfg.statusPayload || cfg.mediaType) return cfg;
        } catch {}
    }
    // Fall back to global default config (applies to ALL nodes)
    if (fs.existsSync(CONFIG_FILE)) {
        try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch {}
    }
    return { statusPayload: null, mediaType: null, sourceMessage: null };
}

function saveConfig(botId, data) {
    const p = getScopedConfigPath(botId);
    if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

module.exports = {
    category: 'STEALTH',
    commands: [
        { cmd: '.setnewgcstatus', role: 'admin' },
        { cmd: '.checkgcstatus',  role: 'admin' },
        { cmd: '.delgcstatus',    role: 'admin' },
    ],

    init(sock) {
        const botId = sock.user?.id?.split(':')[0];
        if (!botId) return;
        const fullBotJid = `${botId}@s.whatsapp.net`;

        sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
            if (action === 'add' && participants.includes(fullBotJid)) triggerWarmup(id, botId);
        });
        sock.ev.on('groups.upsert', async (groups) => {
            for (const g of groups) triggerWarmup(g.id, botId);
        });
    },

    execute: async ({ sock, msg, args, text, user, botId }) => {
        const chat = msg.key.remoteJid;
        const cmd  = text.trim().split(' ')[0].toLowerCase();
        const config = loadConfig(botId);

        if (cmd === '.setnewgcstatus') {
            await sock.sendMessage(chat, { text: '⚙️ Securing your new God-Mode entry drop...' });

            let textContent  = args.join(' ').trim();
            let mediaType    = null;
            let sourceMessage = null;

            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

            // ── Media (image/video) ───────────────────────────────────────────
            let mediaMsg = msg.message?.imageMessage || msg.message?.videoMessage
                || quotedMsg?.imageMessage || quotedMsg?.videoMessage;

            if (mediaMsg) {
                try {
                    mediaType = mediaMsg.mimetype?.startsWith('image/') ? 'image' : 'video';
                    const stream = await downloadContentFromMessage(mediaMsg, mediaType);
                    let buf = Buffer.from([]);
                    for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
                    const ext = mediaType === 'image' ? 'jpg' : 'mp4';
                    fs.writeFileSync(getScopedMediaPath(botId, ext), buf);
                    if (!textContent) {
                        textContent = mediaMsg.caption || quotedMsg?.imageMessage?.caption
                            || quotedMsg?.videoMessage?.caption || '';
                    }
                } catch (err) {
                    return sock.sendMessage(chat, { text: `❌ Media Save Error: ${err.message}` });
                }
            }

            // ── Text / link preview ───────────────────────────────────────────
            if (!mediaType) {
                if (quotedMsg?.extendedTextMessage) {
                    // Save the full extendedTextMessage so triggerWarmup can relay it exactly
                    sourceMessage = { extendedTextMessage: quotedMsg.extendedTextMessage };
                    if (!textContent) textContent = quotedMsg.extendedTextMessage.text || '';
                } else if (quotedMsg?.conversation) {
                    sourceMessage = { conversation: quotedMsg.conversation };
                    if (!textContent) textContent = quotedMsg.conversation;
                } else if (textContent) {
                    sourceMessage = { conversation: textContent };
                }
            }

            if (!textContent && !mediaType) {
                return sock.sendMessage(chat, {
                    text: '❌ *Usage:* Reply to a message/image/video with `.setnewgcstatus` or add text after the command'
                });
            }

            config.statusPayload = textContent;
            config.mediaType     = mediaType;
            config.sourceMessage = sourceMessage;
            saveConfig(botId, config);

            const typeMsg = mediaType ? (mediaType === 'image' ? '🖼️ Image' : '🎥 Video') : '📝 Text/Link';
            return sock.sendMessage(chat, {
                text: `✅ *God Mode Drop Secured!*\n\n*Type:* ${typeMsg}\n*Caption:* ${textContent || 'None'}\n\n_Will post to group status when bot joins a new group._`
            });
        }

        if (cmd === '.checkgcstatus') {
            if (!config.statusPayload && !config.mediaType) {
                return sock.sendMessage(chat, { text: 'ℹ️ No God Mode entry set.' });
            }
            const typeMsg = config.mediaType ? (config.mediaType === 'image' ? '🖼️ Image' : '🎥 Video') : '📝 Text/Link';
            return sock.sendMessage(chat, {
                text: `👑 *Current Entry Drop:*\n\n*Type:* ${typeMsg}\n*Text:* "${config.statusPayload || 'None'}"`
            });
        }

        if (cmd === '.delgcstatus') {
            config.statusPayload  = null;
            config.mediaType      = null;
            config.sourceMessage  = null;
            saveConfig(botId, config);
            return sock.sendMessage(chat, { text: '🗑️ *Entry Drop Cleared.*' });
        }
    }
};

// ─── Warmup trigger ───────────────────────────────────────────────────────────
async function triggerWarmup(groupId, botId) {
    // Always use loadConfig so global default applies to all nodes
    const config = loadConfig(botId);

    if (!config.statusPayload && !config.mediaType) return;

    logger.info(`🔥 [WARMUP] Queuing status for: ${groupId}`);

    let mediaPath = null;
    let isVideo   = false;

    if (config.mediaType) {
        const ext       = config.mediaType === 'image' ? 'jpg' : 'mp4';
        const checkPath = getScopedMediaPath(botId, ext);
        if (fs.existsSync(checkPath)) { mediaPath = checkPath; isVideo = config.mediaType === 'video'; }
    }

    // Use saved sourceMessage (has full extendedTextMessage with link preview)
    // Falls back to Redis cache, then plain conversation
    let sourceMessage = config.sourceMessage || null;

    if (!mediaPath && !sourceMessage && config.statusPayload) {
        const urlMatch = (config.statusPayload.match(/https?:\/\/[^\s]+/) || []);
        if (urlMatch[0]) {
            // Build extendedTextMessage with link preview so WA renders the preview card
            sourceMessage = {
                extendedTextMessage: {
                    text: config.statusPayload,
                    matchedText: urlMatch[0],
                    canonicalUrl: urlMatch[0],
                    previewType: 0,
                }
            };
            // Try Redis cache for richer preview
            try {
                const { connection: redis } = require('../services/redis');
                const raw = await redis.get(`ext:${urlMatch[0].slice(0, 200)}`);
                if (raw) {
                    const cached = JSON.parse(raw);
                    sourceMessage = { extendedTextMessage: { ...sourceMessage.extendedTextMessage, ...cached } };
                }
            } catch {}
        } else {
            sourceMessage = { conversation: String(config.statusPayload) };
        }
    }

    broadcastQueue.add(`WARMUP_${botId}_${groupId}`, {
        botId,
        targetJid:    groupId,
        textContent:  config.statusPayload || '',
        mode:         'advanced_status',
        commandType:  'setnewgcstatus',
        font:         3,
        backgroundColor: '#FFB7C5',
        mediaPath,
        isVideo,
        sourceMessage,
        sourceContextInfo: null,
        useGhostProtocol: true,
    }, { priority: 1, removeOnComplete: true, removeOnFail: 1000 });
}
