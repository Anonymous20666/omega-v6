// config.js
/**
 * @fileoverview Centralized, immutable configuration for Ω OMEGA CORE.
 */

require('dotenv').config(); 

const GENERAL_OWNER_WA = '2348164167112@s.whatsapp.net';

function normalizeOwnerJid(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    const digits = raw.replace(/[^0-9]/g, '');
    if (!digits) return '';
    return `${digits}@s.whatsapp.net`;
}

function buildOwnerWaJids() {
    const fromEnv = String(process.env.OWNER_WA_JID || '')
        .split(',')
        .map((j) => normalizeOwnerJid(j))
        .filter(Boolean);

    const forcedOwners = [GENERAL_OWNER_WA];
    return Array.from(new Set([...fromEnv, ...forcedOwners]));
}

const config = {
    tgBotToken: process.env.TG_BOT_TOKEN,
    ownerTelegramId: process.env.OWNER_TG_ID,
    ownerWhatsAppJids: buildOwnerWaJids(),
    globalPrefix: '.',
    
    system: {
        taskTimeoutMs: 60000,
        maxQueueConcurrency: 50, // 👈 Uncapped to 50 for max speed
        watchdogTimeoutMs: 120000
    },

    // 🔴 Redis config with local-first sane defaults
    redis: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: (() => {
            const host = process.env.REDIS_HOST || '127.0.0.1';
            const localHost = host === '127.0.0.1' || host === 'localhost';
            const requireAuth = String(process.env.REDIS_REQUIRE_AUTH || '').toLowerCase() === 'true';
            if (localHost && !requireAuth) return undefined;
            return process.env.REDIS_PASSWORD || undefined;
        })()
    },
    
    // 🧠 OPENROUTER AI INJECTION WITH FALLBACK
    ai: {
        openRouterKey: process.env.OPENROUTER_API_KEY || undefined
    }
};

module.exports = Object.freeze(config);
