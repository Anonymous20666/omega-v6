'use strict';
// plugins/pappy-admin.js — Aggressive Group Protection Suite

const fsp    = require('fs').promises;
const path   = require('path');
const logger = require('../core/logger');
const eventBus = require('../core/eventBus');
const { guardGroupMetadataMutation } = require('../core/groupSafety');
const { ownerWhatsAppJids } = require('../config');

function getDbPath(botId) {
    const digits = String(botId || '').replace(/[^0-9]/g, '');
    if (!digits) return path.join(__dirname, '../data/group_settings.json');
    return path.join(__dirname, `../data/group_settings-${digits}.json`);
}
const DB_PATH = path.join(__dirname, '../data/group_settings.json');
const SPAM_SHORT_WINDOW_MS = 6 * 1000;
const SPAM_LONG_WINDOW_MS = 30 * 1000;
const LINK_WINDOW_MS = 30 * 1000;
const ACTION_COOLDOWN_MS = 8 * 1000;

// ─── GROUP META CACHE (shared central cache) ─────────────────────────────────
const groupCache = require('../core/groupCache');
async function getCachedGroupMeta(sock, jid) {
    return groupCache.getGroupMeta(sock, jid);
}

// ─── DB ──────────────────────────────────────────────────────────────────────
let _db = {};
let _writePending = false;

async function loadDb(botId) {
    const p = botId ? getDbPath(botId) : DB_PATH;
    try { _db = JSON.parse(await fsp.readFile(p, 'utf8')); } catch { _db = {}; }
}

async function saveDb(botId) {
    if (_writePending) return;
    _writePending = true;
    const p = botId ? getDbPath(botId) : DB_PATH;
    try { await fsp.writeFile(p, JSON.stringify(_db, null, 2), 'utf8'); }
    catch (e) { logger.error('[Admin] DB save failed', { error: e.message }); }
    finally { _writePending = false; }
}

function getScopedGroupKey(jid, botId) {
    const normalizedBotId = String(botId || '').replace(/[^0-9]/g, '') || 'global';
    return `${normalizedBotId}:${jid}`;
}

function getGroup(jid, botId) {
    // Lazy-load per-node db if not loaded yet
    const dbPath = getDbPath(botId);
    if (!_db._loadedFor || _db._loadedFor !== String(botId || '')) {
        try { Object.assign(_db, JSON.parse(require('fs').readFileSync(dbPath, 'utf8'))); } catch {}
        _db._loadedFor = String(botId || '');
    }
    const scopeKey = getScopedGroupKey(jid, botId);
    if (!_db[scopeKey]) _db[scopeKey] = {
        antilink: false, antibot: false, antigm: false,
        antispam: false, antichannel: false, antidemote: false,
        antigstatus: false,
        antidemoteMode: 'admins',
        antilinkAction: 'kick', antibotAction: 'kick',
        antigmAction: 'kick', antispamAction: 'warn',
        antichannelAction: 'kick', antigstatusAction: 'kick',
        warns: {}, spamTracker: {}, strictTracker: {},
        maxWarns: 3,
    };
    return _db[scopeKey];
}

function getContextInfoFromMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const directKeys = [
        'extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage',
        'buttonsResponseMessage', 'templateButtonReplyMessage', 'listResponseMessage'
    ];
    for (const key of directKeys) {
        const contextInfo = message[key]?.contextInfo;
        if (contextInfo) return contextInfo;
    }

    const nested = message.viewOnceMessage?.message
        || message.viewOnceMessageV2?.message
        || message.viewOnceMessageV2Extension?.message
        || null;
    return nested ? getContextInfoFromMessage(nested) : null;
}

function resolveTargetJid(msg, args = []) {
    const contextInfo = getContextInfoFromMessage(msg?.message);
    const mentioned = contextInfo?.mentionedJid?.[0];
    if (mentioned) return mentioned;

    const repliedSender = contextInfo?.participant;
    if (repliedSender) return normalizeJid(repliedSender);

    const firstArgDigits = String(args[0] || '').replace(/[^0-9]/g, '');
    if (firstArgDigits) return `${firstArgDigits}@s.whatsapp.net`;
    return null;
}

function normalizeTextForDetection(text) {
    const raw = String(text || '').toLowerCase();
    return {
        raw,
        compact: raw
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+/g, '')
            .replace(/[()\[\]{}<>]/g, ''),
    };
}

function detectLinks(text) {
    const { raw, compact } = normalizeTextForDetection(text);
    const patterns = [
        /https?:\/\//i,
        /www\./i,
        /(?:chat\.?whatsapp\.?com|wa\.me|t\.me|telegram\.me|discord\.gg|bit\.ly|tinyurl|cutt\.ly|rb\.gy)/i,
        /\b[a-z0-9-]+\.(?:com|net|org|io|co|xyz|me|ly|app|dev|gg|ai|biz)\b/i,
    ];
    const compactPatterns = [
        /chatwhatsappcom\/[a-z0-9]{10,}/i,
        /wame\/[0-9]{5,}/i,
    ];

    const hasLink = patterns.some((re) => re.test(raw)) || compactPatterns.some((re) => re.test(compact));
    const linkMatches = raw.match(/https?:\/\/\S+|www\.\S+|chat\.?whatsapp\.?com\/\S+|wa\.me\/\S+/gi) || [];
    return { hasLink, linkCount: Math.max(1, linkMatches.length) };
}

function isLikelyBotSpamMessage(sender, text, msg) {
    const raw = String(text || '');
    if (!raw) return false;

    let score = 0;
    if (/:\d+(?=@)/.test(String(sender || ''))) score += 1;
    if (/\b(whatsapp bot|wa bot|md bot|base bot|multi device bot|powered by|bot by|deploy bot|pair code|scan qr)\b/i.test(raw)) score += 3;
    if (/github\.com\/.+\/(?:.+)?(?:bot|baileys|whatsapp)/i.test(raw)) score += 2;
    if (/\b\d{3}-\d{3}\b/.test(raw) || /pair\s*code/i.test(raw)) score += 2;
    if (/^\s*[./!#][a-z0-9]/i.test(raw) && raw.length > 120) score += 1;

    const forwardingScore = Number(getContextInfoFromMessage(msg?.message)?.forwardingScore || 0);
    if (forwardingScore >= 10 && /bot|pair|session|deploy/i.test(raw)) score += 2;

    return score >= 4;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function kickUser(sock, jid, userJid) {
    await sock.groupParticipantsUpdate(jid, [userJid], 'remove');
}

async function warnUser(sock, jid, userJid, reason, group, botId) {
    if (!group.warns[userJid]) group.warns[userJid] = 0;
    group.warns[userJid]++;
    await saveDb(botId).catch(() => {});
    const count = group.warns[userJid];
    const max   = group.maxWarns || 3;
    await sock.sendMessage(jid, {
        text: `⚠️ @${userJid.split('@')[0]} has been warned.\n📌 Reason: ${reason}\n🔢 Warns: ${count}/${max}`,
        mentions: [userJid]
    });
    if (count >= max) {
        group.warns[userJid] = 0;
        await saveDb(botId).catch(() => {});
        await sock.sendMessage(jid, { text: `🚫 @${userJid.split('@')[0]} reached max warns. Kicking...`, mentions: [userJid] });
        await kickUser(sock, jid, userJid).catch(() => {});
    }
}

async function deleteMsg(sock, msg) {
    await sock.sendMessage(msg.key.remoteJid, { delete: msg.key }).catch(() => {});
}

function buildQuotedDeleteKey(msg, jid) {
    const contextInfo = getContextInfoFromMessage(msg?.message);
    const stanzaId = contextInfo?.stanzaId;
    const participant = contextInfo?.participant;
    if (!stanzaId || !participant) return null;

    return {
        remoteJid: jid,
        id: stanzaId,
        participant,
        fromMe: false,
    };
}

async function deleteQuotedTargetMessage(sock, msg, jid) {
    const key = buildQuotedDeleteKey(msg, jid);
    if (!key) return false;
    await sock.sendMessage(jid, { delete: key }).catch(() => {});
    return true;
}

async function takeAction(sock, jid, userJid, action, reason, group, msg, botId) {
    if (action === 'kick') {
        await deleteMsg(sock, msg).catch(() => {});
        await sock.sendMessage(jid, { text: `🚫 @${userJid.split('@')[0]} was kicked.\n📌 Reason: ${reason}`, mentions: [userJid] });
        await kickUser(sock, jid, userJid).catch(() => {});
    } else if (action === 'warn') {
        await deleteMsg(sock, msg).catch(() => {});
        await warnUser(sock, jid, userJid, reason, group, botId);
    } else if (action === 'delete') {
        await deleteMsg(sock, msg).catch(() => {});
        await sock.sendMessage(jid, { text: `🗑️ Message deleted.\n📌 Reason: ${reason}` });
    }
}

loadDb(null).catch(() => {});

// ─── PROTECTION DAEMON ───────────────────────────────────────────────────────
let daemonStarted = false;
const antiDemoteListeners = new Set();

function normalizeJid(jid) {
    return String(jid || '').replace(/:\d+(?=@)/g, '').trim();
}

function buildOwnerSet() {
    const set = new Set();
    for (const j of ownerWhatsAppJids || []) {
        const norm = normalizeJid(j);
        if (!norm) continue;
        set.add(norm);
        set.add(norm.split('@')[0]);
    }
    return set;
}

function attachAntiDemoteListener(sock) {
    const botId = sock?.user?.id?.split(':')[0];
    if (!botId || antiDemoteListeners.has(botId)) return;
    antiDemoteListeners.add(botId);

    const ownerSet = buildOwnerSet();
    const botJid = `${botId}@s.whatsapp.net`;
    const isProtectedJid = (jid) => {
        const norm = normalizeJid(jid);
        const phone = norm.split('@')[0];
        return norm === botJid || ownerSet.has(norm) || ownerSet.has(phone);
    };

    sock.ev.on('group-participants.update', async ({ id, participants, action, author, actor, by }) => {
        if (action !== 'demote' || !id || !Array.isArray(participants) || !participants.length) return;

        const group = getGroup(id, botId);
        if (!group.antidemote) return;
        const mode = String(group.antidemoteMode || 'admins').toLowerCase();

        let meta = null;
        try {
            meta = await getCachedGroupMeta(sock, id);
        } catch {}

        const resolveActor = () => {
            const primary = normalizeJid(author || actor || by || '');
            if (primary) return primary;

            // Some payloads only carry a phone-like actor token; map it to group participant JID.
            const hint = String(author || actor || by || '').replace(/[^0-9]/g, '');
            if (!hint || !meta?.participants?.length) return '';
            const hit = meta.participants.find((p) => String(p?.id || '').replace(/[^0-9]/g, '') === hint);
            return normalizeJid(hit?.id || '');
        };
        const resolvedActor = resolveActor();

        for (const participant of participants) {
            const normalizedParticipant = normalizeJid(participant);
            const protectedTarget = isProtectedJid(normalizedParticipant);
            const shouldRestore = mode === 'admins' ? true : protectedTarget;
            if (!shouldRestore) continue;

            try {
                await sock.groupParticipantsUpdate(id, [normalizedParticipant], 'promote');
                const canPunishActor = !!resolvedActor && resolvedActor !== normalizedParticipant && !isProtectedJid(resolvedActor);

                if (canPunishActor) {
                    await sock.groupParticipantsUpdate(id, [resolvedActor], 'demote').catch(() => {});
                }

                const byPhone = String(resolvedActor || '').split('@')[0] || 'unknown';
                await sock.sendMessage(id, {
                    text: canPunishActor
                        ? `🛡️ AntiDemote restored @${normalizedParticipant.split('@')[0]} as admin.\n⚖️ @${byPhone} was demoted for unauthorized demotion.`
                        : `🛡️ AntiDemote restored @${normalizedParticipant.split('@')[0]} as admin.\nTriggered by: @${byPhone}`,
                    mentions: canPunishActor ? [normalizedParticipant, resolvedActor] : [normalizedParticipant],
                }).catch(() => {});
            } catch (err) {
                logger.warn('[Admin] AntiDemote restore failed', { groupId: id, participant: normalizedParticipant, actor: resolvedActor, error: err.message });
            }
        }
    });
}

function startDaemon() {
    if (daemonStarted) return;
    daemonStarted = true;

    eventBus.on('message.upsert', async ({ sock, msg, text, isGroup, sender, botId }) => {
        if (!isGroup || !msg?.message) return;
        const jid   = msg.key.remoteJid;
        const group = getGroup(jid, botId);
        const bodyText = String(text || msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '');
        const now = Date.now();

        if (!group.strictTracker || typeof group.strictTracker !== 'object') group.strictTracker = {};
        if (!group.strictTracker[sender]) {
            group.strictTracker[sender] = { msgTimes: [], shortMsgTimes: [], linkTimes: [], lastActionAt: 0, botHits: 0 };
        }
        const tracker = group.strictTracker[sender];
        tracker.msgTimes = (tracker.msgTimes || []).filter((t) => now - t < SPAM_LONG_WINDOW_MS);
        tracker.shortMsgTimes = (tracker.shortMsgTimes || []).filter((t) => now - t < SPAM_SHORT_WINDOW_MS);
        tracker.linkTimes = (tracker.linkTimes || []).filter((t) => now - t < LINK_WINDOW_MS);
        tracker.msgTimes.push(now);
        tracker.shortMsgTimes.push(now);

        const actionLocked = (now - Number(tracker.lastActionAt || 0)) < ACTION_COOLDOWN_MS;
        const { hasLink, linkCount } = detectLinks(bodyText);
        if (hasLink) {
            for (let i = 0; i < linkCount; i++) tracker.linkTimes.push(now);
        }

        // Skip bot's own messages and admins
        if (msg.key.fromMe) return;
        try {
            const meta  = await getCachedGroupMeta(sock, jid);
            const me    = `${botId}@s.whatsapp.net`;
            const isAdmin = meta.participants.find(p => p.id === sender)?.admin;
            const botIsAdmin = meta.participants.find(p => p.id === me)?.admin;
            if (isAdmin || !botIsAdmin) return; // skip admins & if bot not admin
        } catch { return; }

        // ── ANTILINK ──────────────────────────────────────────────────────────
        if (group.antilink && hasLink && !actionLocked) {
            // Always delete link payload immediately; keep actions soft unless explicitly configured otherwise.
            await deleteMsg(sock, msg).catch(() => {});
            tracker.lastActionAt = now;

            await takeAction(sock, jid, sender, group.antilinkAction, 'Sending links is not allowed', group, msg, botId);
            return;
        }

        // ── ANTICHANNEL ───────────────────────────────────────────────────────
        if (group.antichannel) {
            const isChannel = msg.key.participant?.includes('newsletter') ||
                msg.message?.extendedTextMessage?.contextInfo?.forwardingScore > 5;
            if (isChannel) {
                await takeAction(sock, jid, sender, group.antichannelAction, 'Channel messages not allowed', group, msg, botId);
                return;
            }
        }

        // ── ANTIGSTATUS ───────────────────────────────────────────────────────
        if (group.antigstatus) {
            const isGStatus = !!(msg.message?.groupStatusMessageV2) ||
                !!(msg.message?.groupStatusMessage) ||
                !!(msg.message?.statusMessage);

            if (isGStatus && !msg.key.fromMe) {
                logger.info(`[AntiGStatus] Detected group status from ${sender}`);
                await deleteMsg(sock, msg).catch(() => {});
                await takeAction(sock, jid, sender, group.antigstatusAction, 'Group status updates are not allowed', group, msg, botId);
                return;
            }
        }

        // ── ANTIBOT ───────────────────────────────────────────────────────────
        if (group.antibot && !actionLocked) {
            const botLike = isLikelyBotSpamMessage(sender, bodyText, msg);
            if (botLike) {
                tracker.botHits = Number(tracker.botHits || 0) + 1;
                tracker.lastActionAt = now;
                await takeAction(sock, jid, sender, group.antibotAction, 'Automated bot-like behavior detected', group, msg, botId);
                return;
            }
        }

        // ── ANTIGM (anti-group-mention / mass tag) ────────────────────────────
        if (group.antigm) {
            const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentions.length >= 5) {
                await takeAction(sock, jid, sender, group.antigmAction, 'Mass tagging is not allowed', group, msg, botId);
                return;
            }
        }

        // ── ANTISPAM ──────────────────────────────────────────────────────────
        if (group.antispam && !actionLocked) {
            if (!group.spamTracker[sender]) group.spamTracker[sender] = [];
            group.spamTracker[sender] = group.spamTracker[sender].filter(t => now - t < 5000);
            group.spamTracker[sender].push(now);

            const shortBurst = tracker.shortMsgTimes.length >= 10;
            const longBurst = tracker.msgTimes.length >= 25;
            const hardLinkFlood = tracker.linkTimes.length >= 8;
            const configuredSpamHit = group.spamTracker[sender].length >= 6;

            if (shortBurst || longBurst || hardLinkFlood || configuredSpamHit) {
                group.spamTracker[sender] = [];
                tracker.lastActionAt = now;
                await takeAction(sock, jid, sender, group.antispamAction, 'Spamming is not allowed', group, msg, botId);
                return;
            }
        }
    });
}

// ─── MODULE ──────────────────────────────────────────────────────────────────
module.exports = {
    category: 'ADMIN',
    commands: [
        // Protection toggles
        { cmd: '.antilink',    role: 'admin' },
        { cmd: '.antibot',     role: 'admin' },
        { cmd: '.antigm',      role: 'admin' },
        { cmd: '.antispam',    role: 'admin' },
        { cmd: '.antichannel', role: 'admin' },
        { cmd: '.antidemote',  role: 'owner' },
        { cmd: '.antigstatus', role: 'admin' },
        // Action setters
        { cmd: '.setaction',   role: 'admin' },
        // Moderation
        { cmd: '.kick',        role: 'admin' },
        { cmd: '.warn',        role: 'admin' },
        { cmd: '.warns',       role: 'admin' },
        { cmd: '.resetwarn',   role: 'admin' },
        { cmd: '.delete',      role: 'admin' },
        { cmd: '.dlt',         role: 'admin' },
        { cmd: '.deleteall',   role: 'admin' },
        { cmd: '.ban',         role: 'admin' },
        { cmd: '.unban',       role: 'admin' },
        { cmd: '.accept',      role: 'admin' },
        { cmd: '.acceptall',   role: 'admin' },
        { cmd: '.rejectall',   role: 'admin' },
        { cmd: '.reject',      role: 'admin' },
        { cmd: '.stoprequest', role: 'admin' },
        { cmd: '.promote',     role: 'admin' },
        { cmd: '.demote',      role: 'admin' },
        { cmd: '.mute',        role: 'admin' },
        { cmd: '.unmute',      role: 'admin' },
        { cmd: '.groupsettings', role: 'admin' },
        { cmd: '.setgrppfp',   role: 'admin' },
        { cmd: '.tag',         role: 'owner' },
        { cmd: '.setmypfp',    role: 'owner' },
        { cmd: '.setpfp',      role: 'owner' },
        { cmd: '.delpfp',      role: 'owner' },
        { cmd: '.setname',     role: 'owner' },
        { cmd: '.fullpfp',     role: 'public' },
    ],

    init: (sock) => {
        startDaemon();
        if (sock) attachAntiDemoteListener(sock);
    },

    execute: async ({ sock, msg, args, text, user, botId }) => {
        const jid   = msg.key.remoteJid;
        const cmd   = text.split(' ')[0].toLowerCase();
        const group = getGroup(jid, botId);

        // Resolve target by: mention -> reply target -> numeric arg
        const mentioned = resolveTargetJid(msg, args);

        // ── PROTECTION TOGGLES ────────────────────────────────────────────────
        const toggleMap = {
            '.antilink': 'antilink', '.antibot': 'antibot',
            '.antigm': 'antigm', '.antispam': 'antispam', '.antichannel': 'antichannel',
            '.antidemote': 'antidemote',
            '.antigstatus': 'antigstatus'
        };

        if (toggleMap[cmd]) {
            const key    = toggleMap[cmd];
            const action = String(args[0] || '').toLowerCase();

            const isEnabledWord = ['on', 'enable', 'enabled', 'true', '1'].includes(action);
            const isDisabledWord = ['off', 'disable', 'disabled', 'false', '0'].includes(action);

            if (cmd === '.antidemote' && action === 'mode') {
                const modeArg = String(args[1] || '').toLowerCase();
                if (!['protected', 'admins'].includes(modeArg)) {
                    return sock.sendMessage(jid, {
                        text: '❌ Usage: .antidemote mode <protected|admins>\n• protected = only owner/bot protected targets\n• admins = any group admin demotion triggers restore + punishment'
                    }, { quoted: msg });
                }
                group.antidemoteMode = modeArg;
                await saveDb(botId);
                return sock.sendMessage(jid, {
                    text: `✅ *ANTIDEMOTE MODE* set to *${modeArg.toUpperCase()}*`
                }, { quoted: msg });
            }

            if (isEnabledWord || isDisabledWord || action === 'toggle') {
                const nextState = action === 'toggle' ? !group[key] : isEnabledWord;
                group[key] = nextState;
                if (cmd === '.antidemote' && group[key] && !group.antidemoteMode) {
                    group.antidemoteMode = 'admins';
                }
                if (group[key] && key === 'antispam') group.antispamAction = 'kick';
                if (group[key] && key === 'antilink') group.antilinkAction = 'kick';
                await saveDb(botId);
                return sock.sendMessage(jid, {
                    text: cmd === '.antidemote'
                        ? `${group[key] ? '✅' : '🔴'} *ANTIDEMOTE* is now *${group[key] ? 'ON' : 'OFF'}*\n🧭 Mode: *${String(group.antidemoteMode || 'protected').toUpperCase()}*`
                        : `${group[key] ? '✅' : '🔴'} *${cmd.slice(1).toUpperCase()}* is now *${group[key] ? 'ON' : 'OFF'}*\n⚙️ Action: *${group[key + 'Action'] || 'kick'}*`
                }, { quoted: msg });
            }
            return sock.sendMessage(jid, {
                text: cmd === '.antidemote'
                    ? `⚙️ *ANTIDEMOTE* Status: ${group[key] ? '✅ ON' : '🔴 OFF'}\n🧭 Mode: *${String(group.antidemoteMode || 'protected').toUpperCase()}*\n\nUsage:\n• .antidemote on/off\n• .antidemote mode <protected|admins>`
                    : `⚙️ *${cmd.slice(1).toUpperCase()}* Status: ${group[key] ? '✅ ON' : '🔴 OFF'}\nAction: *${group[key + 'Action'] || 'kick'}*\n\nUsage: ${cmd} on/off | toggle`
            }, { quoted: msg });
        }

        // ── SET ACTION ────────────────────────────────────────────────────────
        if (cmd === '.setaction') {
            // .setaction antilink kick|warn|delete
            const feature = args[0]?.toLowerCase();
            const action  = args[1]?.toLowerCase();
            const validFeatures = ['antilink', 'antibot', 'antigm', 'antispam', 'antichannel', 'antigstatus'];
            const validActions  = ['kick', 'warn', 'delete'];
            if (!validFeatures.includes(feature) || !validActions.includes(action)) {
                return sock.sendMessage(jid, { text: '❌ Usage: .setaction <antilink|antibot|antigm|antispam|antichannel|antigstatus> <kick|warn|delete>' }, { quoted: msg });
            }
            group[feature + 'Action'] = action;
            await saveDb(botId);
            return sock.sendMessage(jid, { text: `✅ *${feature}* action set to *${action}*` }, { quoted: msg });
        }

        // ── KICK ──────────────────────────────────────────────────────────────
        if (cmd === '.kick' || cmd === '.ban') {
            if (!mentioned) return sock.sendMessage(jid, { text: '❌ Tag or mention a user to kick.' }, { quoted: msg });
            await deleteQuotedTargetMessage(sock, msg, jid).catch(() => {});
            await sock.sendMessage(jid, { text: `🚫 @${mentioned.split('@')[0]} has been removed.`, mentions: [mentioned] });
            await kickUser(sock, jid, mentioned).catch(() => {});
            return;
        }

        // ── WARN ──────────────────────────────────────────────────────────────
        if (cmd === '.warn') {
            if (!mentioned) return sock.sendMessage(jid, { text: '❌ Tag a user to warn.' }, { quoted: msg });
            const typedTarget = String(args[0] || '').replace(/[^0-9]/g, '');
            const reason = (typedTarget ? args.slice(1) : args).join(' ') || 'No reason given';
            await deleteQuotedTargetMessage(sock, msg, jid).catch(() => {});
            await warnUser(sock, jid, mentioned, reason, group, botId);
            return;
        }

        // ── WARNS ─────────────────────────────────────────────────────────────
        if (cmd === '.warns') {
            if (!mentioned) {
                const list = Object.entries(group.warns || {})
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => `• @${k.split('@')[0]}: ${v}/${group.maxWarns || 3} warns`)
                    .join('\n') || 'No active warns.';
                return sock.sendMessage(jid, { text: `📋 *WARN LIST*\n\n${list}` }, { quoted: msg });
            }
            const count = group.warns?.[mentioned] || 0;
            return sock.sendMessage(jid, {
                text: `⚠️ @${mentioned.split('@')[0]} has *${count}/${group.maxWarns || 3}* warns.`,
                mentions: [mentioned]
            }, { quoted: msg });
        }

        // ── RESET WARN ────────────────────────────────────────────────────────
        if (cmd === '.resetwarn') {
            if (!mentioned) return sock.sendMessage(jid, { text: '❌ Tag a user to reset warns.' }, { quoted: msg });
            group.warns[mentioned] = 0;
            await saveDb(botId);
            return sock.sendMessage(jid, { text: `✅ Warns reset for @${mentioned.split('@')[0]}`, mentions: [mentioned] }, { quoted: msg });
        }

        // ── DELETE ────────────────────────────────────────────────────────────
        if (cmd === '.delete' || cmd === '.dlt') {
            const quotedKey = buildQuotedDeleteKey(msg, jid);
            if (!quotedKey) return sock.sendMessage(jid, { text: '❌ Reply to a message to delete it.' }, { quoted: msg });
            await sock.sendMessage(jid, { delete: quotedKey }).catch(() => {});
            return;
        }

        // ── DELETE ALL (delete all msgs from a tagged user) ───────────────────
        if (cmd === '.deleteall') {
            if (!mentioned) return sock.sendMessage(jid, { text: '❌ Tag a user to delete all their messages.' }, { quoted: msg });

            const targetNorm = normalizeJid(mentioned);
            const targetDigits = targetNorm.replace(/[^0-9]/g, '');
            const isTargetBot = targetDigits === String(botId || '').replace(/[^0-9]/g, '');

            const statusMsg = await sock.sendMessage(jid, {
                text: `🗑️ Deleting all messages from @${mentioned.split('@')[0]}...`,
                mentions: [mentioned]
            });

            const toDelete = [];

            // Fast path: use sender index if available
            const indexKey = `${jid}:${targetDigits}`;
            const indexedIds = global._senderMsgIndex?.get(indexKey);

            if (indexedIds?.size) {
                for (const id of indexedIds) {
                    const cachedMsg = global.messageCache?.get(id);
                    if (cachedMsg?.key) toDelete.push({ id, key: cachedMsg.key });
                }
            }

            // Fallback: full scan for any messages not in index (e.g. fromMe bot messages)
            if (global.messageCache) {
                for (const [id, cachedMsg] of global.messageCache.entries()) {
                    if (cachedMsg.key?.remoteJid !== jid) continue;
                    if (toDelete.some(t => t.id === id)) continue; // already found via index
                    let sender;
                    if (cachedMsg.key?.fromMe) {
                        sender = `${botId}@s.whatsapp.net`;
                    } else {
                        sender = normalizeJid(cachedMsg.key?.participant || cachedMsg.key?.remoteJid);
                    }
                    const senderDigits = String(sender || '').replace(/[^0-9]/g, '');
                    const matches = isTargetBot
                        ? cachedMsg.key?.fromMe === true
                        : senderDigits === targetDigits;
                    if (matches) toDelete.push({ id, key: cachedMsg.key });
                }
            }

            if (!toDelete.length) {
                await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
                return sock.sendMessage(jid, {
                    text: `📭 No cached messages found from @${mentioned.split('@')[0]}.\n_Note: only messages received since the bot last started are deletable._`,
                    mentions: [mentioned]
                }, { quoted: msg });
            }

            let deleted = 0;
            for (let i = 0; i < toDelete.length; i++) {
                const { id, key } = toDelete[i];
                await sock.sendMessage(jid, { delete: key }).catch(() => {});
                global.messageCache?.delete(id);
                deleted++;
                if (i % 10 === 9) await new Promise(r => setTimeout(r, 300));
            }

            // Clean up index
            global._senderMsgIndex?.delete(indexKey);

            await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
            return sock.sendMessage(jid, {
                text: `✅ Deleted *${deleted}* message(s) from @${mentioned.split('@')[0]}.`,
                mentions: [mentioned]
            }, { quoted: msg });
        }

        // ── PROMOTE / DEMOTE ──────────────────────────────────────────────────
        if (cmd === '.promote') {
            if (!mentioned) return sock.sendMessage(jid, { text: '❌ Tag a user to promote.' }, { quoted: msg });
            await sock.groupParticipantsUpdate(jid, [mentioned], 'promote');
            return sock.sendMessage(jid, { text: `⬆️ @${mentioned.split('@')[0]} promoted to admin.`, mentions: [mentioned] }, { quoted: msg });
        }

        if (cmd === '.demote') {
            if (!mentioned) return sock.sendMessage(jid, { text: '❌ Tag a user to demote.' }, { quoted: msg });
            await sock.groupParticipantsUpdate(jid, [mentioned], 'demote');
            return sock.sendMessage(jid, { text: `⬇️ @${mentioned.split('@')[0]} demoted from admin.`, mentions: [mentioned] }, { quoted: msg });
        }

        // ── MUTE / UNMUTE ─────────────────────────────────────────────────────
        if (cmd === '.mute') {
            const gate = guardGroupMetadataMutation({ jid, command: cmd, action: 'announcement' });
            if (!gate.ok) {
                const waitSec = Math.max(1, Math.ceil(Number(gate.waitMs || 0) / 1000));
                return sock.sendMessage(jid, { text: gate.reason === 'cooldown' ? `⏳ Group metadata cooldown active. Retry in ${waitSec}s.` : '⚠️ Group metadata guard blocked this action.' }, { quoted: msg });
            }
            await sock.groupSettingUpdate(jid, 'announcement');
            return sock.sendMessage(jid, { text: '🔇 Group muted. Only admins can send messages.' }, { quoted: msg });
        }

        if (cmd === '.unmute') {
            const gate = guardGroupMetadataMutation({ jid, command: cmd, action: 'announcement' });
            if (!gate.ok) {
                const waitSec = Math.max(1, Math.ceil(Number(gate.waitMs || 0) / 1000));
                return sock.sendMessage(jid, { text: gate.reason === 'cooldown' ? `⏳ Group metadata cooldown active. Retry in ${waitSec}s.` : '⚠️ Group metadata guard blocked this action.' }, { quoted: msg });
            }
            await sock.groupSettingUpdate(jid, 'not_announcement');
            return sock.sendMessage(jid, { text: '🔊 Group unmuted. Everyone can send messages.' }, { quoted: msg });
        }

        // ── UNBAN ─────────────────────────────────────────────────────────────
        if (cmd === '.unban') {
            if (!mentioned) return sock.sendMessage(jid, { text: '❌ Tag a user to unban/add back.' }, { quoted: msg });
            await sock.groupParticipantsUpdate(jid, [mentioned], 'add');
            return sock.sendMessage(jid, { text: `✅ @${mentioned.split('@')[0]} has been added back.`, mentions: [mentioned] }, { quoted: msg });
        }

        // ── STOPREQUEST ───────────────────────────────────────────────────────
        if (cmd === '.stoprequest') {
            if (!global._reqStop) global._reqStop = new Set();
            global._reqStop.add(jid);
            return sock.sendMessage(jid, { text: '🛑 Stopped! Current batch will finish then halt.' }, { quoted: msg });
        }

        // ── SMART ACCEPT BATCH HELPER ─────────────────────────────────────────
        async function smartAcceptBatch(groupJid, targets) {
            const GC_MAX = 1024;
            const BATCH = 20;
            if (!global._reqStop) global._reqStop = new Set();
            global._reqStop.delete(groupJid);

            // Fetch initial count with timeout guard
            let currentCount = 0;
            try {
                const meta = await Promise.race([
                    sock.groupMetadata(groupJid),
                    new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
                ]);
                currentCount = meta?.participants?.length || 0;
            } catch {}

            let slots = GC_MAX - currentCount;
            if (slots <= 0) return { done: 0, stopped: false, full: true };

            const capped = targets.slice(0, slots);
            let done = 0;
            let full = false;

            for (let i = 0; i < capped.length; i += BATCH) {
                if (global._reqStop.has(groupJid)) break;

                const batch = capped.slice(i, i + BATCH);

                // Run the WA call off the event loop tick so other messages still process
                await new Promise(resolve => setImmediate(async () => {
                    try {
                        await sock.groupRequestParticipantsUpdate(groupJid, batch, 'approve');
                    } catch {}
                    done += batch.length;
                    resolve();
                }));

                // Re-check live count every 2 batches (every 40 accepts) to reduce API calls
                if (i % (BATCH * 2) === 0 && i > 0) {
                    try {
                        const fresh = await Promise.race([
                            sock.groupMetadata(groupJid),
                            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
                        ]);
                        currentCount = fresh?.participants?.length || currentCount;
                        slots = GC_MAX - currentCount;
                        if (slots <= 0) { full = true; break; }
                    } catch {}
                }

                // Yield to event loop between batches
                await new Promise(r => setTimeout(r, 2000));
            }

            return { done, stopped: global._reqStop.has(groupJid), full };
        }

        // ── ACCEPT (specific user OR country code filter) ─────────────────────
        // .accept @user          → accept that specific user's request
        // .accept 234            → accept only requests from country code 234
        if (cmd === '.accept') {
            const filter = String(args[0] || '').replace(/[^0-9]/g, '');
            const isCcFilter = filter && filter.length <= 4 && !mentioned;

            if (!isCcFilter && !mentioned) {
                return sock.sendMessage(jid, {
                    text: '❌ Usage:\n• `.accept @user` — accept specific request\n• `.accept 234` — accept all requests from country code 234'
                }, { quoted: msg });
            }

            if (!isCcFilter) {
                // Single user — still check capacity first
                try {
                    const meta = await sock.groupMetadata(jid).catch(() => null);
                    if (meta && meta.participants.length >= 1024) {
                        return sock.sendMessage(jid, { text: '🚫 Group is full (1024/1024). Cannot accept.' }, { quoted: msg });
                    }
                    await sock.groupRequestParticipantsUpdate(jid, [mentioned], 'approve');
                    return sock.sendMessage(jid, { text: `✅ Accepted @${mentioned.split('@')[0]}.`, mentions: [mentioned] }, { quoted: msg });
                } catch (e) {
                    return sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }, { quoted: msg });
                }
            }

            // Country code filter accept
            let pending;
            try { pending = await sock.groupRequestParticipantsList(jid); } catch (e) {
                return sock.sendMessage(jid, { text: `❌ Could not fetch requests: ${e.message}` }, { quoted: msg });
            }
            const targets = (pending || []).filter(p => String(p.jid || '').replace(/[^0-9]/g, '').startsWith(filter)).map(p => p.jid).slice(0, 5000);
            if (!targets.length) return sock.sendMessage(jid, { text: `📭 No pending requests from country code *${filter}*.` }, { quoted: msg });

            const meta = await sock.groupMetadata(jid).catch(() => null);
            const slots = 1024 - (meta?.participants?.length || 0);
            if (slots <= 0) return sock.sendMessage(jid, { text: '🚫 Group is full (1024/1024). Cannot accept anyone.' }, { quoted: msg });

            const statusMsg = await sock.sendMessage(jid, {
                text: `⏳ Accepting requests from +${filter}...\n👥 Slots available: *${slots}* / 1024`
            }, { quoted: msg });

            const { done, stopped, full } = await smartAcceptBatch(jid, targets);
            await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});

            const suffix = full ? '\n🚫 Group is now full (1024/1024). Remaining requests left pending.' : stopped ? '\n🛑 Stopped early.' : '';
            return sock.sendMessage(jid, { text: `✅ Accepted *${done}* from +${filter}.${suffix}` }, { quoted: msg });
        }

        // ── REJECT (specific user OR country code filter) ─────────────────────
        // .reject @user          → reject that specific user's request
        // .reject 234            → reject only requests from country code 234
        if (cmd === '.reject') {
            const filter = String(args[0] || '').replace(/[^0-9]/g, '');
            const isCcFilter = filter && filter.length <= 4 && !mentioned;

            if (!isCcFilter && !mentioned) {
                return sock.sendMessage(jid, {
                    text: '❌ Usage:\n• `.reject @user` — reject specific request\n• `.reject 234` — reject all requests from country code 234'
                }, { quoted: msg });
            }

            if (!isCcFilter) {
                try {
                    await sock.groupRequestParticipantsUpdate(jid, [mentioned], 'reject');
                    return sock.sendMessage(jid, { text: `🚫 Rejected @${mentioned.split('@')[0]}.`, mentions: [mentioned] }, { quoted: msg });
                } catch (e) {
                    return sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }, { quoted: msg });
                }
            }

            let pending;
            try { pending = await sock.groupRequestParticipantsList(jid); } catch (e) {
                return sock.sendMessage(jid, { text: `❌ Could not fetch requests: ${e.message}` }, { quoted: msg });
            }
            const targets = (pending || []).filter(p => String(p.jid || '').replace(/[^0-9]/g, '').startsWith(filter)).map(p => p.jid).slice(0, 5000);
            if (!targets.length) return sock.sendMessage(jid, { text: `📭 No pending requests from country code *${filter}*.` }, { quoted: msg });

            if (!global._reqStop) global._reqStop = new Set();
            global._reqStop.delete(jid);
            const statusMsg = await sock.sendMessage(jid, { text: `⏳ Rejecting *${targets.length}* request(s) from +${filter}...` }, { quoted: msg });
            const BATCH = 20; let done = 0;
            for (let i = 0; i < targets.length; i += BATCH) {
                if (global._reqStop.has(jid)) break;
                await sock.groupRequestParticipantsUpdate(jid, targets.slice(i, i + BATCH), 'reject').catch(() => {});
                done += Math.min(BATCH, targets.length - i);
                if (targets.length > BATCH) await new Promise(r => setTimeout(r, 1500));
            }
            await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
            return sock.sendMessage(jid, { text: `🚫 Rejected *${done}* request(s) from +${filter}.` }, { quoted: msg });
        }

        // ── ACCEPTALL / REJECTALL ─────────────────────────────────────────────
        // .acceptall             → accept ALL pending requests
        // .acceptall 234         → accept ONLY requests from +234
        // .rejectall             → reject ALL pending requests
        // .rejectall 234         → reject ONLY requests from +234
        if (cmd === '.acceptall' || cmd === '.rejectall') {
            const action = cmd === '.acceptall' ? 'approve' : 'reject';
            const ccFilter = String(args[0] || '').replace(/[^0-9]/g, '');
            const hasCcFilter = ccFilter && ccFilter.length <= 4;

            let pending;
            try {
                pending = await sock.groupRequestParticipantsList(jid);
            } catch (e) {
                return sock.sendMessage(jid, { text: `❌ Could not fetch pending requests: ${e.message}` }, { quoted: msg });
            }

            if (!pending?.length) return sock.sendMessage(jid, { text: '📭 No pending join requests.' }, { quoted: msg });

            // Filter: if cc given, accept/reject ONLY that country code
            let targets = pending.map(p => p.jid).filter(Boolean);
            if (hasCcFilter) {
                targets = targets.filter(j => String(j).replace(/[^0-9]/g, '').startsWith(ccFilter));
            }
            targets = targets.slice(0, 5000);

            const note = hasCcFilter ? ` from +${ccFilter}` : '';

            if (!targets.length) return sock.sendMessage(jid, {
                text: `📭 No pending requests${hasCcFilter ? ` from +${ccFilter}` : ''}.`
            }, { quoted: msg });

            if (!global._reqStop) global._reqStop = new Set();
            global._reqStop.delete(jid);

            // ACCEPT — capacity-aware
            if (action === 'approve') {
                const meta = await sock.groupMetadata(jid).catch(() => null);
                const currentCount = meta?.participants?.length || 0;
                const slots = 1024 - currentCount;

                if (slots <= 0) return sock.sendMessage(jid, {
                    text: '🚫 Group is full (1024/1024). Cannot accept anyone.'
                }, { quoted: msg });

                const willAccept = Math.min(targets.length, slots);
                const statusMsg = await sock.sendMessage(jid, {
                    text: `⏳ Accepting *${willAccept}* request(s)${note}...\n👥 Members: *${currentCount}* / 1024 (${slots} slots free)`
                }, { quoted: msg });

                const { done, stopped, full } = await smartAcceptBatch(jid, targets);
                await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});

                const suffix = full ? '\n🚫 Group is now full (1024/1024). Remaining requests left pending.'
                    : stopped ? '\n🛑 Stopped early.' : '';
                return sock.sendMessage(jid, {
                    text: `✅ Accepted *${done}* request(s)${note}.${suffix}`
                }, { quoted: msg });
            }

            // REJECT — no capacity concern
            const statusMsg = await sock.sendMessage(jid, {
                text: `⏳ Rejecting *${targets.length}* request(s)${note}...`
            }, { quoted: msg });

            const BATCH = 20; let done = 0;
            for (let i = 0; i < targets.length; i += BATCH) {
                if (global._reqStop.has(jid)) break;
                await sock.groupRequestParticipantsUpdate(jid, targets.slice(i, i + BATCH), 'reject').catch(() => {});
                done += Math.min(BATCH, targets.length - i);
                if (targets.length > BATCH) await new Promise(r => setTimeout(r, 1500));
            }
            const stopped = global._reqStop.has(jid);
            global._reqStop.delete(jid);
            await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
            return sock.sendMessage(jid, {
                text: `${stopped ? '🛑 Stopped early.' : '✅'} *${done}* request(s) rejected${note}.`
            }, { quoted: msg });
        }

        // ── GROUP SETTINGS ────────────────────────────────────────────────────
        if (cmd === '.groupsettings') {
            const g = group;
            return sock.sendMessage(jid, {
                text: `⚙️ *GROUP PROTECTION SETTINGS*\n\n` +
                    `🔗 Antilink: ${g.antilink ? '✅' : '🔴'} [${g.antilinkAction}]\n` +
                    `🤖 Antibot: ${g.antibot ? '✅' : '🔴'} [${g.antibotAction}]\n` +
                    `📢 Anti-GM: ${g.antigm ? '✅' : '🔴'} [${g.antigmAction}]\n` +
                    `💬 Antispam: ${g.antispam ? '✅' : '🔴'} [${g.antispamAction}]\n` +
                    `📡 Antichannel: ${g.antichannel ? '✅' : '🔴'} [${g.antichannelAction}]\n` +
                    `📸 AntiGStatus: ${g.antigstatus ? '✅' : '🔴'} [${g.antigstatusAction || 'kick'}]\n` +
                    `🛡️ AntiDemote: ${g.antidemote ? '✅' : '🔴'} [${String(g.antidemoteMode || 'protected')}]\n` +
                    `⚠️ Max Warns: ${g.maxWarns || 3}\n\n` +
                    `_Use .setaction <feature> <kick|warn|delete> to change actions_`
            }, { quoted: msg });
        }

        // ── SET GROUP PFP (admin) ─────────────────────────────────────────────
        if (cmd === '.setgrppfp') {
            const gate = guardGroupMetadataMutation({ jid, command: cmd, action: 'profile-picture' });
            if (!gate.ok) {
                const waitSec = Math.max(1, Math.ceil(Number(gate.waitMs || 0) / 1000));
                return sock.sendMessage(jid, { text: gate.reason === 'cooldown' ? `⏳ Group metadata cooldown active. Retry in ${waitSec}s.` : '⚠️ Group metadata guard blocked this action.' }, { quoted: msg });
            }
            const quotedImg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage
                || msg.message?.imageMessage;
            if (!quotedImg) return sock.sendMessage(jid, { text: '❌ Reply to or send an image to set as group photo.' }, { quoted: msg });
            try {
                const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                const imgMsg = msg.message?.imageMessage
                    ? msg
                    : { key: msg.key, message: msg.message?.extendedTextMessage?.contextInfo?.quotedMessage };
                const raw = await downloadMediaMessage(imgMsg, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage });
                // Get real dimensions so WA doesn't crop to square
                const sharp = require('sharp');
                const meta = await sharp(raw).metadata();
                const w = Math.min(meta.width || 640, 1280);
                const h = Math.min(meta.height || 640, 1280);
                await sock.updateProfilePicture(jid, raw, { width: w, height: h });
                return sock.sendMessage(jid, { text: '✅ Group photo updated!' }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }, { quoted: msg });
            }
        }

        // ── TAG — tag all members in the group ─────────────────────────────────
        if (cmd === '.tag') {
            try {
                const meta = await getCachedGroupMeta(sock, jid);
                const members = meta.participants.map(p => p.id);
                const message = args.join(' ').trim();
                
                // Extract preview from CURRENT message (when user types .tag with link and preview loads)
                const currentMessageExtended = msg.message?.extendedTextMessage;
                const currentMessageContextInfo = currentMessageExtended?.contextInfo;
                
                // Extract preview from QUOTED message (when user replies to a message)
                const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const quotedStanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
                
                // Check if current message has a link preview
                const hasCurrentPreview = currentMessageContextInfo?.externalAdReply || currentMessageExtended?.matchedText;
                
                // Priority: Use relayMessage to preserve exact structure
                if (hasCurrentPreview && !message) {
                    const ext = currentMessageExtended;
                    const { generateWAMessageFromContent } = require('gifted-baileys');
                    const builtMsg = generateWAMessageFromContent(jid, {
                        extendedTextMessage: { ...ext, contextInfo: { ...(ext.contextInfo || {}), mentionedJid: members } }
                    }, { userJid: sock.user.id });
                    await sock.relayMessage(jid, builtMsg.message, { messageId: builtMsg.key.id });
                    return;
                } else if (hasCurrentPreview && message) {
                    const ext = currentMessageExtended;
                    const { generateWAMessageFromContent } = require('gifted-baileys');
                    const builtMsg = generateWAMessageFromContent(jid, {
                        extendedTextMessage: { ...ext, text: message, contextInfo: { ...(ext.contextInfo || {}), mentionedJid: members } }
                    }, { userJid: sock.user.id });
                    await sock.relayMessage(jid, builtMsg.message, { messageId: builtMsg.key.id });
                    return;
                }

                // Replied to a message with a link preview
                if (quotedMessage?.extendedTextMessage) {
                    const ext = quotedMessage.extendedTextMessage;
                    const sendText = message || ext.text || '📢';
                    const targetUrl = ext.matchedText || ext.canonicalUrl || ext['matched-text'] || '';

                    if (targetUrl) {
                        const { generateWAMessageFromContent } = require('gifted-baileys');
                        const builtMsg = generateWAMessageFromContent(jid, {
                            extendedTextMessage: { ...ext, text: sendText, contextInfo: { ...(ext.contextInfo || {}), mentionedJid: members } }
                        }, { userJid: sock.user.id });
                        await sock.relayMessage(jid, builtMsg.message, { messageId: builtMsg.key.id });
                        return;
                    }
                    return sock.sendMessage(jid, { text: sendText, mentions: members });
                }

                // Replied to any other message — forward with mentions
                if (quotedMessage && quotedStanzaId) {
                    await sock.sendMessage(jid, {
                        forward: { key: { remoteJid: jid, fromMe: false, id: quotedStanzaId }, message: quotedMessage },
                        contextInfo: { mentionedJid: members }
                    });
                    if (message) await sock.sendMessage(jid, { text: message, mentions: members });
                    return;
                }

                // Plain tag with optional message or URL
                const sendText = message || '📢 *Group Announcement*';
                const { buildLinkPreview, extractUrls } = require('../core/linkPreview');
                const urls = extractUrls(sendText);
                if (urls.length) {
                    const preview = await buildLinkPreview(sendText, false).catch(() => null);
                    if (preview?.externalAdReply) {
                        preview.externalAdReply.renderLargerThumbnail = true;
                        return sock.sendMessage(jid, {
                            text: sendText,
                            mentions: members,
                            contextInfo: { ...preview, mentionedJid: members },
                        });
                    }
                }
                return sock.sendMessage(jid, { text: sendText, mentions: members });

            } catch (e) {
                if (e.message.includes('rate-overlimit')) {
                    return sock.sendMessage(jid, { text: '⏳ *Rate Limited*\nWait 30 seconds before using this command again.' });
                }
                return sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` });
            }
        }

        // ── SET BOT ACC PFP (owner only) ──────────────────────────────────────
        if (cmd === '.setmypfp' || cmd === '.setpfp') {
            const quotedImg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage
                || msg.message?.imageMessage;
            if (!quotedImg) return sock.sendMessage(jid, { text: '❌ Reply to or send an image to set as bot profile photo.' }, { quoted: msg });
            try {
                const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                const imgMsg = msg.message?.imageMessage
                    ? msg
                    : { key: msg.key, message: msg.message?.extendedTextMessage?.contextInfo?.quotedMessage };
                const raw = await downloadMediaMessage(imgMsg, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage });
                // Get real dimensions so WA doesn't crop to square
                const sharp = require('sharp');
                const meta = await sharp(raw).metadata();
                const w = Math.min(meta.width || 640, 1280);
                const h = Math.min(meta.height || 640, 1280);
                const botJid = `${botId}@s.whatsapp.net`;
                await sock.updateProfilePicture(botJid, raw, { width: w, height: h });
                return sock.sendMessage(jid, { text: '✅ Bot profile photo updated!' }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }, { quoted: msg });
            }
        }

        // ── SET ACCOUNT DISPLAY NAME (owner only) ────────────────────────────
        if (cmd === '.setname') {
            const newName = args.join(' ').trim();
            if (!newName) return sock.sendMessage(jid, { text: '❌ Usage: .setname <new name>' }, { quoted: msg });
            try {
                await sock.updateProfileName(newName);
                return sock.sendMessage(jid, { text: `✅ Account name updated to: *${newName}*` }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `❌ Failed to update name: ${e.message}` }, { quoted: msg });
            }
        }

        // ── DELETE PFP (owner only) ───────────────────────────────────────────
        if (cmd === '.delpfp') {
            try {
                const target = mentioned || `${botId}@s.whatsapp.net`;
                await sock.removeProfilePicture(target);
                return sock.sendMessage(jid, { text: '✅ Profile photo removed.' }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` }, { quoted: msg });
            }
        }

        // ── FULL PFP — fetch full uncropped profile picture ───────────────────
        if (cmd === '.fullpfp') {
            const target = mentioned
                || msg.message?.extendedTextMessage?.contextInfo?.participant
                || msg.key.remoteJid;
            try {
                const ppUrl = await sock.profilePictureUrl(target, 'image');
                const axios = require('axios');
                const res   = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 10000 });
                const buffer = Buffer.from(res.data);
                const name = target.split('@')[0];
                return sock.sendMessage(jid, {
                    image:   buffer,
                    caption: `🖼️ *Full Profile Picture*\n📱 +${name}`,
                    // jpegThumbnail not set — sends full uncropped image
                }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `❌ Could not fetch profile picture.\n${e.message}` }, { quoted: msg });
            }
        }
    }
};
