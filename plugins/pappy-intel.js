// plugins/pappy-intel.js
'use strict';

const fs   = require('fs');
const path = require('path');
const { ownerTelegramId } = require('../config');
const logger  = require('../core/logger');
const eventBus = require('../core/eventBus');
const {
    STATUS,
    DEAD_STATUSES,
    validateGroupLink,
    validateBatch,
    startValidator,
    getValidatorSummary,
    getActiveLinks,
    getJoinableCodes,
    getDeadLinks,
    getValidatorEntry,
    hasValidatorEntry,
    markLinkActive,
    markLinkDead,
    restoreLinkToActive,
    purgeDeadLink,
    validateBatchAndAssign,
    retestDeadLinksWithNode,
    validateAndAssign,
    recordJoinOutcome,
    classifyJoinError,
    addNewCode,
    setValidationNode,
    getValidationNode,
    resolveValidationSock,
    isNodePaused,
    deduplicateIntelDb,
} = require('../core/linkValidator');
const Intel = require('../core/models/Intel');

const dbPath = path.join(__dirname, '../data/intel.json');

const LIMITS = {
    MAX_JOINS_PER_DAY: Math.max(5, Number(process.env.INTEL_MAX_JOINS_PER_DAY || 60)),
    MIN_COOLDOWN_MS:   Math.max(30000, Number(process.env.INTEL_MIN_COOLDOWN_MS || 120000)),
    MAX_COOLDOWN_MS:   Math.max(60000, Number(process.env.INTEL_MAX_COOLDOWN_MS || 300000)),
    REALTIME_MIN_INTERVAL_MS: Math.max(60000, Number(process.env.INTEL_REALTIME_MIN_INTERVAL_MS || 180000)),
    REALTIME_MAX_PER_HOUR: Math.max(1, Number(process.env.INTEL_REALTIME_MAX_PER_HOUR || 8)),
    MAX_CONSECUTIVE_FAILS: Math.max(2, Number(process.env.INTEL_MAX_CONSECUTIVE_FAILS || 6)),
    MAX_RATE_LIMIT_HITS: Math.max(1, Number(process.env.INTEL_MAX_RATE_LIMIT_HITS || 2)),
    EMERGENCY_PAUSE_MS: Math.max(10 * 60 * 1000, Number(process.env.INTEL_EMERGENCY_PAUSE_MS || (6 * 60 * 60 * 1000))),
};

let intelCache = {
    knownLinks:        [],
    pendingQueue:      [],
    groupLinks:        {},        // NEW: groupJid -> [ { code, validatedAt, status } ]
    botJoinState:      {},        // botKey -> { dailyJoins, lastJoinDate, lastJoinTimestamp }
    dailyJoins:        0,
    lastJoinDate:      new Date().toISOString().split('T')[0],
    lastJoinTimestamp: 0,
    autoJoinEnabled:   false,
    autoJoinBotId:     null,
    autoJoinStartedAt: 0,
    realtimeAutoJoin:  false,
    emergencyPauseUntil: 0,
    realtimeWindowStart: 0,
    realtimeWindowCount: 0,
    consecutiveFails: 0,
    rateLimitHits: 0,
};

const _processingByBot = new Map();

function normalizeEntry(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') return { code: entry.trim(), botId: null, queuedAt: 0 };
    const code = String(entry.code || entry.inviteCode || '').trim();
    return code
        ? {
            code,
            botId: entry.botId ? String(entry.botId).trim() : null,
            queuedAt: Number(entry.queuedAt) || 0,
        }
        : null;
}

function hasCode(code) {
    const normalized = String(code || '').trim();
    if (!normalized) return false;
    if (hasValidatorEntry(normalized)) return true;
    return intelCache.knownLinks.includes(normalized) ||
           intelCache.pendingQueue.some(e => normalizeEntry(e)?.code === normalized);
}

function resolveSock(botId) {
    const id = String(botId || '').trim();
    if (id && global.waSockByBotId?.has(id)) return global.waSockByBotId.get(id);
    if (id && global.waSocks) {
        for (const [k, s] of global.waSocks.entries()) {
            if (k.includes(id) && s?.user) return s;
        }
    }
    // fallback — any connected socket
    if (global.waSocks) {
        for (const s of global.waSocks.values()) {
            if (s?.user) return s;
        }
    }
    return null;
}

// Helper: Escape HTML for telegram messages
function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function saveState() {
    try { await fs.promises.writeFile(dbPath, JSON.stringify(intelCache, null, 2)); } catch {}
}

async function upsertSharedIntel(code, patch = {}) {
    const normalizedCode = String(code || '').trim();
    if (!normalizedCode) return;
    const base = {
        code: normalizedCode,
        linkCode: normalizedCode,
        seenAt: new Date(),
    };
    await Intel.findOneAndUpdate(
        { $or: [{ code: normalizedCode }, { linkCode: normalizedCode }] },
        { $set: { ...base, ...patch }, $setOnInsert: { dateAdded: new Date() } },
        { upsert: true, new: true }
    ).catch(() => {});
}

function getBotQueueKey(botId) {
    return String(botId || intelCache.autoJoinBotId || 'global').trim() || 'global';
}

// NEW: Save extracted link to group links mapping with validation
function addGroupLink(groupJid, code) {
    // Routes through addNewCode — enforces global dedup, enters INTAKE pipeline
    if (!groupJid || !code) return false;
    const jid = String(groupJid).trim();
    const c = String(code).trim();

    // Track in groupLinks map for context (which group this link came from)
    if (!intelCache.groupLinks[jid]) intelCache.groupLinks[jid] = [];
    const existing = intelCache.groupLinks[jid].find(l => l.code === c);
    if (existing) {
        existing.seenAt = Date.now();
        // Still try addNewCode in case it wasn't in validator yet
        addNewCode(c, { source: 'wa_group_scrape', groupJid: jid, scrapedAt: Date.now() });
        return false;
    }

    // Add to groupLinks map
    intelCache.groupLinks[jid].push({ code: c, seenAt: Date.now(), status: STATUS.INTAKE });

    // Route through validator pipeline — addNewCode handles dedup globally
    const outcome = addNewCode(c, { source: 'wa_group_scrape', groupJid: jid, scrapedAt: Date.now() });
    if (outcome === 'added') {
        logger.info(`[INTEL] New link ${c} from group ${jid} → INTAKE`);
        saveState().catch(() => {});
        return true;
    }
    return false;
}

// NEW: Cleanup invalid links from group
async function cleanupGroupInvalidLinks(groupJid, sock = null) {
    if (!groupJid) return 0;
    const jid = String(groupJid).trim();
    const links = intelCache.groupLinks[jid];
    if (!Array.isArray(links)) return 0;
    
    let removed = 0;
    const codesToCheck = links.map(l => l.code);
    const { valid } = await validateBatch(codesToCheck, sock).catch(() => ({ valid: [] }));
    
    const newLinks = [];
    for (const link of links) {
        const keep = valid.includes(link.code);
        if (!keep) {
            removed++;
            const deadCode = String(link.code || '').trim();
            if (deadCode) {
                await markLinkDead(deadCode, {
                    source: 'cleanupGroupInvalidLinks',
                    groupJid: jid,
                    validatedAt: new Date(),
                }).catch(() => {});
            }
        } else {
            newLinks.push(link);
        }
    }
    
    if (removed > 0) {
        intelCache.groupLinks[jid] = newLinks;
        await saveState();
        logger.info(`[INTEL] Cleaned ${removed} invalid link(s) from ${jid}`);
    }
    return removed;
}

async function initDb() {
    try {
        if (fs.existsSync(dbPath)) {
            const d = JSON.parse(await fs.promises.readFile(dbPath, 'utf8'));
            intelCache = { ...intelCache, ...d };
            intelCache.pendingQueue = (intelCache.pendingQueue || []).map(normalizeEntry).filter(Boolean);
            intelCache.knownLinks   = intelCache.knownLinks || [];
            intelCache.groupLinks   = intelCache.groupLinks || {};
        }
    } catch {}
}

async function validatePendingQueueAfterLoad() {
    const entries = (intelCache.pendingQueue || []).map(normalizeEntry).filter(Boolean);
    if (!entries.length) return;

    // Route existing pendingQueue entries through the validator intake (do not join from pendingQueue)
    for (const entry of entries) {
        try {
            addNewCode(entry.code, { source: 'pending_queue_migration', queuedAt: entry.queuedAt || Date.now(), botId: entry.botId || null });
        } catch (e) {}
    }
    // clear legacy pendingQueue — validator takes over
    intelCache.pendingQueue = [];
    await saveState().catch(() => {});
}

initDb();
setImmediate(() => {
    validatePendingQueueAfterLoad().catch(() => {});
});

async function syncLegacyIntelCacheToMongo() {
    const codes = Array.isArray(intelCache.knownLinks) ? intelCache.knownLinks : [];
    if (!codes.length) return;
    let synced = 0;
    for (const raw of codes) {
        const code = String(raw || '').trim();
        if (!code) continue;
        await upsertSharedIntel(code, {
            status: 'valid',
            source: 'legacy_intel_json',
            seenAt: new Date(),
        });
        synced++;
    }
    if (synced > 0) {
        logger.info(`[INTEL] Synced ${synced} legacy intel.json links to shared Mongo Intel`);
    }
}

setImmediate(() => {
    syncLegacyIntelCacheToMongo().catch(() => {});
});

// React to validator commits so the join engine's caches stay in sync immediately
eventBus.on('validator.commit', async ({ code, outcome, bucket }) => {
    try {
        if (!code) return;
        const c = String(code).trim();

        // Remove from knownLinks if it moved to dead
        if (bucket === 'dead') {
            intelCache.knownLinks = (intelCache.knownLinks || []).filter(x => String(x || '') !== c);
        }

        // Remove from pendingQueue so we don't try to join a link that was just classified dead
        if (Array.isArray(intelCache.pendingQueue)) {
            intelCache.pendingQueue = intelCache.pendingQueue.filter(e => {
                const cc = normalizeEntry(e)?.code;
                return cc && String(cc) !== c;
            });
        }

        // Remove from any groupLinks mapping
        if (intelCache.groupLinks && typeof intelCache.groupLinks === 'object') {
            for (const jid of Object.keys(intelCache.groupLinks)) {
                const arr = intelCache.groupLinks[jid] || [];
                const filtered = arr.filter(l => String(l?.code || '') !== c);
                if (filtered.length !== arr.length) intelCache.groupLinks[jid] = filtered;
            }
        }

        // Persist intel.json state quickly
        await saveState().catch(() => {});
        logger.info(`[INTEL] Validator commit synced: ${c} → ${bucket || outcome}`);
    } catch (err) {
        logger.warn(`[INTEL] Failed handling validator.commit: ${err.message}`);
    }
});

// Start link validator on initialization
setImmediate(() => {
    try {
        startValidator();
    } catch (err) {
        logger.warn(`[INTEL] Failed to start link validator: ${err.message}`);
    }
});

// Listen for socket open to set up group join handlers
eventBus.on('socket.open', (sock) => {
    if (!sock || !sock.ev) return;

    const botId = sock.user?.id?.split(':')[0] || '';

    // When bot joins a group — fetch its invite link and add to Main for validation
    sock.ev.on('group-participants.update', async ({ id, action, participants }) => {
        try {
            if (!id || !participants?.length || action !== 'add') return;
            const isBot = botId && participants.some(p => String(p).includes(botId));
            if (!isBot) return;

            logger.success(`[INTEL] Bot joined group ${id}`);

            // Fetch invite link and ingest into Main DB
            setTimeout(async () => {
                try {
                    const code = await sock.groupInviteCode(id).catch(() => null);
                    if (code) {
                        const result = addNewCode(code, { source: 'group_join_scrape', groupJid: id, botId, scrapedAt: Date.now() });
                        if (result === 'added') logger.info(`[INTEL] Group join scraped ${code} → Main`);
                    }
                } catch {}
            }, 3000);

            // Telegram notification
            if (global.tgBot && ownerTelegramId) {
                const meta = await sock.groupMetadata(id).catch(() => null);
                const groupName = meta?.subject || id;
                const memberCount = meta?.participants?.length || '?';
                global.tgBot.telegram.sendMessage(
                    ownerTelegramId,
                    `🎉 <b>GROUP JOIN SUCCESSFUL</b>\n\n` +
                    `👥 <b>${escapeHtml(groupName)}</b>\n` +
                    `📱 Members: ${memberCount}\n` +
                    `🆔 <code>${id}</code>`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
            }
        } catch (err) {
            logger.warn(`[INTEL] group-participants.update error: ${err.message}`);
        }
    });

    // Passive scraper — always on, no toggle needed
    // Catches any WA invite link seen in any message on this node
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of (messages || [])) {
            try {
                const text = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || msg.message?.imageMessage?.caption
                    || msg.message?.videoMessage?.caption
                    || '';
                if (!text?.includes('chat.whatsapp.com')) continue;
                const matches = text.match(/chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/ig) || [];
                for (const m of matches) {
                    const code = m.split('chat.whatsapp.com/')[1];
                    if (code) addNewCode(code, { source: 'passive_scrape', botId, groupJid: msg.key?.remoteJid || null, scrapedAt: Date.now() });
                }
            } catch {}
        }
    });
});

function checkDailyReset() {
    const today = new Date().toISOString().split('T')[0];
    if (intelCache.lastJoinDate !== today) {
        intelCache.lastJoinDate = today;
        intelCache.dailyJoins   = 0;
        intelCache.botJoinState = {};
        intelCache.realtimeWindowStart = 0;
        intelCache.realtimeWindowCount = 0;
        intelCache.consecutiveFails = 0;
        intelCache.rateLimitHits = 0;
        saveState();
    }
}

function inEmergencyPause() {
    return Number(intelCache.emergencyPauseUntil || 0) > Date.now();
}

function triggerEmergencyPause(reason) {
    intelCache.emergencyPauseUntil = Date.now() + LIMITS.EMERGENCY_PAUSE_MS;
    intelCache.realtimeAutoJoin = false;
    saveState();
    logger.warn(`[INTEL] Emergency pause activated: ${reason}`);
    if (global.tgBot && ownerTelegramId) {
        const mins = Math.ceil(LIMITS.EMERGENCY_PAUSE_MS / 60000);
        global.tgBot.telegram.sendMessage(
            ownerTelegramId,
            `🛑 <b>INTEL AUTOJOIN SAFETY PAUSE</b>\n\nReason: <code>${escapeHtml(reason)}</code>\nPause: <b>${mins} min</b>\nRealtime mode: <b>OFF</b>`,
            { parse_mode: 'HTML' }
        ).catch(() => {});
    }
}

function canUseRealtimeJoin() {
    checkDailyReset();
    if (!intelCache.autoJoinEnabled || !intelCache.realtimeAutoJoin) return false;
    if (inEmergencyPause()) return false;
    if (intelCache.dailyJoins >= LIMITS.MAX_JOINS_PER_DAY) return false;

    const now = Date.now();
    const lastTs = Number(intelCache.lastJoinTimestamp || 0);
    if (now - lastTs < LIMITS.REALTIME_MIN_INTERVAL_MS) return false;

    const hourMs = 60 * 60 * 1000;
    const wStart = Number(intelCache.realtimeWindowStart || 0);
    if (!wStart || (now - wStart) >= hourMs) {
        intelCache.realtimeWindowStart = now;
        intelCache.realtimeWindowCount = 0;
    }
    if (Number(intelCache.realtimeWindowCount || 0) >= LIMITS.REALTIME_MAX_PER_HOUR) return false;
    return true;
}

function getBotJoinState(botKey) {
    const key = getBotQueueKey(botKey);
    if (!intelCache.botJoinState || typeof intelCache.botJoinState !== 'object') {
        intelCache.botJoinState = {};
    }
    if (!intelCache.botJoinState[key]) {
        intelCache.botJoinState[key] = {
            dailyJoins: 0,
            lastJoinDate: new Date().toISOString().split('T')[0],
            lastJoinTimestamp: 0,
        };
    }

    const state = intelCache.botJoinState[key];
    const today = new Date().toISOString().split('T')[0];
    if (state.lastJoinDate !== today) {
        state.lastJoinDate = today;
        state.dailyJoins = 0;
        state.lastJoinTimestamp = 0;
    }

    return state;
}

// ── Scraper: intercept invite links from any message ─────────────────────────
let _linkQueueNotificationThrottle = {};

// ── Passive link scraper (always on, no toggle) ──────────────────────────────
// Catches every WA invite link seen in any message on any node → Main DB
let _notifThrottle = 0;
eventBus.on('message.upsert', ({ msg, text, botId }) => {
    if (!text?.includes('chat.whatsapp.com')) return;
    const matches = text.match(/chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/ig) || [];
    const groupJid = msg?.key?.remoteJid || null;
    const nodeId   = String(botId || '').trim() || null;
    let added = 0;
    for (const m of matches) {
        const code = m.split('chat.whatsapp.com/')[1];
        const r = addNewCode(code, { source: 'passive_scrape', botId: nodeId, groupJid, scrapedAt: Date.now() });
        if (r === 'added') { added++; if (groupJid) addGroupLink(groupJid, code); }
    }
    if (added > 0) {
        saveState().catch(() => {});
        const now = Date.now();
        if (now - _notifThrottle > 60000 && global.tgBot && ownerTelegramId) {
            _notifThrottle = now;
            const s = getValidatorSummary();
            global.tgBot.telegram.sendMessage(ownerTelegramId,
                `📡 <b>Link Collector</b>\n\nNew: <b>${added}</b>\n📥 Main: <b>${s.intake}</b>  ✅ Live: <b>${s.active}</b>`,
                { parse_mode: 'HTML' }).catch(() => {});
        }
    }
});

// ── Auto-joiner daemon ────────────────────────────────────────────
// DISABLED: Join Intel (Telegram menu) is now the primary join system.
// processQueue is kept for reference but the interval is not started.
// To re-enable, uncomment the setInterval below.
async function processQueue(botId = null) {
    // Disabled — use Join Intel from Telegram node menu instead
    return;
}

// ── Commands ──────────────────────────────────────────────────────────────────
module.exports = {
    category: 'INTEL',
    commands: [
        { cmd: '.autojoin',    role: 'owner' },
        { cmd: '.joinqueue',   role: 'owner' },
        { cmd: '.intelclean',  role: 'owner' },
        { cmd: '.validnode',   role: 'owner' },
        { cmd: '.validstatus', role: 'owner' },
    ],

    execute: async ({ sock, msg, args, text, botId }) => {
        const jid = msg.key.remoteJid;
        const cmd = text.split(' ')[0].toLowerCase();

        // ── .autojoin ──────────────────────────────────────────────────────────
        if (cmd === '.autojoin') {
            const action = args[0]?.toLowerCase();
            const sub = args[1]?.toLowerCase();

            if (action === 'realtime') {
                if (sub !== 'on' && sub !== 'off') {
                    return sock.sendMessage(jid, { text: '⚙️ Usage: .autojoin realtime on/off' }, { quoted: msg });
                }
                intelCache.realtimeAutoJoin = sub === 'on';
                saveState();
                return sock.sendMessage(jid, {
                    text: `⚙️ Realtime Auto-Join: ${intelCache.realtimeAutoJoin ? 'ON ⚡' : 'OFF 🧯'}\nRecommended: OFF for anti-ban safety.`
                }, { quoted: msg });
            }

            if (action === 'on' || action === 'off') {
                intelCache.autoJoinEnabled = action === 'on';
                intelCache.autoJoinBotId = intelCache.autoJoinEnabled
                    ? String(botId || sock?.user?.id?.split(':')[0] || '').trim() || null
                    : null;
                intelCache.realtimeAutoJoin = false;
                if (intelCache.autoJoinEnabled) {
                    intelCache.autoJoinStartedAt = Date.now();
                    intelCache.pendingQueue = [];
                }
                saveState();
                return sock.sendMessage(jid, {
                    text: `📡 *AUTO-JOIN:* ${intelCache.autoJoinEnabled ? 'ENGAGED 🟢' : 'OFFLINE 🔴'}\n⚡ Real-time join: ${intelCache.realtimeAutoJoin ? 'ON' : 'OFF'}\n📋 Queue: ${intelCache.pendingQueue.length} links`
                }, { quoted: msg });
            }

            return sock.sendMessage(jid, {
                text: `⚙️ Auto-Join: ${intelCache.autoJoinEnabled ? 'ENGAGED 🟢' : 'OFFLINE 🔴'}\nUsage:\n• .autojoin on/off\n• .autojoin realtime on/off`
            }, { quoted: msg });
        }

        // ── .joinqueue ─────────────────────────────────────────────────────────
        if (cmd === '.joinqueue') {
            checkDailyReset();
            const preview = intelCache.pendingQueue.slice(0, 5)
                .map((e, i) => `${i + 1}. ${normalizeEntry(e)?.code || '?'}`)
                .join('\n') || '_Empty_';
            let totalStoredLinks = 0;
            for (const links of Object.values(intelCache.groupLinks || {})) {
                totalStoredLinks += Array.isArray(links) ? links.length : 0;
            }
            const summary = getValidatorSummary();
            return sock.sendMessage(jid, {
                text: `📡 *INTEL QUEUE*\n\n` +
                      `⏳ Pending: *${intelCache.pendingQueue.length}*\n` +
                      `💾 Stored links: *${totalStoredLinks}* across groups\n` +
                      `✅ Joined today: *${intelCache.dailyJoins}/${LIMITS.MAX_JOINS_PER_DAY}*\n` +
                      `⚙️ Status: ${intelCache.autoJoinEnabled ? 'ENGAGED 🟢' : 'OFFLINE 🔴'}\n` +
                      `🔗 Validator active: *${summary.active}* | dead: *${summary.dead}*\n\n` +
                      `*Next up:*\n${preview}\n\n` +
                      `Use *.intelclean* to dedup & clean dead links`
            }, { quoted: msg });
        }

        // ── .intelclean ────────────────────────────────────────────────────────
        if (cmd === '.intelclean') {
            try {
                await sock.sendMessage(jid, { text: `🔍 *Deduplicating & cleaning intel DB...*` }, { quoted: msg });

                // Step 1: dedup intel.json
                const { deduped } = await deduplicateIntelDb().catch(() => ({ deduped: 0 }));

                // Step 2: retest dead links with metadata pre-screen
                const deadRetest = await retestDeadLinksWithNode(sock).catch(() => []);
                const restored = deadRetest.filter(i => i.restored).length;
                const stillDead = deadRetest.filter(i => !i.restored).length;

                const summary = getValidatorSummary();

                return sock.sendMessage(jid, {
                    text: `✅ *INTEL CLEANED*\n\n` +
                          `🧽 Duplicates removed: *${deduped}*\n` +
                          `🔄 Dead links retested: *${deadRetest.length}*\n` +
                          `♻️ Restored to active: *${restored}*\n` +
                          `🛑 Still dead: *${stillDead}*\n\n` +
                          `📊 Validator: *${summary.active}* active | *${summary.dead}* dead`
                }, { quoted: msg });
            } catch (err) {
                return sock.sendMessage(jid, { text: `❌ Cleanup failed: ${err.message}` }, { quoted: msg });
            }
        }

        // ── .validnode ─────────────────────────────────────────────────────────
        // Assign a specific node as the validation node (ban risk isolation)
        if (cmd === '.validnode') {
            const sub = args[0]?.toLowerCase();

            if (sub === 'set') {
                // Use the current node (the one that received this command)
                const nodeId = String(sock.user?.id?.split(':')[0] || botId || '');
                if (!nodeId) return sock.sendMessage(jid, { text: '❌ Could not determine node ID.' }, { quoted: msg });
                setValidationNode(nodeId);
                return sock.sendMessage(jid, {
                    text: `🔗 *Validation node set to:* +${nodeId}\n\nThis node will be used for join-based validation.\nBan risk is now isolated to this node.`
                }, { quoted: msg });
            }

            if (sub === 'clear') {
                setValidationNode(null);
                return sock.sendMessage(jid, { text: '✅ Validation node cleared. Any connected node will be used.' }, { quoted: msg });
            }

            const current = getValidationNode();
            return sock.sendMessage(jid, {
                text: `🔗 *Validation Node*\n\n` +
                      `Current: *${current ? '+' + current : 'auto (any node)'}*\n\n` +
                      `Usage:\n• *.validnode set* — assign this node\n• *.validnode clear* — use any node`
            }, { quoted: msg });
        }

        // ── .validstatus ───────────────────────────────────────────────────────
        // Full validator status report
        if (cmd === '.validstatus') {
            const summary = getValidatorSummary();
            const byStatus = Object.entries(summary.byStatus || {})
                .map(([s, n]) => `  ${s}: ${n}`)
                .join('\n') || '  (none)';
            const paused = summary.pausedNodes.length
                ? summary.pausedNodes.map(n => `  +${n.id} (resumes in ${n.resumesIn})`).join('\n')
                : '  none';

            checkDailyReset();
            return sock.sendMessage(jid, {
                text: `📊 *VALIDATOR STATUS*\n\n` +
                      `🔗 Validation node: *${summary.validationNode}*\n` +
                      `✅ Active links: *${summary.active}*\n` +
                      `🛑 Dead links: *${summary.dead}*\n\n` +
                      `*Status breakdown:*\n${byStatus}\n\n` +
                      `*Flood-paused nodes:*\n${paused}\n\n` +
                      `*Auto-join:* ${intelCache.autoJoinEnabled ? 'ON 🟢' : 'OFF 🔴'}\n` +
                      `*Joined today:* ${intelCache.dailyJoins}/${LIMITS.MAX_JOINS_PER_DAY}\n` +
                      `*Consecutive fails:* ${intelCache.consecutiveFails}\n` +
                      `*Emergency pause:* ${inEmergencyPause() ? '🛑 ACTIVE' : '✅ clear'}`
            }, { quoted: msg });
        }
    }
};
