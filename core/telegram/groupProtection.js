'use strict';

const fs = require('fs');
const path = require('path');

const TG_GROUP_PROTECT_FILE = path.resolve(__dirname, '../../data/telegram-group-protect.json');

let tgGroupProtectState = new Map();

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function makeDefaultGroupProtectConfig() {
    return {
        ai: { enabled: false },
        antiLink: { enabled: false, action: 'delete' },
        antiForward: { enabled: false, action: 'delete' },
        antiSpam: { enabled: false, action: 'warn', limit: 6, windowSec: 12 },
        antiDuplicate: { enabled: false, action: 'delete', windowSec: 20 },
        antiRaid: { enabled: false, action: 'mute', joinLimit: 5, windowSec: 20 },
        antiChannel: { enabled: false, action: 'delete' },
        welcome: {
            enabled: false,
            useAi: true,
            textTemplate: '',
            media: { type: '', fileId: '' },
        },
        stats: {
            warnings: 0,
            mutes: 0,
            kicks: 0,
            bans: 0,
            deletions: 0,
            incidents: 0,
            lastIncidentAt: 0,
        },
        logs: [],
        warns: {},
    };
}

function loadGroupProtectState(logger) {
    try {
        if (!fs.existsSync(TG_GROUP_PROTECT_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(TG_GROUP_PROTECT_FILE, 'utf8'));
        tgGroupProtectState = new Map(Object.entries(raw || {}));
    } catch (e) {
        logger?.warn?.('Failed to load Telegram group protection state', { error: e.message });
        tgGroupProtectState = new Map();
    }
}

function saveGroupProtectState(logger) {
    try {
        fs.mkdirSync(path.dirname(TG_GROUP_PROTECT_FILE), { recursive: true });
        fs.writeFileSync(
            TG_GROUP_PROTECT_FILE,
            JSON.stringify(Object.fromEntries(tgGroupProtectState.entries()), null, 2),
            'utf8'
        );
    } catch (e) {
        logger?.warn?.('Failed to save Telegram group protection state', { error: e.message });
    }
}

function getGroupProtectConfig(chatId) {
    const key = String(chatId || '');
    const base = makeDefaultGroupProtectConfig();
    const saved = tgGroupProtectState.get(key) || {};
    return {
        ai: { ...base.ai, ...(saved.ai || {}) },
        antiLink: { ...base.antiLink, ...(saved.antiLink || {}) },
        antiForward: { ...base.antiForward, ...(saved.antiForward || {}) },
        antiSpam: { ...base.antiSpam, ...(saved.antiSpam || {}) },
        antiDuplicate: { ...base.antiDuplicate, ...(saved.antiDuplicate || {}) },
        antiRaid: { ...base.antiRaid, ...(saved.antiRaid || {}) },
        antiChannel: { ...base.antiChannel, ...(saved.antiChannel || {}) },
        welcome: {
            ...base.welcome,
            ...(saved.welcome || {}),
            media: { ...base.welcome.media, ...(saved.welcome?.media || {}) },
        },
        stats: { ...base.stats, ...(saved.stats || {}) },
        logs: Array.isArray(saved.logs) ? saved.logs.slice(0, 40) : [],
        warns: saved.warns || {},
    };
}

function setGroupProtectConfig(chatId, cfg, logger) {
    tgGroupProtectState.set(String(chatId || ''), cfg || makeDefaultGroupProtectConfig());
    saveGroupProtectState(logger);
}

function recordGroupProtectEvent(chatId, cfg, type, payload = {}, logger) {
    const nextCfg = cfg || getGroupProtectConfig(chatId);
    nextCfg.stats = { ...(nextCfg.stats || {}) };
    nextCfg.logs = Array.isArray(nextCfg.logs) ? nextCfg.logs : [];
    nextCfg.stats.incidents = Number(nextCfg.stats.incidents || 0) + 1;
    nextCfg.stats.lastIncidentAt = Date.now();

    if (type === 'warn') nextCfg.stats.warnings = Number(nextCfg.stats.warnings || 0) + 1;
    if (type === 'mute') nextCfg.stats.mutes = Number(nextCfg.stats.mutes || 0) + 1;
    if (type === 'kick') nextCfg.stats.kicks = Number(nextCfg.stats.kicks || 0) + 1;
    if (type === 'ban') nextCfg.stats.bans = Number(nextCfg.stats.bans || 0) + 1;
    if (type === 'delete') nextCfg.stats.deletions = Number(nextCfg.stats.deletions || 0) + 1;

    nextCfg.logs.unshift({
        type,
        at: Date.now(),
        userId: String(payload.userId || ''),
        reason: String(payload.reason || ''),
        moderatorId: String(payload.moderatorId || ''),
    });
    nextCfg.logs = nextCfg.logs.slice(0, 40);
    setGroupProtectConfig(chatId, nextCfg, logger);
    return nextCfg;
}

function getGroupProtectionView(chatId, cfg) {
    const c = cfg || makeDefaultGroupProtectConfig();
    const fmt = (v) => (v ? 'ON ✅' : 'OFF 🔴');
    const actionLabel = (a) => ({ delete: 'Delete', warn: 'Warn', kick: 'Kick', ban: 'Ban', mute: 'Mute' }[a] || 'Delete');
    return {
        text: [
            `🛡️ <b>ADVANCED MODERATION</b>`,
            `<code>${escapeHtml(chatId)}</code>`,
            '',
            `🔗 Anti-Link: <b>${fmt(c.antiLink.enabled)}</b> (${actionLabel(c.antiLink.action)})`,
            `↪️ Anti-Forward: <b>${fmt(c.antiForward.enabled)}</b> (${actionLabel(c.antiForward.action)})`,
            `🚫 Anti-Spam: <b>${fmt(c.antiSpam.enabled)}</b> (${actionLabel(c.antiSpam.action)} | limit ${c.antiSpam.limit}/${c.antiSpam.windowSec}s)`,
            `🪞 Anti-Duplicate: <b>${fmt(c.antiDuplicate.enabled)}</b> (${actionLabel(c.antiDuplicate.action)})`,
            `📢 Anti-Channel Posts: <b>${fmt(c.antiChannel.enabled)}</b> (${actionLabel(c.antiChannel.action)})`,
            `🚨 Anti-Raid: <b>${fmt(c.antiRaid.enabled)}</b> (${actionLabel(c.antiRaid.action)} | ${c.antiRaid.joinLimit}/${c.antiRaid.windowSec}s)`,
            `🤖 Group AI: <b>${c.ai?.enabled ? 'ON ✅' : 'OFF 🔴'}</b>`,
            `👋 Welcome: <b>${fmt(c.welcome.enabled)}</b> | AI: <b>${c.welcome.useAi ? 'ON' : 'OFF'}</b>`,
            `🎞 Welcome Media: <b>${c.welcome.media?.type || 'none'}</b>`,
            '',
            `📊 Incidents: <b>${Number(c.stats?.incidents || 0)}</b>`,
            '<i>Use buttons below to tune security and automation.</i>',
        ].join('\n'),
        reply_markup: {
            inline_keyboard: [
                [
                    { text: c.antiLink.enabled ? '🔴 Anti-Link OFF' : '🟢 Anti-Link ON', callback_data: 'gp_toggle_antilink' },
                    { text: `⚙️ Link Action: ${actionLabel(c.antiLink.action)}`, callback_data: 'gp_actionmenu_antilink' },
                ],
                [
                    { text: c.antiForward.enabled ? '🔴 Anti-Forward OFF' : '🟢 Anti-Forward ON', callback_data: 'gp_toggle_antifwd' },
                    { text: `⚙️ Forward Action: ${actionLabel(c.antiForward.action)}`, callback_data: 'gp_actionmenu_antifwd' },
                ],
                [
                    { text: c.antiSpam.enabled ? '🔴 Anti-Spam OFF' : '🟢 Anti-Spam ON', callback_data: 'gp_toggle_antispam' },
                    { text: `⚙️ Spam Action: ${actionLabel(c.antiSpam.action)}`, callback_data: 'gp_actionmenu_antispam' },
                ],
                [
                    { text: c.antiDuplicate.enabled ? '🔴 Anti-Duplicate OFF' : '🟢 Anti-Duplicate ON', callback_data: 'gp_toggle_antiduplicate' },
                    { text: `⚙️ Duplicate Action: ${actionLabel(c.antiDuplicate.action)}`, callback_data: 'gp_actionmenu_antiduplicate' },
                ],
                [
                    { text: c.antiChannel.enabled ? '🔴 Anti-Channel OFF' : '🟢 Anti-Channel ON', callback_data: 'gp_toggle_antichannel' },
                    { text: `⚙️ Channel Action: ${actionLabel(c.antiChannel.action)}`, callback_data: 'gp_actionmenu_antichannel' },
                ],
                [
                    { text: c.antiRaid.enabled ? '🔴 Anti-Raid OFF' : '🟢 Anti-Raid ON', callback_data: 'gp_toggle_antiraid' },
                    { text: `⚙️ Raid Action: ${actionLabel(c.antiRaid.action)}`, callback_data: 'gp_actionmenu_antiraid' },
                ],
                [
                    { text: c.ai?.enabled ? '🤖 Group AI OFF' : '🤖 Group AI ON', callback_data: 'gp_toggle_groupai' },
                ],
                [
                    { text: c.welcome.enabled ? '🔴 Welcome OFF' : '🟢 Welcome ON', callback_data: 'gw_toggle' },
                    { text: c.welcome.useAi ? '🧠 AI Welcome ON' : '🧠 AI Welcome OFF', callback_data: 'gw_ai_toggle' },
                ],
                [
                    { text: '🖼 Add Welcome Pic', callback_data: 'gw_media_photo' },
                    { text: '🎥 Add Welcome Vid', callback_data: 'gw_media_video' },
                ],
                [
                    { text: '🎵 Add Welcome Song', callback_data: 'gw_media_audio' },
                    { text: '🗑 Clear Welcome Media', callback_data: 'gw_media_clear' },
                ],
                [
                    { text: '📊 Analytics', callback_data: 'gp_stats' },
                    { text: '🔄 Refresh', callback_data: 'gp_refresh' },
                ],
            ]
        }
    };
}

function getGroupProtectStatsView(chatId, cfg) {
    const current = cfg || getGroupProtectConfig(chatId);
    const stats = current.stats || {};
    const logs = Array.isArray(current.logs) ? current.logs.slice(0, 5) : [];
    const recent = logs.length
        ? logs.map((entry) => `• ${escapeHtml(String(entry.type || 'event').toUpperCase())} — ${escapeHtml(entry.reason || 'No reason')}`).join('\n')
        : '• No incidents logged yet';

    return {
        text: [
            '📊 <b>MODERATION ANALYTICS</b>',
            `<code>${escapeHtml(chatId)}</code>`,
            '',
            `⚠️ Warnings: <b>${Number(stats.warnings || 0)}</b>`,
            `🔇 Mutes: <b>${Number(stats.mutes || 0)}</b>`,
            `👢 Kicks: <b>${Number(stats.kicks || 0)}</b>`,
            `⛔ Bans: <b>${Number(stats.bans || 0)}</b>`,
            `🗑 Deletions: <b>${Number(stats.deletions || 0)}</b>`,
            `🚨 Incidents: <b>${Number(stats.incidents || 0)}</b>`,
            '',
            '<b>Recent Activity</b>',
            recent,
        ].join('\n'),
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔄 Refresh', callback_data: 'gp_stats' }],
                [{ text: '🔙 Back to Protection', callback_data: 'gp_refresh' }],
            ]
        }
    };
}

module.exports = {
    makeDefaultGroupProtectConfig,
    loadGroupProtectState,
    saveGroupProtectState,
    getGroupProtectConfig,
    setGroupProtectConfig,
    recordGroupProtectEvent,
    getGroupProtectionView,
    getGroupProtectStatsView,
};
