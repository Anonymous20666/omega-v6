// plugins/pappy-groupstatus.js
const { downloadMediaMessage } = require('gifted-baileys');
const { broadcastQueue } = require('../core/bullEngine');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../core/logger');
const ghostMode = require('../core/ghostMode');
const { getGroups } = require('../core/statusManager');

const TEMP_DIR = path.join(__dirname, '../data/temp_media');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const BG_COLORS = {
    // Original
    black:   '#000000',
    blue:    '#1A73E8',
    red:     '#E53935',
    purple:  '#7B1FA2',
    pink:    '#FFB7C5',
    // New
    white:   '#FFFFFF',
    green:   '#00C853',
    teal:    '#00897B',
    orange:  '#FF6D00',
    yellow:  '#FFD600',
    navy:    '#0D1B2A',
    rose:    '#FF4081',
    indigo:  '#3949AB',
    lime:    '#76FF03',
    cyan:    '#00E5FF',
    gold:    '#FFB300',
    maroon:  '#880E4F',
    forest:  '#1B5E20',
    slate:   '#37474F',
    violet:  '#6200EA',
    coral:   '#FF6E40',
    mint:    '#A7FFEB',
    wine:    '#7B1829',
    sky:     '#29B6F6',
    peach:   '#FFAB91',
};

// Auto-rotation palette used when color=auto
const COLOR_ROTATION = [
    '#1A73E8', '#E53935', '#7B1FA2', '#00C853', '#FF6D00',
    '#FFD600', '#00897B', '#FF4081', '#3949AB', '#FF6E40',
    '#29B6F6', '#6200EA', '#00E5FF', '#FFB300', '#76FF03',
    '#880E4F', '#1B5E20', '#0D1B2A', '#FF4081', '#00C853',
];

let _colorRotationIndex = 0;
function nextRotationColor() {
    const color = COLOR_ROTATION[_colorRotationIndex % COLOR_ROTATION.length];
    _colorRotationIndex++;
    return color;
}
const FONTS = { sans: 0, serif: 1, mono: 2, bold: 4 };
const DEFAULT_GS_CONFIG = { backgroundColor: BG_COLORS.green, font: FONTS.sans, repeat: 1 };
const gsConfigByScope = new Map();

const GS_CONFIG_FILE = path.join(__dirname, '../data/gs-config.json');

function _loadGsConfig() {
    try {
        if (!fs.existsSync(GS_CONFIG_FILE)) return;
        const saved = JSON.parse(fs.readFileSync(GS_CONFIG_FILE, 'utf8'));
        for (const [k, v] of Object.entries(saved || {})) {
            gsConfigByScope.set(k, { ...DEFAULT_GS_CONFIG, ...v });
        }
    } catch {}
}

function _saveGsConfig() {
    try {
        const obj = {};
        for (const [k, v] of gsConfigByScope.entries()) obj[k] = v;
        fs.writeFileSync(GS_CONFIG_FILE, JSON.stringify(obj, null, 2));
    } catch {}
}

_loadGsConfig();

function resolveScopeKey(scope) {
    const key = String(scope || '').trim();
    return key || 'global';
}

function getScopedGsConfig(scope) {
    const key = resolveScopeKey(scope);
    if (gsConfigByScope.has(key)) return gsConfigByScope.get(key);
    // Fallback: sessionKey format is chatId_phoneNumber_slotId
    // botId is the phone number (middle segment) — match any sessionKey containing it
    for (const [k, v] of gsConfigByScope.entries()) {
        const parts = k.split('_');
        if (parts.includes(key) || k === key) return v;
    }
    const cfg = { ...DEFAULT_GS_CONFIG };
    gsConfigByScope.set(key, cfg);
    return cfg;
}

function setScopedGsConfig(scope, patch) {
    const cfg = getScopedGsConfig(scope);
    Object.assign(cfg, patch || {});
    // Ensure it's stored under the exact scope key
    const key = resolveScopeKey(scope);
    gsConfigByScope.set(key, cfg);
    _saveGsConfig();
    return cfg;
}
const yieldLoop = () => new Promise(resolve => setImmediate(resolve));
const QUEUE_CHUNK_SIZE = 100; // reduced from 300 to avoid Redis overload
const STATUS_JOB_ATTEMPTS = Math.max(1, Number(process.env.STATUS_JOB_ATTEMPTS || 8));
const STATUS_JOB_BACKOFF_MS = Math.max(1500, Number(process.env.STATUS_JOB_BACKOFF_MS || 12000));

async function resolveTargetJids(sock, chat, commandName) {
    if (commandName === '.ggstatus') {
        return getGroups(sock);
    }

    if (/@g\.us$/i.test(String(chat || ''))) {
        return [chat];
    }

    return getGroups(sock);
}

async function enqueueStatusJobs({ targetJids, amount, botId, textContent, mediaPath, isVideo, relaySourceMessage, relaySourceContextInfo, gsConfig, commandType }) {
    const shouldUseGhost = ghostMode.shouldUseGhost(targetJids.length);
    const useRotation = gsConfig.backgroundColor === 'auto';
    let totalJobs = 0;
    let chunk = [];

    for (let i = 0; i < amount; i++) {
        for (const jid of targetJids) {
            // Per-group OR per-post color rotation when set to auto
            const bgColor = useRotation ? nextRotationColor() : gsConfig.backgroundColor;
            chunk.push({
                name: `GS_${botId}_${jid}_${i}`,
                data: {
                    botId,
                    targetJid: jid,
                    mode: 'advanced_status',
                    commandType: commandType || 'groupstatus',
                    textContent,
                    font: gsConfig.font,
                    backgroundColor: bgColor,
                    useGhostProtocol: shouldUseGhost,
                    mediaPath,
                    isVideo,
                    sourceMessage: !mediaPath ? relaySourceMessage : null,
                    sourceContextInfo: !mediaPath ? relaySourceContextInfo : null
                },
                opts: {
                    removeOnComplete: true,
                    removeOnFail: 1000,
                    priority: 2,
                    // Keep retries inside worker logic for strict per-group completion ordering.
                    attempts: 1,
                    backoff: { type: 'exponential', delay: STATUS_JOB_BACKOFF_MS },
                }
            });
            totalJobs++;

            if (chunk.length >= QUEUE_CHUNK_SIZE) {
                await broadcastQueue.addBulk(chunk);
                chunk = [];
                await yieldLoop();
            }
        }
    }

    if (chunk.length) {
        await broadcastQueue.addBulk(chunk);
    }

    return { totalJobs, shouldUseGhost };
}

function extractRelaySourceMessage(quotedMsg) {
    if (!quotedMsg || typeof quotedMsg !== 'object') return null;
    if (quotedMsg.ephemeralMessage?.message) return extractRelaySourceMessage(quotedMsg.ephemeralMessage.message);
    if (quotedMsg.viewOnceMessage?.message)  return extractRelaySourceMessage(quotedMsg.viewOnceMessage.message);

    // extendedTextMessage first — it carries the full link preview (title, description, jpegThumbnail)
    if (quotedMsg.extendedTextMessage) return { extendedTextMessage: quotedMsg.extendedTextMessage };
    if (quotedMsg.groupInviteMessage)  return { groupInviteMessage: quotedMsg.groupInviteMessage };
    if (quotedMsg.conversation)        return { conversation: quotedMsg.conversation };

    return null;
}

function extractRelaySourceContextInfo(msg) {
    // Pull contextInfo from the quoted message itself (nested link preview data)
    const ctx = msg?.message?.extendedTextMessage?.contextInfo || null;
    if (!ctx) return null;
    const qm = ctx.quotedMessage || {};
    // Return the contextInfo nested inside the quoted message if it has externalAdReply
    return (
        qm?.extendedTextMessage?.contextInfo ||
        qm?.imageMessage?.contextInfo ||
        qm?.videoMessage?.contextInfo ||
        null
    );
}

module.exports = {
    category: 'STATUS',
    commands: [
        { cmd: '.updategstatus', role: 'admin' },
        { cmd: '.updatgstatus', role: 'admin' },
        { cmd: '.gstatus', role: 'owner' },
        { cmd: '.ggstatus', role: 'owner' }
    ],
    getGsConfig: (scope) => getScopedGsConfig(scope),
    setGsConfig: (scope, p) => {
        if (typeof scope === 'object' && p === undefined) {
            return setScopedGsConfig('global', scope);
        }
        return setScopedGsConfig(scope, p);
    },
    BG_COLORS, FONTS,

    execute: async ({ sock, msg, args, text, user, botId }) => {
        try {
            const gsConfig = getScopedGsConfig(botId);
            const chat = msg.key.remoteJid;
            // Normalize: handle ". updategstatus" (space after dot) from mobile autocorrect
            const rawText = String(text || '').replace(/^\.\ +/, '.').trim();
            let commandName = rawText.split(' ')[0].toLowerCase();
            // Common typo alias support
            if (commandName === '.updatgstatus') commandName = '.updategstatus';
            const cleanArgs = rawText.slice(commandName.length).trim().split(/\s+/).filter(Boolean);

            if (commandName === '.ggstatus') {
                await sock.sendMessage(chat, { text: '⏳ *Scanning groups and preparing ghost-status queue...*' }).catch(() => {});
            }

            let targetJids = [];
            let amount = gsConfig.repeat;
            let textContent = '';

            const currentMessageExtended = msg.message?.extendedTextMessage;
            const currentMessageContextInfo = currentMessageExtended?.contextInfo;
            const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const quotedText = quotedMessage?.conversation || quotedMessage?.extendedTextMessage?.text || '';

            let relaySourceMessage = null;
            let relaySourceContextInfo = null;

            const hasCurrentPreview = currentMessageContextInfo?.externalAdReply || currentMessageExtended?.matchedText;

            if (hasCurrentPreview) {
                logger.info('[GroupStatus] Using preview from current message');
                relaySourceMessage = { extendedTextMessage: currentMessageExtended };
                relaySourceContextInfo = currentMessageContextInfo;
            } else if (quotedMessage) {
                logger.info('[GroupStatus] Using preview from quoted message');
                relaySourceMessage = extractRelaySourceMessage(quotedMessage);
                relaySourceContextInfo = extractRelaySourceContextInfo(msg);
            }

            // Support for custom aesthetic message (your provided template)
            if (commandName === '.setnewgcstatus') {
                textContent = cleanArgs.join(' ') || quotedText;
                // Example: force preview if link present
                if (textContent.includes('http')) {
                    relaySourceMessage = relaySourceMessage || { extendedTextMessage: { text: textContent } };
                }
            }

            if (commandName === '.gstatus') {
                amount = parseInt(cleanArgs[0]) || 1;
                targetJids = [cleanArgs[1]];
                textContent = cleanArgs.slice(2).join(' ') || quotedText;
            } else if (commandName === '.ggstatus') {
                amount = parseInt(cleanArgs[0]) || 1;
                textContent = cleanArgs.slice(1).join(' ') || quotedText;
                try {
                    targetJids = await resolveTargetJids(sock, chat, commandName);
                } catch (err) { return sock.sendMessage(chat, { text: `❌ Failed to fetch groups: ${err.message}` }); }
            } else {
                textContent = cleanArgs.join(' ') || quotedText;
                try {
                    targetJids = await resolveTargetJids(sock, chat, commandName);
                } catch (err) {
                    return sock.sendMessage(chat, { text: `❌ Failed to fetch groups: ${err.message}` });
                }
            }

            targetJids = (targetJids || []).filter(Boolean);
            if (!Array.isArray(targetJids) || targetJids.length === 0) {
                return sock.sendMessage(chat, {
                    text: '⚠️ No target groups found for this status command right now.'
                });
            }

            let mediaPath = null;
            let isVideo = false;
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const hasMedia = quotedMsg?.imageMessage || quotedMsg?.videoMessage;

            if (hasMedia) {
                try {
                    const ext = quotedMsg.videoMessage ? '.mp4' : '.jpg';
                    isVideo = !!quotedMsg.videoMessage;
                    mediaPath = path.join(TEMP_DIR, `GS_${crypto.randomBytes(4).toString('hex')}${ext}`);
                    const buffer = await downloadMediaMessage({ key: msg.key, message: quotedMsg }, 'buffer', { }, { logger: null, reuploadRequest: sock.updateMediaMessage });
                    await fs.promises.writeFile(mediaPath, buffer);
                } catch (mediaErr) { mediaPath = null; }
            }

            if (!textContent && !mediaPath) {
                // Try to get text from relaySourceMessage if available
                textContent = relaySourceMessage?.extendedTextMessage?.text
                    || relaySourceMessage?.extendedTextMessage?.matchedText
                    || '🔱';
            }

            let queueResult = { totalJobs: 0, shouldUseGhost: false };
            try {
                queueResult = await enqueueStatusJobs({
                    targetJids,
                    amount,
                    botId,
                    textContent,
                    mediaPath,
                    isVideo,
                    relaySourceMessage,
                    relaySourceContextInfo,
                    gsConfig,
                    commandType: commandName.replace(/^\./, '') || 'groupstatus'
                });
            } catch (err) {
                logger.error(err.message);
                return sock.sendMessage(chat, { text: `❌ Failed to queue group status: ${err.message}` });
            }

            await sock.sendMessage(chat, {
                text: `✅ *Status Queue Engaged*\nQueued ${queueResult.totalJobs} job(s) with Ghost Protocol ${ghostMode.describeMode(targetJids.length)}.\nYou can monitor completion from queue logs.`
            });
        } catch (err) {
            logger.error(`[GroupStatus] Fatal error: ${err.message}`);
            await sock.sendMessage(msg.key.remoteJid, { text: `❌ Group status failed: ${err.message}` });
        }
    }
};
