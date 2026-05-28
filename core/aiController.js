// core/aiController.js
'use strict';

const { exec } = require('child_process');
const util = require('util');
const ai = require('./ai');
const logger = require('./logger');
const { ownerWhatsAppJids } = require('../config');

const execAsync = util.promisify(exec);
const IMAGE_ACTION_KEYWORDS = /(?:generate|create|draw|design|illustrate|image|picture|photo|art|visual)/i;
const PLAY_ACTION_KEYWORDS = /(?:play|song|music|track|listen to|spotify|youtube)/i;
const VOICE_ACTION_KEYWORDS = /(?:voice note|send vn|voice message|voice note|speak|audio)/i;
const STICKER_ACTION_KEYWORDS = /(?:sticker|stickify|stickerize|make.*sticker|convert.*sticker)/i;
const SHELL_WHITELIST = [
    /^echo\b/i,
    /^pwd\b/i,
    /^ls\b/i,
    /^date\b/i,
    /^uptime\b/i,
    /^whoami\b/i,
    /^df\b/i,
    /^free\b/i,
    /^uname\b/i,
    /^cat\s+\/proc\/(uptime|meminfo|cpuinfo|loadavg)\b/i,
];

function normalizeText(text) {
    return String(text || '').trim();
}

function isOwnerSender(sender, msg) {
    if (msg?.key?.fromMe) return true;
    const normalized = String(sender || '').replace(/[^0-9]/g, '');
    if (!normalized) return false;
    return ownerWhatsAppJids.some((jid) => String(jid || '').replace(/[^0-9]/g, '') === normalized);
}

function isShellAllowed(command) {
    const trimmed = String(command || '').trim();
    return SHELL_WHITELIST.some((pattern) => pattern.test(trimmed));
}

function buildAiPrompt({ text, hasSticker, hasImage, hasVoice, isGroup, platform = 'whatsapp' }) {
    const base = normalizeText(text);
    const contextChunks = [];
    if (hasSticker) contextChunks.push('The user sent a sticker and expects a sticker-style response.');
    if (hasImage) contextChunks.push('The user shared an image and wants a response about it.');
    if (hasVoice) contextChunks.push('The user attached a voice note.');
    if (isGroup) contextChunks.push('This is a group chat, be concise and avoid flooding.');
    if (base) contextChunks.push(`User message: ${base}`);
    return contextChunks.join(' ');
}

function detectIntent({ text, hasSticker, hasImage, hasVoice }) {
    const normalized = normalizeText(text).toLowerCase();
    if (hasVoice || VOICE_ACTION_KEYWORDS.test(normalized)) return 'voice';
    if (hasSticker || STICKER_ACTION_KEYWORDS.test(normalized)) return 'sticker';
    if (hasImage || IMAGE_ACTION_KEYWORDS.test(normalized)) return 'image';
    if (PLAY_ACTION_KEYWORDS.test(normalized) && normalized.length < 120) return 'play';
    return 'reply';
}

async function executeSafeShell(command) {
    const sanitized = normalizeText(command);
    if (!isShellAllowed(sanitized)) {
        throw new Error('Shell command denied by safety policy.');
    }
    const { stdout, stderr } = await execAsync(sanitized, {
        timeout: 20000,
        maxBuffer: 1024 * 1024,
    });
    return String(stdout || stderr || '').trim() || 'Command executed successfully.';
}

async function analyzeWhatsAppEvent({ sock, msg, jid, text, sender, hasSticker, hasImage, hasVoice, audioBuffer, isReplyToBot, isMentioned, isGroup, sessionKey }) {
    const prompt = buildAiPrompt({ text, hasSticker, hasImage, hasVoice, isGroup });
    const intent = detectIntent({ text, hasSticker, hasImage, hasVoice });
    const userId = sender || 'global';
    const owner = isOwnerSender(sender, msg);
    const response = { type: 'none' };
    const platform = 'whatsapp';

    if (hasSticker) {
        response.type = 'sticker';
        response.prompt = 'Create an expressive animated sticker in a dramatic anime style.';
        return response;
    }

    if (hasVoice) {
        response.type = 'voice';
        response.prompt = normalizeText(text) || 'Transcribe and reply naturally to this voice note.';
        if (audioBuffer) {
            response.audio = await ai.analyzeVoice(audioBuffer, userId).catch((err) => {
                logger.warn('[AI Controller] Voice analysis failed', { error: err.message });
                return null;
            });
        }
        if (!response.audio) {
            response.text = await ai.generateText(response.prompt, userId, { platform, role: owner ? 'OWNER' : 'USER', extra: 'Reply naturally to the voice note.' });
            response.type = 'reply';
        }
        return response;
    }

    if (hasImage) {
        if (STICKER_ACTION_KEYWORDS.test(text)) {
            response.type = 'sticker-from-image';
        } else if (IMAGE_ACTION_KEYWORDS.test(text)) {
            response.type = 'generate-image';
            response.prompt = normalizeText(text) || 'Create a cinematic AI art image.';
        } else {
            response.type = 'describe-image';
            response.prompt = normalizeText(text) || 'Describe this image and reply naturally.';
        }
        return response;
    }

    if (intent === 'play') {
        response.type = 'reply';
        response.text = `Sure, I hear you want music. Tell me the song or artist and I will fetch it.`;
        return response;
    }

    if (/^execute_command:/i.test(text) || /^run command:/i.test(text)) {
        const commandMatch = text.replace(/^execute_command:|^run command:/i, '').trim();
        if (!owner) {
            response.type = 'reply';
            response.text = 'Command execution is restricted to owners only.';
            return response;
        }
        if (!isShellAllowed(commandMatch)) {
            response.type = 'reply';
            response.text = 'I cannot run that command for safety reasons.';
            return response;
        }
        response.type = 'shell';
        response.command = commandMatch;
        return response;
    }

    response.type = 'reply';
    response.text = await ai.generateText(prompt, userId, { platform: 'whatsapp', role: owner ? 'OWNER' : 'USER', extra: isReplyToBot ? 'User explicitly addressed the bot.' : '' });
    return response;
}

module.exports = {
    analyzeWhatsAppEvent,
    detectIntent,
    buildAiPrompt,
    isOwnerSender,
    isShellAllowed,
    executeSafeShell,
};
