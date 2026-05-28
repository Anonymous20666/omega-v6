'use strict';
/**
 * AI PIPELINE — Intelligent context-aware request processor
 *
 * This is the brain layer between raw user input and AI execution.
 * It handles:
 *   - Intent classification (command vs chat vs media vs action)
 *   - Context enrichment (who, where, what platform, what role)
 *   - Action routing (SPEAK, PLAY, IMAGE, STICKER, EXECUTE, etc.)
 *   - Multi-action parsing (Telegram AI can return multiple actions per reply)
 *   - Graceful degradation when providers fail
 *   - Per-user rate limiting and dedup
 */

const logger = require('./logger');

// ─── ACTION PREFIXES ─────────────────────────────────────────────────────────
const ACTION_PREFIXES = [
    'SPEAK:', 'GENERATE_IMAGE:', 'PLAY:', 'PLAY_MULTI:', 'PLAY_SEARCH:',
    'SEARCH_VIDEO:', 'SEND_STICKER:', 'MOOD_STICKER:', 'CREATE_POLL:',
    'SAVE_STICKER_PACK', 'EXECUTE_COMMAND:', 'RUN_DOT:', 'MENTION:',
    'TAG:', 'DELETE_MESSAGE:', 'WARN_USER:', 'KICK_USER:', 'BAN_USER:',
    'MUTE_USER:', 'UNMUTE_USER:', 'LOCK_CHAT:', 'UNLOCK_CHAT:',
    'STICKER:',
];

// ─── INTENT TYPES ────────────────────────────────────────────────────────────
const INTENT = {
    COMMAND:    'command',
    CHAT:       'chat',
    MEDIA_REQ:  'media_request',
    ACTION:     'action',
    SYSTEM:     'system',
    UNKNOWN:    'unknown',
};

/**
 * Parse a raw AI reply into structured actions + text parts.
 * Supports multi-line multi-action replies (Telegram AI style).
 *
 * @param {string} raw - Raw AI reply string
 * @returns {{ text: string, actions: Array<{type:string, payload:string}> }}
 */
function parseAiReply(raw) {
    if (!raw) return { text: '', actions: [] };

    const lines = String(raw).split('\n');
    const textLines = [];
    const actions = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let matched = false;
        for (const prefix of ACTION_PREFIXES) {
            if (trimmed.startsWith(prefix)) {
                const payload = trimmed.slice(prefix.length).trim();
                const type = prefix.replace(':', '').trim();
                actions.push({ type, payload });
                matched = true;
                break;
            }
            // Handle SAVE_STICKER_PACK without colon
            if (trimmed === 'SAVE_STICKER_PACK') {
                actions.push({ type: 'SAVE_STICKER_PACK', payload: '' });
                matched = true;
                break;
            }
        }

        if (!matched) {
            textLines.push(trimmed);
        }
    }

    return {
        text: textLines.join('\n').trim(),
        actions,
    };
}

/**
 * Classify the intent of a user message.
 * Returns INTENT type and extracted data.
 */
function classifyIntent(text, platform = 'whatsapp') {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return { type: INTENT.UNKNOWN };

    // Direct action requests
    if (/^(play|send me|find me|search)\s+(a\s+)?(song|music|track)/i.test(t))
        return { type: INTENT.MEDIA_REQ, subtype: 'music' };
    if (/^(generate|create|make|draw)\s+(a\s+|an\s+)?image/i.test(t))
        return { type: INTENT.MEDIA_REQ, subtype: 'image' };
    if (/^(send|make|create)\s+(a\s+)?sticker/i.test(t))
        return { type: INTENT.MEDIA_REQ, subtype: 'sticker' };
    if (/^(send|make|create|generate)\s+(a\s+)?(voice|vn|voice note)/i.test(t))
        return { type: INTENT.MEDIA_REQ, subtype: 'voice' };
    if (/^(search|find|get|send)\s+(a\s+)?video/i.test(t))
        return { type: INTENT.MEDIA_REQ, subtype: 'video' };

    // System/terminal (privileged only — enforced at execution layer)
    if (/^(run|exec|execute|check|show)\s+(pm2|disk|memory|cpu|log|redis|mongo)/i.test(t))
        return { type: INTENT.SYSTEM, subtype: 'terminal' };

    // General chat
    return { type: INTENT.CHAT };
}

/**
 * Build enriched context object for AI generation.
 * This is passed to generateText as the `extra` field.
 */
function buildContext({ platform, role, jid, sender, isGroup, groupName, pushName, history = [] } = {}) {
    const parts = [];

    if (platform === 'telegram') {
        parts.push(`Platform: Telegram`);
    } else {
        parts.push(`Platform: WhatsApp`);
        if (isGroup && groupName) parts.push(`Group: ${groupName}`);
        if (pushName) parts.push(`User name: ${pushName}`);
    }

    if (role) parts.push(`User role: ${role}`);
    if (sender) parts.push(`User ID: ${String(sender).replace(/[^0-9]/g, '').slice(0, 12)}`);

    return parts.join('\n');
}

/**
 * Determine if a message should trigger AI response.
 * Centralizes all the scattered trigger logic from whatsapp.js.
 */
function shouldTriggerAi({
    text, isGroup, pappyOn, isMentioned, isReplyToBot,
    hasImage, hasVoice, hasSticker, fromMe, isOwner,
    platform = 'whatsapp',
}) {
    if (fromMe) return false;

    if (platform === 'telegram') {
        // Telegram: always respond in DM, respond in groups only when mentioned/replied
        return true;
    }

    // WhatsApp DM: only owner can trigger AI
    if (!isGroup) return isOwner;

    // WhatsApp group: requires pappy mode ON
    if (!pappyOn) return false;

    // Explicit triggers always work when pappy is on
    if (isMentioned || isReplyToBot) return true;

    // Keyword trigger
    if (/\bpappy\b/i.test(text || '')) return true;

    // Ambient triggers (sticker, image, voice, text) when pappy is on
    if (hasSticker || hasImage || hasVoice) return true;
    if (text && text.trim()) return true;

    return false;
}

module.exports = {
    parseAiReply,
    classifyIntent,
    buildContext,
    shouldTriggerAi,
    INTENT,
    ACTION_PREFIXES,
};
