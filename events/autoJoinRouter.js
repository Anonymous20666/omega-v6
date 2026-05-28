'use strict';
// events/autoJoinRouter.js
// Stage 1 — AutoJoin Ingestion.
// Listens for messages on nodes that have AutoJoin toggled ON.
// Extracts WA invite codes and drops them into Main_DB (intake).
// Does NOT join anything — purely a collector.

const fs   = require('fs');
const path = require('path');
const logger  = require('../core/logger');
const eventBus = require('../core/eventBus');
const { handleAutoJoin, getSummary } = require('../core/linkPipeline');
const { ownerTelegramId } = require('../config');

const STATE_FILE = path.join(__dirname, '../data/autojoin-state.json');

// Per-node toggle state: nodeId → boolean
let _state = {};

function _loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
    } catch { _state = {}; }
}

function _saveState() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2)); } catch {}
}

function isAutoJoinOn(nodeId) {
    _loadState();
    return !!_state[String(nodeId || '')];
}

function setAutoJoin(nodeId, enabled) {
    _loadState();
    _state[String(nodeId || '')] = !!enabled;
    _saveState();
}

// Throttle: one Telegram notification per 60s per node
const _notifThrottle = new Map();

function _maybeNotify(nodeId, added, total) {
    if (!global.tgBot || !ownerTelegramId) return;
    const last = _notifThrottle.get(nodeId) || 0;
    if (Date.now() - last < 60000) return;
    _notifThrottle.set(nodeId, Date.now());
    const summary = getSummary();
    global.tgBot.telegram.sendMessage(
        ownerTelegramId,
        `📡 <b>AutoJoin Collector</b>\n\n` +
        `Node: <code>+${nodeId}</code>\n` +
        `New links ingested: <b>${added}</b>\n` +
        `📥 Main DB total: <b>${summary.main}</b>\n` +
        `✅ Live DB: <b>${summary.live}</b>`,
        { parse_mode: 'HTML' }
    ).catch(() => {});
}

// ─── Event listener ───────────────────────────────────────────────────────────
eventBus.on('message.upsert', ({ sock, msg, text, botId }) => {
    if (!text?.includes('chat.whatsapp.com')) return;

    const nodeId = String(botId || sock?.user?.id?.split(':')[0] || '');
    if (!nodeId || !isAutoJoinOn(nodeId)) return;

    const groupJid = msg?.key?.remoteJid || null;
    const added = handleAutoJoin(text, {
        nodeId,
        groupJid,
        scrapedAt: Date.now(),
    });

    if (added.length > 0) {
        logger.info(`[AutoJoin] Node +${nodeId} scraped ${added.length} new link(s) from ${groupJid || 'DM'}`);
        _maybeNotify(nodeId, added.length);
    }
});

module.exports = { isAutoJoinOn, setAutoJoin };
