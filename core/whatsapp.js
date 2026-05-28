0// core/whatsapp.js
// Ω ELITE CONNECTION MANAGER & EVENT-DRIVEN PROTOCOL

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    DisconnectReason,
    delay,
    Browsers
} = require('gifted-baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const { ownerTelegramId, ownerWhatsAppJids, globalPrefix } = require('../config');
const ownerManager = require('../modules/ownerManager');
const logger = require('./logger');
const engine = require('./engine');
const aiController = require('./aiController');
const runtimeFlags = require('./runtimeFlags');
const { sendPremiumText } = require('./responseEngine');
const { rememberPreviewHint } = require('./linkPreview');
const { getYoutubeCookieArg } = require('./youtube');
const { generateAnimatedSticker, generateTelegramSticker } = require('./stickerEngine');
const { getKernel } = require('./runtimeKernel');
const watchdog = require('./watchdog');

const SESSIONS_PATH = path.join(__dirname, '../data/sessions');
const STATE_FILE = path.join(__dirname, '../data/botState.json');
const BANNED_ACCOUNTS_FILE = path.join(__dirname, '../data/wa-banned-accounts.json');

// Track 403 bans persistently across restarts with exponential backoff
let bannedAccounts = {};

function loadBannedAccounts() {
    fs.promises.readFile(BANNED_ACCOUNTS_FILE, 'utf8')
        .then((raw) => {
            try {
                bannedAccounts = JSON.parse(raw || '{}');
            } catch (e) {
                logger.warn('Failed to load banned accounts list', { error: e.message });
                bannedAccounts = {};
            }
        })
        .catch(() => { bannedAccounts = {}; });
}

function saveBannedAccounts() {
    fs.promises.mkdir(path.dirname(BANNED_ACCOUNTS_FILE), { recursive: true })
        .then(() => fs.promises.writeFile(BANNED_ACCOUNTS_FILE, JSON.stringify(bannedAccounts, null, 2), 'utf8'))
        .catch((e) => logger.warn('Failed to save banned accounts list', { error: e.message }));
}

function recordForbidden(phoneNumber) {
    const phone = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (!phone) return;
    const entry = bannedAccounts[phone] || { firstSeenAt: Date.now(), failureCount: 0, lastFailureAt: Date.now() };
    entry.failureCount = (entry.failureCount || 0) + 1;
    entry.lastFailureAt = Date.now();
    bannedAccounts[phone] = entry;
    saveBannedAccounts();
    logger.warn(`[Ban Tracker] Phone +${phone} recorded 403 failure #${entry.failureCount}`);
}

function isBannedOrBackingOff(phoneNumber) {
    const phone = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (!phone || !bannedAccounts[phone]) return false;
    
    const entry = bannedAccounts[phone];
    const failCount = entry.failureCount || 1;
    // Exponential backoff: 1min, 5min, 15min, 30min, 1hr, 4hr, 24hr
    const backoffMins = [1, 5, 15, 30, 60, 240, 1440];
    const backoffMs = backoffMins[Math.min(failCount - 1, backoffMins.length - 1)] * 60 * 1000;
    const timeSinceLastFailure = Date.now() - (entry.lastFailureAt || 0);
    
    return timeSinceLastFailure < backoffMs;
}

function getBackoffStatus(phoneNumber) {
    const phone = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (!phone || !bannedAccounts[phone]) return null;
    
    const entry = bannedAccounts[phone];
    const failCount = entry.failureCount || 1;
    const backoffMins = [1, 5, 15, 30, 60, 240, 1440];
    const backoffMs = backoffMins[Math.min(failCount - 1, backoffMins.length - 1)] * 60 * 1000;
    const timeSinceLastFailure = Date.now() - (entry.lastFailureAt || 0);
    const msRemaining = Math.max(0, backoffMs - timeSinceLastFailure);
    const minsRemaining = Math.ceil(msRemaining / 60000);
    
    return {
        failureCount: failCount,
        backoffMinutes: backoffMins[Math.min(failCount - 1, backoffMins.length - 1)],
        minutesRemaining: minsRemaining,
        canRetry: msRemaining <= 0
    };
}

function clearBanRecord(phoneNumber) {
    const phone = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (phone && bannedAccounts[phone]) {
        delete bannedAccounts[phone];
        saveBannedAccounts();
        logger.info(`[Ban Tracker] Cleared ban record for +${phone}`);
    }
}

// Purge node-specific artifacts for a phone number (keeps shared link Intel untouched)
function purgeNodeArtifacts(phoneNumber, reason = 'unknown') {
    const phone = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (!phone) return;

    (async () => {
        try {
            const dataDir = path.join(__dirname, '../data');

            // Remove per-node state files
            const exactFiles = [
                getNodeStateFile(phone),
                getNodeStickerCmdsFile(phone),
                path.join(dataDir, `warmup-config-${phone}.json`),
            ];
            await Promise.all(exactFiles.map((fp) => fs.promises.unlink(fp).catch(() => {})));

            // Remove warmup media files for this phone with any extension
            try {
                const names = await fs.promises.readdir(dataDir).catch(() => []);
                const warmupFiles = names.filter((name) => name.startsWith(`warmup-media-${phone}.`));
                await Promise.all(warmupFiles.map((name) => fs.promises.unlink(path.join(dataDir, name)).catch(() => {})));
            } catch {}

            // Remove all session folders for this phone across all slots/chats
            try {
                const sessionDirs = await fs.promises.readdir(SESSIONS_PATH).catch(() => []);
                const matches = sessionDirs.filter((name) => name.includes(`_${phone}_`));
                await Promise.all(matches.map((sessionName) => fs.promises.rm(path.join(SESSIONS_PATH, sessionName), { recursive: true, force: true }).catch(() => {})));
            } catch {}

            // Remove in-memory node state and caches for this phone
            try { nodeStates.delete(phone); } catch {}
            try { clearBanRecord(phone); } catch {}
            try {
                if (global._aiQueues) {
                    for (const key of Array.from(global._aiQueues.keys())) {
                        if (String(key).includes(`_${phone}_`)) global._aiQueues.delete(key);
                    }
                }
            } catch {}

            logger.system(`[Purge] Node +${phone} artifacts removed (${reason}) — link Intel preserved.`);
        } catch (err) {
            logger.warn(`[Purge] Failed to purge node +${phone}`, { error: err.message, reason });
        }
    })();
}

// Per-node state file — scoped by phone number so each node has isolated state
function getNodeStateFile(phone) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!digits) return STATE_FILE;
    return path.join(__dirname, `../data/botState-${digits}.json`);
}

function getNodeStickerCmdsFile(phone) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!digits) return path.join(__dirname, '../data/stickerCmds.json');
    return path.join(__dirname, `../data/stickerCmds-${digits}.json`);
}

const activeSockets = new Map();
const kernel = getKernel({ logger, engine });
if (!global.waSockByBotId) global.waSockByBotId = new Map();
// ─── GROUP METADATA CACHE (prevents WA 429 rate-limit errors) ───────────────
const groupCache = require('./groupCache');
const FORBIDDEN_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const forbiddenAlertCache = new Map(); // sessionKey -> timestamp
const forbiddenAlertPhoneCache = new Map(); // phone -> timestamp
const MAX_PEER_SESSION_FILES = 500;

// Track decrypt failures per session — auto-prune signal files when they spike
const _decryptFailCount = new Map();
const _decryptPruneThrottle = new Map();
const HEARTBEAT_IDLE_MS = Number(process.env.WA_HEARTBEAT_IDLE_MS || 1200000); // 20min — gives godcast time to finish
const HEARTBEAT_INTERVAL_MS = Number(process.env.WA_HEARTBEAT_INTERVAL_MS || 30000);
const AI_MAX_QUEUE_SIZE = Number(process.env.WA_AI_MAX_QUEUE_SIZE || 6);
const AI_USER_COOLDOWN_MS = Number(process.env.WA_AI_USER_COOLDOWN_MS || 5000);

function trackDecryptFailure(sessionKey, sessionDir) {
    const count = (_decryptFailCount.get(sessionKey) || 0) + 1;
    _decryptFailCount.set(sessionKey, count);

    // After 10 failures, prune stale signal files — but throttle to once per 2 min
    if (count >= 10) {
        _decryptFailCount.set(sessionKey, 0);
        const lastPrune = _decryptPruneThrottle.get(sessionKey) || 0;
        if (Date.now() - lastPrune < 2 * 60 * 1000) return;
        _decryptPruneThrottle.set(sessionKey, Date.now());

        setImmediate(() => {
            (async () => {
                try {
                    const names = await fs.promises.readdir(sessionDir).catch(() => []);
                    const files = await Promise.all(
                        names
                            .filter((f) => f.startsWith('session-') || f.startsWith('sender-key-'))
                            .map(async (f) => ({ f, mt: (await fs.promises.stat(path.join(sessionDir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs }))
                    );
                    files.sort((a, b) => b.mt - a.mt);
                    if (files.length <= 1500) return;
                    await Promise.all(files.slice(1500).map(({ f }) => fs.promises.unlink(path.join(sessionDir, f)).catch(() => {})));
                    logger.info(`[WA] Auto-pruned ${files.length - 1500} stale signal files for ${sessionKey} (decrypt spike)`);
                } catch {}
            })();
        });
    }
}

function prunePeerSessions(sessionDir, maxFiles = MAX_PEER_SESSION_FILES) {
    (async () => {
        try {
            const sessionFiles = (await fs.promises.readdir(sessionDir).catch(() => []))
                .filter((name) => name.startsWith('session-') && name.endsWith('.json'))
                .map((name) => {
                    const fullPath = path.join(sessionDir, name);
                    return fs.promises.stat(fullPath).then((stat) => ({ name, fullPath, mtimeMs: stat.mtimeMs })).catch(() => ({ name, fullPath, mtimeMs: 0 }));
                });
            const resolved = (await Promise.all(sessionFiles)).sort((a, b) => b.mtimeMs - a.mtimeMs);

            if (resolved.length <= maxFiles) return;
            const toDelete = resolved.slice(maxFiles);
            await Promise.all(toDelete.map((entry) => fs.promises.unlink(entry.fullPath).catch(() => {})));

            logger.warn(`[WA] Pruned peer sessions in ${path.basename(sessionDir)}: ${resolved.length} -> ${maxFiles}`);
        } catch (err) {
            logger.warn(`[WA] Failed to prune peer sessions: ${err.message}`);
        }
    })();
}

function getCachedAdminStatus(sock, jid, sender) {
    // Fast path: check cache immediately
    const isAdmin = groupCache.isAdmin(jid, sender, sock);
    
    // Background refresh: if socket is healthy AND cache miss/expired, warm up async
    if (!isAdmin && sock && jid && !jid.includes('@s.us')) {
        setImmediate(() => {
            groupCache.getGroupMeta(sock, jid).catch(() => {});
        });
    }
    
    return isAdmin;
}

function refreshGroupMeta(sock, jid) {
    if (!global._groupMetaRefreshThrottle) global._groupMetaRefreshThrottle = new Map();
    const botId = String(sock?.user?.id?.split(':')[0] || 'global');
    const key = `${botId}:${String(jid || '')}`;
    const now = Date.now();
    const state = global._groupMetaRefreshThrottle.get(key) || { lastAt: 0, inflight: false };

    // Avoid repeatedly fetching the same group metadata when the group is very active.
    // A stale cache is fine here; it only affects admin-status freshness, not message delivery.
    if (state.inflight || (now - state.lastAt) < 5 * 60 * 1000) return;

    state.inflight = true;
    state.lastAt = now;
    global._groupMetaRefreshThrottle.set(key, state);

    setImmediate(() => {
        groupCache.getGroupMeta(sock, jid)
            .catch(() => {})
            .finally(() => {
                state.inflight = false;
                state.lastAt = Date.now();
                global._groupMetaRefreshThrottle.set(key, state);
            });
    });
}

async function getCachedGroupMeta(sock, jid) {
    return groupCache.getGroupMeta(sock, jid);
}

async function resolveSongPollSelections(pollUpdate, cachedPoll) {
    const selectedHashes = pollUpdate?.vote?.selectedOptions || [];
    const pollOptions = cachedPoll?.message?.pollCreationMessageV3?.options || cachedPoll?.message?.pollCreationMessage?.options || [];
    if (!pollOptions.length) return [];

    try {
        const { getAggregateVotesInPollMessage } = require('gifted-baileys');
        const pollMessage = cachedPoll?.message;
        const encKey = pollMessage?.pollCreationMessageV3?.encKey || pollMessage?.pollCreationMessage?.encKey;
        if (pollMessage && encKey) {
            const votes = await getAggregateVotesInPollMessage({
                message: pollMessage,
                pollUpdates: [pollUpdate],
            }, encKey);
            const names = (votes || [])
                .filter((v) => Array.isArray(v?.voters) && v.voters.length > 0)
                .map((v) => String(v?.name || '').trim())
                .filter(Boolean);
            if (names.length) return names;
        }
    } catch {}

    if (!selectedHashes.length) return [];

    const crypto = require('crypto');
    const selectedNames = [];
    for (const option of pollOptions) {
        const optionName = String(option?.optionName || option?.name || '').trim();
        if (!optionName) continue;
        const optionHash = crypto.createHash('sha256').update(Buffer.from(optionName)).digest();
        const matches = selectedHashes.some((hash) => {
            const hashBuf = Buffer.isBuffer(hash) ? hash : Buffer.from(String(hash), 'base64');
            return hashBuf.equals(optionHash);
        });
        if (matches) selectedNames.push(optionName);
    }

    return selectedNames;
}

async function handleSongPollSelection(sock, groupJid, pollCreationId, selectedNames) {
    if (!groupJid || !pollCreationId || !selectedNames.length) return false;

    if (!global._handledSongPollVotes) global._handledSongPollVotes = new Set();
    const dedupKey = `${groupJid}:${pollCreationId}:${selectedNames.join('|')}`;
    if (global._handledSongPollVotes.has(dedupKey)) return true;
    global._handledSongPollVotes.add(dedupKey);
    setTimeout(() => global._handledSongPollVotes?.delete(dedupKey), 5 * 60 * 1000);

    const votedText = selectedNames.join(' ');
    const songTitle = String(selectedNames[0] || votedText).replace(/\s*\[.*?\]\s*$/, '').trim();
    if (!songTitle) return false;

    let cachedResult = null;

    const normalizedSelections = selectedNames
        .map((name) => String(name || '').replace(/\s*\[.*?\]\s*$/, '').trim().toLowerCase())
        .filter(Boolean);

    const pollLookup = global._songPollLookup?.get(pollCreationId);
    if (pollLookup?.jid === groupJid) {
        for (const sel of normalizedSelections) {
            const mapped = pollLookup.optionMap?.[sel];
            if (mapped?.videoId) {
                cachedResult = mapped;
                break;
            }
        }
    }

    if (global._songSearchCache?.size) {
        for (const [token, entry] of global._songSearchCache.entries()) {
            if (entry.jid !== groupJid) continue;
            const idx = entry.results.findIndex((r) => {
                const titleNorm = String(r?.title || '').replace(/\s*\[.*?\]\s*$/, '').trim().toLowerCase();
                const votedNorm = String(votedText || '').replace(/\s*\[.*?\]\s*$/, '').trim().toLowerCase();
                const ref = titleNorm.slice(0, 40);
                return titleNorm === votedNorm || votedNorm.includes(ref) || ref.includes(votedNorm.slice(0, 40));
            });
            if (idx === -1) continue;
            cachedResult = entry.results[idx];
            global._songSearchCache.delete(token);
            break;
        }
    }

    const statusMsg = await sock.sendMessage(groupJid, {
        text: `⏳ Got it! Downloading *${songTitle}*...\n🎵 Sending shortly`
    });

    try {
        const { downloadAudio, searchYoutube } = require('./youtube');

        let baseResult = cachedResult;
        if (!baseResult?.videoId) {
            const fresh = await searchYoutube(songTitle, 1);
            baseResult = fresh?.[0] || null;
        }
        if (!baseResult?.videoId) throw new Error('No result found for selected song');

        const candidates = [baseResult];
        try {
            const more = await searchYoutube(songTitle || baseResult.title || '', 5);
            for (const c of (more || [])) {
                if (!c?.videoId) continue;
                if (!candidates.some((x) => x?.videoId === c.videoId)) candidates.push(c);
            }
        } catch {}

        let dl = null;
        let picked = baseResult;
        let lastErr;
        for (const c of candidates) {
            if (!c?.videoId) continue;
            try {
                dl = await downloadAudio(c.videoId);
                picked = c;
                break;
            } catch (err) {
                lastErr = err;
            }
        }
        if (!dl) throw (lastErr || new Error('No downloadable candidate'));

        const ext = dl.fileExt || 'm4a';
        const mimetype = dl.mimetype || 'audio/mp4';
        const safeName = String(picked.title || songTitle || 'track').replace(/[\\/:*?"<>|]/g, '').slice(0, 80) || 'track';
        await sock.sendMessage(groupJid, {
            audio: dl.buffer,
            mimetype,
            ptt: false,
            fileName: `${safeName}.${ext}`
        });
        await sock.sendMessage(groupJid, { delete: statusMsg.key }).catch(() => {});
        return true;
    } catch (e) {
        await sock.sendMessage(groupJid, { text: `❌ Download failed: ${e.message.slice(0, 100)}` });
        await sock.sendMessage(groupJid, { delete: statusMsg.key }).catch(() => {});
        return false;
    }
}

// 🧠 SaaS Fix: Expose this globally so bullEngine.js can find the sockets!
global.waSocks = activeSockets; 

// Per-node botState map: phone -> state object
const nodeStates = new Map();
// Global botState kept for backward compat (sleep, autoPair) — general owner only
let botState = { isSleeping: false, autoPairEnabled: false, pappyMode: {}, commandPrefix: globalPrefix };
if (!global.messageCache) global.messageCache = new Map();
if (!global._senderMsgIndex) global._senderMsgIndex = new Map();

if (!global._senderIndexCleanupStarted) {
    global._senderIndexCleanupStarted = true;
    // Clean stale sender index entries every 5 min
    setInterval(() => {
        if (!global._senderMsgIndex) return;
        for (const [key, ids] of global._senderMsgIndex.entries()) {
            for (const id of ids) {
                if (!global.messageCache?.has(id)) ids.delete(id);
            }
            if (ids.size === 0) global._senderMsgIndex.delete(key);
        }
    }, 5 * 60 * 1000).unref();

    // Scheduled signal file cleanup every 6 hours
    setInterval(() => {
        (async () => {
            try {
                const sessionsPath = path.join(__dirname, '../data/sessions');
                const dirs = await fs.promises.readdir(sessionsPath).catch(() => []);
                for (const d of dirs) {
                    const dir = path.join(sessionsPath, d);
                    try { if (!(await fs.promises.stat(dir)).isDirectory()) continue; } catch { continue; }
                    const files = await fs.promises.readdir(dir).catch(() => []);
                    const signalFiles = files.filter((f) => f.startsWith('session-') || f.startsWith('sender-key-'));
                    if (signalFiles.length <= 3000) continue;
                    const sorted = (await Promise.all(signalFiles.map(async (f) => ({ f, mt: (await fs.promises.stat(path.join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs }))))
                        .sort((a, b) => b.mt - a.mt);
                    await Promise.all(sorted.slice(3000).map(({ f }) => fs.promises.unlink(path.join(dir, f)).catch(() => {})));
                    logger.warn(`[WA] Scheduled prune: removed ${sorted.length - 3000} signal files from ${d}`);
                }
            } catch {}
        })();
    }, 6 * 60 * 60 * 1000).unref();
}
if (!global._aiReplyCache) global._aiReplyCache = new Map();
if (!global.stickerCache) global.stickerCache = new Map();
const MAX_MESSAGE_CACHE_SIZE = 10000; // reduced — 20k was too much RAM for active accounts

// Periodic cache GC — runs every 3 min, evicts oldest 20% when over limit
// This is far cheaper than evicting on every single message insert
if (!global._msgCacheGcStarted) {
    global._msgCacheGcStarted = true;
    setInterval(() => {
        if (!global.messageCache) return;
        if (global.messageCache.size <= MAX_MESSAGE_CACHE_SIZE) return;
        const evict = Math.floor(MAX_MESSAGE_CACHE_SIZE * 0.2);
        let i = 0;
        for (const key of global.messageCache.keys()) {
            if (i++ >= evict) break;
            global.messageCache.delete(key);
        }
    }, 3 * 60 * 1000).unref();
}

// ─── AI QUEUE & DEDUP (prevents duplicate AI calls per message) ────────────────
const fastq = require('fastq');
// Per-message dedup — ignore same msgId within 5s
const _aiMsgDedup = new Set();
// Global AI worker queue — processes one AI request at a time per bot session
if (!global._aiQueues) global._aiQueues = new Map();

function getAiQueue(sessionKey) {
    if (!global._aiQueues.has(sessionKey)) {
        // concurrency=1 per node — AI calls are heavy, never run more than 1 at a time
        // This prevents AI from starving command processing
        const q = fastq.promise(async (task) => {
            try { await task(); } catch {}
        }, 1);
        global._aiQueues.set(sessionKey, q);
    }
    return global._aiQueues.get(sessionKey);
}

function canAiReply(msgId) {
    // Dedup only — skip if same message already queued within 5s
    if (_aiMsgDedup.has(msgId)) return false;
    _aiMsgDedup.add(msgId);
    setTimeout(() => _aiMsgDedup.delete(msgId), 5000);
    return true;
}

function stopSocketHeartbeat(sessionKey) {
    if (!global._waHeartbeatTimers) global._waHeartbeatTimers = new Map();
    const timer = global._waHeartbeatTimers.get(sessionKey);
    if (timer) {
        clearInterval(timer);
        global._waHeartbeatTimers.delete(sessionKey);
    }
}

function bindSocketLiveness(sessionKey, sock) {
    if (!global._waWsLivenessHandlers) global._waWsLivenessHandlers = new Map();
    const ws = sock?.ws;
    if (!ws || typeof ws.on !== 'function') return;

    const touch = () => {
        if (!global._lastEventActivity) global._lastEventActivity = new Map();
        global._lastEventActivity.set(sessionKey, Date.now());
    };
    const onMessage = () => touch();
    const onPong = () => {
        sock._lastPongAt = Date.now();
        touch();
    };

    try {
        ws.on('message', onMessage);
        ws.on('pong', onPong);
        global._waWsLivenessHandlers.set(sessionKey, { ws, onMessage, onPong });
        sock._lastPongAt = Date.now();
        touch();
    } catch {}
}

function unbindSocketLiveness(sessionKey) {
    if (!global._waWsLivenessHandlers) return;
    const entry = global._waWsLivenessHandlers.get(sessionKey);
    if (!entry) return;

    try {
        entry.ws?.removeListener?.('message', entry.onMessage);
        entry.ws?.removeListener?.('pong', entry.onPong);
    } catch {}

    global._waWsLivenessHandlers.delete(sessionKey);
}

function startSocketHeartbeat(sessionKey, sock, reconnectFn) {
    if (!global._waHeartbeatTimers) global._waHeartbeatTimers = new Map();
    stopSocketHeartbeat(sessionKey);

    const timer = setInterval(() => {
        try {
            const liveSock = activeSockets.get(sessionKey);
            if (!liveSock || liveSock !== sock) return;

            const lastMsg = Number(global._lastMsgActivity?.get(sessionKey) || 0);
            const lastEvt = Number(global._lastEventActivity?.get(sessionKey) || 0);
            const last = Math.max(lastMsg, lastEvt, Number(sock._openedAt || 0));
            const idleMs = Date.now() - (last || Date.now());
            const sincePong = Date.now() - Number(sock._lastPongAt || 0);

            try { liveSock.ws?.ping?.(); } catch {}

            // Treat as zombie only if both event activity and pong responses are stale.
            if (
                idleMs > HEARTBEAT_IDLE_MS &&
                sincePong > (HEARTBEAT_INTERVAL_MS * 3) &&
                liveSock?.user &&
                liveSock.ws?.readyState === 1
            ) {
                logger.warn(`[Heartbeat] Zombie socket suspected for ${sessionKey} (idle ${Math.round(idleMs / 1000)}s) — refreshing socket`);
                try { liveSock.ev?.removeAllListeners?.(); } catch {}
                try { liveSock.ws?.close?.(); } catch {}
                stopSocketHeartbeat(sessionKey);
                reconnectFn();
            }
        } catch (err) {
            logger.warn(`[Heartbeat] ${sessionKey} check failed: ${err.message}`);
        }
    }, HEARTBEAT_INTERVAL_MS);

    timer.unref?.();
    global._waHeartbeatTimers.set(sessionKey, timer);
}

function teardownSocket(sessionKey, sock, reason = 'unknown') {
    if (global._groupInvalidateQueues?.has(sessionKey)) {
        const state = global._groupInvalidateQueues.get(sessionKey);
        if (state?.timer) clearTimeout(state.timer);
        global._groupInvalidateQueues.delete(sessionKey);
    }
    try { sock?.ev?.removeAllListeners?.(); } catch {}
    try { sock?.ws?.close?.(); } catch {}
    unbindSocketLiveness(sessionKey);
    stopSocketHeartbeat(sessionKey);
    kernel.presenceManager.stop(sessionKey);
    unbindSocketAliases(sock);
    activeSockets.delete(sessionKey);
    kernel.socketManager.remove(sessionKey);
    logger.info(`[WA] Socket teardown complete for ${sessionKey} (${reason})`);
}

function getNodeState(phone) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!digits) return botState;
    if (!nodeStates.has(digits)) nodeStates.set(digits, { isSleeping: false, pappyMode: {}, commandPrefix: globalPrefix, nodeMode: 'public' });
    return nodeStates.get(digits);
}

function saveNodeState(phone) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!digits) return;
    const state = nodeStates.get(digits);
    if (!state) return;
    fs.promises.writeFile(getNodeStateFile(digits), JSON.stringify(state)).catch(() => {});
}

function bindSocketAliases(sock, aliases = []) {
    if (!sock || !global.waSockByBotId) return;
    for (const alias of aliases) {
        const key = String(alias || '').trim();
        if (key) global.waSockByBotId.set(key, sock);
    }
}

function unbindSocketAliases(sock) {
    if (!sock || !global.waSockByBotId) return;
    for (const [key, value] of global.waSockByBotId.entries()) {
        if (value === sock) global.waSockByBotId.delete(key);
    }
}

const STICKER_CACHE_DIR = path.join(__dirname, '../data/sticker_cache');
const STICKER_CMDS_FILE = path.join(__dirname, '../data/stickerCmds.json');
let YT_DLP_BIN = 'yt-dlp';
fs.promises.access('/usr/local/bin/yt-dlp').then(() => { YT_DLP_BIN = '/usr/local/bin/yt-dlp'; }).catch(() => {});

async function refreshStickerCmdCache() {
    try {
        const raw = await fs.promises.readFile(STICKER_CMDS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        global._stickerCmdsCache = (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
        global._stickerCmdsCache = global._stickerCmdsCache || {};
    }
}

fs.promises.mkdir(STICKER_CACHE_DIR, { recursive: true }).catch(() => {});
fs.promises.mkdir(SESSIONS_PATH, { recursive: true }).catch(() => {});
fs.promises.mkdir(path.join(__dirname, '../data'), { recursive: true }).catch(() => {});
refreshStickerCmdCache().catch(() => {});
setInterval(() => refreshStickerCmdCache().catch(() => {}), 30000).unref();

const loadState = () => {
    fs.promises.readFile(STATE_FILE, 'utf-8')
        .then((raw) => {
            try {
                const parsed = JSON.parse(raw);
                botState = { pappyMode: {}, autoPairEnabled: false, commandPrefix: globalPrefix, ...parsed };
            } catch {
                botState = { isSleeping: false, autoPairEnabled: false, pappyMode: {}, commandPrefix: globalPrefix };
            }
        })
        .catch(() => {});
};
const saveState = () => fs.promises.writeFile(STATE_FILE, JSON.stringify(botState)).catch(() => {});
loadState();
loadBannedAccounts();

async function preloadNodeStates() {
    try {
        const dataDir = path.join(__dirname, '../data');
        const entries = await fs.promises.readdir(dataDir);
        const files = entries.filter((name) => /^botState-\d+\.json$/i.test(name));
        await Promise.all(files.map(async (name) => {
            const phone = name.match(/^botState-(\d+)\.json$/i)?.[1];
            if (!phone || nodeStates.has(phone)) return;
            try {
                const raw = await fs.promises.readFile(path.join(dataDir, name), 'utf8');
                const parsed = JSON.parse(raw);
                nodeStates.set(phone, { isSleeping: false, pappyMode: {}, commandPrefix: globalPrefix, nodeMode: 'public', ...parsed });
            } catch {}
        }));
    } catch {}
}
preloadNodeStates().catch(() => {});

const ownerWaSet = new Set((ownerWhatsAppJids || []).map((j) => String(j || '').trim()).filter(Boolean));
const ownerWaDigits = new Set(Array.from(ownerWaSet).map((j) => String(j || '').replace(/[^0-9]/g, '')).filter(Boolean));

// Global owner check — only the general owner JIDs from config
const isGlobalOwnerJid = (jid) => {
    const raw = String(jid || '').trim();
    const norm = raw.replace(/:\d+(?=@)/g, '');
    const phone = norm.replace(/[^0-9]/g, '');
    return ownerWaSet.has(raw) || ownerWaSet.has(norm) || ownerWaDigits.has(phone);
};

// Session-scoped owner check — general owner OR the specific phone that owns this session
// nodePhone = the phone number of this bot session (e.g. '2348164167112')
const isOwnerJidForSession = (jid, nodePhone) => {
    if (isGlobalOwnerJid(jid)) return true;
    if (!nodePhone) return false;
    const raw = String(jid || '').trim();
    const norm = raw.replace(/:\d+(?=@)/g, '');
    const phone = norm.replace(/[^0-9]/g, '');
    const nodeDigits = String(nodePhone || '').replace(/[^0-9]/g, '');
    return phone === nodeDigits;
};

// Legacy global isOwnerJid — kept for backward compat but only checks general owner
const isOwnerJid = isGlobalOwnerJid;

function getCommandPrefix(phone) {
    const state = phone ? getNodeState(phone) : botState;
    const prefix = String(state.commandPrefix || '').trim();
    return prefix || globalPrefix;
}

function setCommandPrefix(prefix, phone) {
    const clean = String(prefix || '').trim();
    if (!clean || clean.length > 3 || /\s/.test(clean)) return false;
    if (phone) {
        const state = getNodeState(phone);
        state.commandPrefix = clean;
        saveNodeState(phone);
    } else {
        botState.commandPrefix = clean;
        saveState();
    }
    return true;
}

// Node mode: 'public' = anyone can use cmds, 'private' = only node owner + general owner
function getNodeMode(phone) {
    return getNodeState(phone).nodeMode || 'public';
}

function setNodeMode(phone, mode) {
    const state = getNodeState(phone);
    state.nodeMode = mode === 'private' ? 'private' : 'public';
    saveNodeState(phone);
}

function normalizeCommandText(text, phone) {
    const raw = String(text || '');

    // Strict policy mode: only period-prefixed commands are accepted.
    if (runtimeFlags.strictPeriodPrefix) {
        return raw.startsWith(globalPrefix) ? raw : null;
    }

    const activePrefix = getCommandPrefix(phone);
    // Always accept the global prefix '.' as well as the active prefix
    // This prevents a wrong prefix setting from silently breaking all commands
    if (raw.startsWith(activePrefix)) {
        if (activePrefix === globalPrefix) return raw;
        return `${globalPrefix}${raw.slice(activePrefix.length)}`;
    }
    if (activePrefix !== globalPrefix && raw.startsWith(globalPrefix)) {
        return raw; // accept '.' prefix even if active prefix is different
    }
    return null;
}

function resolveSenderJid(msg, fallbackBotJid) {
    if (!msg?.key) return fallbackBotJid;
    if (msg.key.fromMe) return fallbackBotJid;

    const fromKey = msg.key.participant
        || msg.key.participantPn
        || msg.message?.extendedTextMessage?.contextInfo?.participant
        || msg.message?.imageMessage?.contextInfo?.participant
        || msg.message?.videoMessage?.contextInfo?.participant
        || msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.participant
        || msg.message?.ephemeralMessage?.message?.imageMessage?.contextInfo?.participant
        || msg.message?.ephemeralMessage?.message?.videoMessage?.contextInfo?.participant
        || msg.key.remoteJid;

    return String(fromKey || '').trim();
}

// extractSender — used by kernel messageRouter dispatcher
function extractSender(msg) {
    if (!msg?.key) return '';
    if (msg.key.fromMe) return '';
    return String(
        msg.key.participant ||
        msg.key.participantPn ||
        msg.message?.extendedTextMessage?.contextInfo?.participant ||
        msg.key.remoteJid ||
        ''
    ).trim();
}

/**
 * Initializes and manages a WhatsApp connection node.
 */
function _tgSendDirect(chatId, text) {
    const https = require('https');
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${process.env.TG_BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.write(body);
    req.end();
}

async function startWhatsApp(chatId = ownerTelegramId, phoneNumber, slotId = '1', isRestart = false, retryCount = 0) {
    if (botState.isSleeping && !isRestart) return;

    // Check if account is in backoff period due to 403 bans (restart flows only)
    if (isRestart && isBannedOrBackingOff(phoneNumber)) {
        const backoffStatus = getBackoffStatus(phoneNumber);
        logger.info(`[Ban Backoff] Skipping +${phoneNumber} (failure #${backoffStatus.failureCount}, retry in ${backoffStatus.minutesRemaining}min)`);
        if (retryCount === 0) {
            _tgSendDirect(chatId, `⏳ <b>ACCOUNT IN RECOVERY</b>\nNode +${phoneNumber} is recovering from 403 ban.\n\n<b>Auto-retry in ${backoffStatus.minutesRemaining} minutes.</b>\n\nOr use /pair to re-link immediately.`);
        }
        return;
    }

    const sessionKey = `${chatId}_${phoneNumber}_${slotId}`;

    if (!global._kernelStarted) {
        global._kernelStarted = true;
        try { kernel.start(); } catch {}
    }

    if (!global._lastEventActivity) global._lastEventActivity = new Map();

    kernel.reconnectManager.setState(sessionKey, 'CONNECTING');
    if (activeSockets.has(sessionKey) && !isRestart) return;

    if (isRestart && activeSockets.has(sessionKey)) {
        const oldSock = activeSockets.get(sessionKey);
        if (oldSock) teardownSocket(sessionKey, oldSock, 'pre-reconnect-refresh');
    }

    const sessionDir = path.join(SESSIONS_PATH, sessionKey);
    // Do NOT prune before socket creation — deleting session files before connect
    // destroys signal keys needed for decryption, causing Bad MAC on all messages.
    // Pruning is handled after connection.update 'open' fires.
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    let { version } = await fetchLatestBaileysVersion();
    if (!version) version = [2, 3000, 1017531287];


    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),

        // ── FLOOD PROTECTION: never sync history, kills RAM spike on active accounts
        syncFullHistory: false,
        // ── Don't fetch all contacts/groups on connect — massive CPU/RAM saver
        shouldSyncHistoryMessage: () => false,
        // ── Skip status broadcast events entirely — they flood the event loop
        shouldIgnoreJid: (jid) => {
            const j = String(jid || '');
            // Drop broadcast list and status@broadcast — never commands, pure noise
            return j === 'status@broadcast' || j.endsWith('@broadcast');
        },
        // ── Don't generate high-quality previews inline — done async in bullEngine
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 2000,
        // ── Shorter query timeout prevents socket stalls on slow WA servers
        defaultQueryTimeoutMs: 20000,
        fireInitQueries: true,
        emitOwnEvents: true,
        transactionOpts: { maxCommitRetries: 5, delayBetweenTriesMs: 2000 },

        // ── getMessage: fast cache lookup — prevents BAD MAC on restart
        getMessage: async (key) => {
            if (global.messageCache && key?.id) {
                const cached = global.messageCache.get(key.id);
                if (cached?.message) return cached.message;
            }
            return { conversation: '' };
        },
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(message.buttonsMessage || message.templateMessage || message.listMessage);
            if (requiresPatch) {
                message = { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} }, ...message } } };
            }
            return message;
        }
    });

    kernel.socketManager.register(sessionKey, sock);

    // ─── PAIRING CODE GENERATION ───
    if (!sock?.authState?.creds?.registered && !isRestart) {
            // Clear ban record when user re-pairs — allow immediate reconnection
            clearBanRecord(phoneNumber);

        logger.system(`Initiating pairing sequence for +${phoneNumber}...`);

        let userLabel = 'papp-bot';
        if (global.tgBot && chatId) {
            try {
                const user = await global.tgBot.telegram.getChat(chatId);
                if (user && user.first_name) userLabel = user.first_name.replace(/[^a-zA-Z0-9_-]/g, '') || userLabel;
            } catch {}
        }

        const requestPairing = async () => {
            const cleanNumber = String(phoneNumber).replace(/[^0-9]/g, '');
            try {
                sock._pairingInProgress = true;
                sock._pairingRequestedAt = Date.now();
                await delay(1500);
                let code;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        code = await sock.requestPairingCode(cleanNumber);
                        break;
                    } catch (e) {
                        const shouldRetry = attempt < 3 && (
                            e?.output?.statusCode === 428 ||
                            String(e.message).includes('428') ||
                            String(e.message).includes('Connection Closed') ||
                            String(e.message).includes('Precondition') ||
                            String(e.message).includes('not-authorized')
                        );
                        if (shouldRetry) {
                            logger.warn(`[Pair] Attempt ${attempt} failed (${e.message}), retrying in 2s...`);
                            await delay(2000);
                        } else {
                            throw e;
                        }
                    }
                }
                logger.system(`PAIRING CODE FOR +${cleanNumber}: ${code}`);
                // Send via direct HTTP to bypass any Telegraf polling conflict
                const _tgSend = (text) => new Promise((resolve) => {
                    const https = require('https');
                    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
                    const req = https.request({
                        hostname: 'api.telegram.org',
                        path: `/bot${process.env.TG_BOT_TOKEN}/sendMessage`,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
                    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{const r=JSON.parse(d); if(!r.ok) logger.error(`[Pair] TG send failed: ${d}`);}catch{} resolve(); }); });
                    req.on('error', e => { logger.error(`[Pair] TG send error: ${e.message}`); resolve(); });
                    req.write(body); req.end();
                });
                await _tgSend(`🔗 <b>PAIRING CODE for <u>${userLabel}</u> (+${cleanNumber})</b>\n\n<code>${code}</code>\n\n<i>Enter this code in WhatsApp &gt; Linked Devices &gt; Link with phone number.</i>\n\n⏳ <b>Code expires in 60 seconds. Enter it quickly!</b>`);
                sock._pairingCodeSent = true;
                sock._pairingCodeSentAt = Date.now();
            } catch (err) {
                if (sock._pairingCodeSent) {
                    logger.info(`[Pair] Socket closed after code sent for +${cleanNumber} — normal`);
                    return;
                }
                const msg = String(err?.message || err);
                const transient = /connection closed|precondition|not-authorized|408|428/i.test(msg);
                const rounds = Number(sock._pairingRetryRounds || 0);
                if (transient && rounds < 2) {
                    sock._pairingRetryRounds = rounds + 1;
                    logger.warn(`[Pair] Transient pairing error (${msg}) — retry round ${sock._pairingRetryRounds}/2 in 4s...`);
                    setTimeout(requestPairing, 4000);
                    return;
                }
                logger.error(`Pairing code error: ${err.message}`);
                _tgSendDirect(chatId, `❌ <b>PAIRING FAILED</b>\nEnsure the number is correct and WhatsApp is installed.\nError: <code>${err.message}</code>\n\nTry /pair again.`);
            }
        };
        setTimeout(requestPairing, 500);
    }

    activeSockets.set(sessionKey, sock);
    bindSocketAliases(sock, [String(phoneNumber).replace(/[^0-9]/g, '')]);
    bindSocketLiveness(sessionKey, sock);
    try {
        watchdog.attach(sessionKey, sock, () => {
            kernel.reconnectManager.schedule(
                sessionKey,
                () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                'watchdog-zombie'
            );
        });
    } catch {}
    // Fix: Only setMaxListeners if available (Baileys update compatibility)
    if (typeof sock.ev.setMaxListeners === 'function') {
        sock.ev.setMaxListeners(20);
    }
    sock.ev.on('creds.update', saveCreds);

    // ─── CONNECTION HANDLING ───
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        global._lastEventActivity.set(sessionKey, Date.now());

        if (connection === 'close') {
            kernel.socketManager.setState(sessionKey, 'DISCONNECTED');
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errMsg = String(lastDisconnect?.error?.message || '').toLowerCase();
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const isBadMac = errMsg.includes('bad mac') || errMsg.includes('conflict') || statusCode === 401;
            const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
            const isForbidden = statusCode === 403;
            const isRateLimited = statusCode === 429;
            // 408=timeout, 440=connection lost, 503=unavailable — all safe to reconnect fast
            const isFastReconnect = statusCode === 408 || statusCode === 440 || statusCode === 503;

            activeSockets.delete(sessionKey);
            unbindSocketLiveness(sessionKey);
            stopSocketHeartbeat(sessionKey);
            kernel.presenceManager.stop(sessionKey);
            unbindSocketAliases(sock);
            try { watchdog.detach(sessionKey); } catch {}

            if (isLoggedOut) {
                logger.system(`🚨 LOGGED OUT — purging session ${sessionKey}`);
                purgeNodeArtifacts(phoneNumber, 'logged-out');
                const https = require('https');
                const _tgHttp = (text) => new Promise((resolve) => {
                    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
                    const req = https.request({ hostname: 'api.telegram.org', path: `/bot${process.env.TG_BOT_TOKEN}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); resolve(); });
                    req.on('error', () => resolve()); req.write(body); req.end();
                });
                _tgHttp(`🗑️ <b>SESSION PURGED</b>\nNode +${phoneNumber} was logged out and deleted. Re-pair to restore.`);
                return;
            }

            // 403 = WhatsApp banned/blocked the session — stop retrying, notify owner
            if (isForbidden) {
                logger.system(`🚫 FORBIDDEN (403) — purging node artifacts for ${sessionKey}. Re-pair required.`);
                purgeNodeArtifacts(phoneNumber, 'forbidden-403');
                const phoneKey = String(phoneNumber || '').replace(/[^0-9]/g, '');
                const alertKey = phoneKey || sessionKey;
                const lastAlertAt = Number(forbiddenAlertPhoneCache.get(alertKey) || forbiddenAlertCache.get(sessionKey) || 0);
                const shouldAlert = Date.now() - lastAlertAt > FORBIDDEN_ALERT_COOLDOWN_MS;
                if (shouldAlert) {
                    forbiddenAlertPhoneCache.set(alertKey, Date.now());
                    forbiddenAlertCache.set(sessionKey, Date.now());
                    _tgSendDirect(chatId, `🚫 <b>CONNECTION FORBIDDEN (403)</b>\nNode +${phoneNumber} was rejected by WhatsApp.\nThe account may be temporarily or permanently banned.\n\n🗑️ Node session/state files were purged.\n\nUse /pair to re-link this number.`);
                }
                return; // stop — no more retries
            }

            // 429 = rate limited — back off longer before retrying
            if (isRateLimited) {
                const rateLimitDelay = 5 * 60 * 1000;
                logger.system(`⏳ RATE LIMITED (429) — waiting 5 min before reconnecting ${sessionKey}...`);
                kernel.reconnectManager.schedule(
                    sessionKey,
                    () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                    { reason: 'rate-limit-429', delayMs: rateLimitDelay }
                );
                return;
            }

            // 408/440/503 — transient network issues, reconnect quickly
            if (isFastReconnect) {
                const fastDelay = 2000 + Math.floor(Math.random() * 1000);
                logger.system(`⚡ Fast reconnect (code ${statusCode}) for ${sessionKey} in ${fastDelay}ms`);
                kernel.reconnectManager.schedule(
                    sessionKey,
                    () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                    { reason: `fast-${statusCode}`, delayMs: fastDelay }
                );
                return;
            }

            if (isBadMac) {
                // Track bad MAC count per session in memory
                if (!global._badMacCount) global._badMacCount = new Map();
                const badMacCount = (global._badMacCount.get(sessionKey) || 0) + 1;
                global._badMacCount.set(sessionKey, badMacCount);

                logger.system(`⚠️ BAD MAC (${badMacCount}) for ${sessionKey}`);
                const dir = path.join(SESSIONS_PATH, sessionKey);

                // After 5 consecutive bad MACs — full wipe + notify, stop the loop
                if (badMacCount >= 5) {
                    global._badMacCount.delete(sessionKey);
                    logger.system(`🚨 BAD MAC loop — full wipe for ${sessionKey}, re-pair required`);
                    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
                    _tgSendDirect(chatId, `⚠️ <b>SESSION RESET</b>\nNode +${phoneNumber} hit repeated BAD MAC errors and was wiped.\nUse /pair to re-link.`);
                    return;
                }

                // First 2 bad MACs — just reconnect without wiping, might be a transient error
                if (badMacCount <= 2) {
                    const backoff = 10000 + Math.floor(Math.random() * 5000);
                    logger.system(`[WA] Soft reconnect for ${sessionKey} in ${Math.round(backoff/1000)}s (bad MAC ${badMacCount}/5)`);
                    kernel.reconnectManager.schedule(
                        sessionKey,
                        () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                        { reason: 'bad-mac-soft', delayMs: backoff }
                    );
                    return;
                }

                // 3rd-4th bad MAC — wipe signal files but keep creds + app-state
                try {
                    if (fs.existsSync(dir)) {
                        prunePeerSessions(dir, MAX_PEER_SESSION_FILES);
                        const files = fs.readdirSync(dir);
                        for (const f of files) {
                            if (f === 'creds.json' || f === 'connected.flag') continue;
                            if (f.startsWith('app-state')) continue;
                            try { fs.unlinkSync(path.join(dir, f)); } catch {}
                        }
                    }
                } catch {}

                if (global.messageCache) global.messageCache.clear();
                if (global._senderMsgIndex) global._senderMsgIndex.clear();

                const backoff = Math.min(20000 * Math.pow(2, badMacCount - 3), 60000) + Math.floor(Math.random() * 5000);
                logger.system(`[WA] Reconnecting ${sessionKey} in ${Math.round(backoff/1000)}s after signal wipe (bad MAC ${badMacCount}/5)`);
                kernel.reconnectManager.schedule(
                    sessionKey,
                    () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                    { reason: 'bad-mac-signal-wipe', delayMs: backoff }
                );
                return;
            }

            // Exponential backoff with jitter: 3s → 6s → 12s → … capped at 60s
            const baseDelay = isRestartRequired ? 1500 : 3000;
            const jitter = Math.floor(Math.random() * 1500);
            const reconnectDelay = Math.min(baseDelay * Math.pow(2, Math.min(retryCount, 4)), 60000) + jitter;
            logger.system(`Connection closed (code ${statusCode}). Reconnecting ${sessionKey} in ${Math.round(reconnectDelay / 1000)}s (attempt ${retryCount + 1})...`);
            kernel.reconnectManager.schedule(
                sessionKey,
                () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                `close-${statusCode || 'unknown'}`
            );
        }
        
        if (connection === 'open') {
            kernel.socketManager.setState(sessionKey, 'OPEN');
            kernel.reconnectManager.markOpen(sessionKey);
            sock._openedAt = Date.now();
            const connectedBotId = sock.user?.id?.split(':')[0];
            bindSocketAliases(sock, [connectedBotId, String(phoneNumber).replace(/[^0-9]/g, '')]);
            retryCount = 0;
            // Reset bad MAC counter on successful connect
            if (global._badMacCount) global._badMacCount.delete(sessionKey);
            logger.success(`🟩 WhatsApp Online → ${phoneNumber}`);

            // Auto-prune signal files — only on first connect per session, not on every reconnect
            if (!global._prunedSessions) global._prunedSessions = new Set();
            if (!global._prunedSessions.has(sessionKey)) {
                global._prunedSessions.add(sessionKey);
                setImmediate(async () => {
                    try {
                        const dir = path.join(SESSIONS_PATH, sessionKey);
                        if (!fs.existsSync(dir)) return;
                        const files = await fs.promises.readdir(dir);
                        const sessionFiles = files.filter(f => f.startsWith('session-') || f.startsWith('sender-key-'));
                        if (sessionFiles.length <= 3000) return;
                        const withMtime = await Promise.all(
                            sessionFiles.map(async f => ({ f, mt: (await fs.promises.stat(path.join(dir, f))).mtimeMs }))
                        );
                        withMtime.sort((a, b) => b.mt - a.mt);
                        await Promise.all(withMtime.slice(3000).map(({ f }) => fs.promises.unlink(path.join(dir, f)).catch(() => {})));
                        logger.warn(`[WA] Pruned ${withMtime.length - 3000} stale signal files for ${sessionKey}`);
                    } catch {}
                });
            }
            prunePeerSessions(path.join(SESSIONS_PATH, sessionKey), MAX_PEER_SESSION_FILES);
            engine.triggerBoot(sock);
            require('./eventBus').emit('socket.open', sock);

            // Pre-warm group metadata cache via shared groupCache module
            groupCache.warmUp(sock);

            // ── PRESENCE INDICATOR — tell WA the session is alive so it starts delivering messages
            setTimeout(async () => {
                try {
                    await sock.sendPresenceUpdate('available');
                    // Pulse available/unavailable every 4 min to keep WA delivering messages
                    if (!global._presenceIntervals) global._presenceIntervals = new Map();
                    if (global._presenceIntervals.has(sessionKey)) {
                        clearInterval(global._presenceIntervals.get(sessionKey));
                    }
                    kernel.presenceManager.start(sessionKey, sock);
                } catch {}
            }, 3000);

            startSocketHeartbeat(sessionKey, sock, () => {
                kernel.reconnectManager.schedule(
                    sessionKey,
                    () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                    'heartbeat-stale'
                );
            });

            // --- BEGIN: Send one-time CONNECTED message after pairing ---
            const stateFile = path.join(SESSIONS_PATH, sessionKey, 'connected.flag');
            try {
                await fs.promises.access(stateFile);
            } catch {
                fs.promises.writeFile(stateFile, 'connected').catch(() => {});
                const _tgNotify = (text, extra = {}) => new Promise((resolve) => {
                    const https = require('https');
                    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra });
                    const req = https.request({
                        hostname: 'api.telegram.org',
                        path: `/bot${process.env.TG_BOT_TOKEN}/sendMessage`,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
                    }, (res) => { res.resume(); resolve(); });
                    req.on('error', () => resolve());
                    req.write(body); req.end();
                });
                await _tgNotify(
                    `✅ <b>WHATSAPP CONNECTED!</b>\n\n📱 <code>+${phoneNumber}</code> is now live and paired.\n\n<b>What you can do now:</b>\n• Send <code>.menu</code> in any WhatsApp chat\n• Send <code>.pappy on</code> in a group to enable AI\n• Say <b>pappy</b> anywhere to trigger AI instantly\n• Use <code>.play</code>, <code>.sticker</code>, <code>.img</code> and more\n\n<pre>┏━━━━━━━━━━━━━━━━━━━━━━┓\n┃  🟢  CONNECTED!      ┃\n┗━━━━━━━━━━━━━━━━━━━━━━┛</pre>`,
                    {
                        disable_web_page_preview: true,
                        reply_markup: JSON.stringify({
                            inline_keyboard: [
                                [{ text: `📱 Manage Node +${phoneNumber}`, callback_data: `node_${sessionKey}` }],
                                [{ text: '📖 User Guide', callback_data: 'cmd_guide' }, { text: '🏠 Main Hub', callback_data: 'menu_main' }]
                            ]
                        })
                    }
                );
                setTimeout(() => _tgNotify(`🤖 <b>Hey! I'm Pappy.</b>\n\nSay <b>pappy</b> anywhere in your WhatsApp chat and I'll respond. Or do <code>.pappy on</code> in a group to keep me active there.`), 1500);
            }
            // --- END: CONNECTED message ---
        }
    });

    // ─── MESSAGE EVENT ROUTING ───
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // ── EARLY DROP: kill noise before touching the event loop ──
        // Reactions, status updates, and non-notify types are pure flood — drop instantly
        if (type !== 'notify' && type !== 'append') return;
        if (!messages?.length) return;

        // Drop status@broadcast and reaction messages immediately — never commands
        const filtered = messages.filter((m) => {
            const jid = m?.key?.remoteJid;
            if (!jid) return false;
            if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) return false;
            // Drop pure reaction messages — no text, no command possible
            if (m.message?.reactionMessage) return false;
            // Drop protocol/ephemeral control messages with no user content
            if (m.message?.protocolMessage && !m.message?.protocolMessage?.key) return false;
            return true;
        });
        if (!filtered.length) return;

        // Reassign to filtered batch for all downstream processing
        messages = filtered;

        // Update last activity timestamp for self-healing
        if (!global._lastMsgActivity) global._lastMsgActivity = new Map();
        global._lastMsgActivity.set(sessionKey, Date.now());
        global._lastEventActivity.set(sessionKey, Date.now());

        // Dispatcher-first routing: keep the hot path lightweight.
        try {
            const botIdNow = sock.user?.id?.split(':')[0] || phoneNumber;
            for (const m of (messages || [])) {
                const jid = m?.key?.remoteJid;
                if (!jid) continue;
                const text =
                    m.message?.conversation
                    || m.message?.extendedTextMessage?.text
                    || m.message?.imageMessage?.caption
                    || m.message?.videoMessage?.caption
                    || '';
                const sender = extractSender(m);
                const isGroup = jid.endsWith('@g.us');
                const ctx = {
                    sock,
                    msg: m,
                    jid,
                    text,
                    sender,
                    isGroup,
                    botId: botIdNow,
                    isGroupAdmin: false,
                    flags: {},
                };
                kernel.messageRouter.dispatch(ctx).catch(() => {});
            }

            // Command-first reliability: when a batch is command-only, skip legacy heavy pipeline.
            const hasNonCommand = (messages || []).some((m) => {
                const t = (
                    m?.message?.conversation
                    || m?.message?.extendedTextMessage?.text
                    || m?.message?.imageMessage?.caption
                    || m?.message?.videoMessage?.caption
                    || ''
                ).trim();
                return !!t && !normalizeCommandText(t, phoneNumber);
            });
            if (!hasNonCommand) return;

            if (String(process.env.WA_ROUTER_ONLY || '').toLowerCase() === 'true') {
                return;
            }
        } catch {}

        // ── POLL VOTE DETECTION for .song ──────────────────────────────────────
        for (const m of messages) {
            try {
                if (!m.message?.pollUpdateMessage) continue;
                const groupJid = m.key?.remoteJid;
                if (!groupJid) continue;

                // Get the poll creation message to read option names
                const pollCreationKey = m.message.pollUpdateMessage.pollCreationMessageKey?.id;
                const cachedPoll = global.messageCache?.get(pollCreationKey);
                if (!cachedPoll) continue;
                const pollName = cachedPoll?.message?.pollCreationMessageV3?.name || cachedPoll?.message?.pollCreationMessage?.name || '';
                if (!pollName.includes('Pick a song')) continue;

                const selectedNames = (await resolveSongPollSelections(m.message.pollUpdateMessage, cachedPoll))
                    .map((name) => String(name || '').replace(/\s*\[.*?\]\s*$/, '').trim())
                    .filter(Boolean);
                if (!selectedNames.length) continue;

                await handleSongPollSelection(sock, groupJid, pollCreationKey || m.key?.id || '', selectedNames);
            } catch (e) {
                logger.warn(`[Poll] Error: ${e.message}`);
            }
        }

                try {
        if (botState.isSleeping || (type !== 'notify' && type !== 'append')) return;
        
        const msg = messages[0];
        if (!msg?.message) return;
        const _rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        // Only log messages that have actual text content
        if (_rawText) logger.info(`[MSG] type=${type} fromMe=${msg.key?.fromMe} text=${_rawText.slice(0,40)}`);

        // Cache ALL messages in the batch (not just index 0) so deleteall can find bot-sent audio/songs
        for (const m of messages) {
            if (m?.key?.id && m?.message) {
                global.messageCache.set(m.key.id, m);
                // GC handled by periodic interval — not per-message to avoid event loop pressure
                // Index by sender for fast deleteall lookup
                const groupJid = m.key?.remoteJid;
                if (groupJid) {
                    let senderDigits;
                    if (m.key?.fromMe) {
                        senderDigits = String(phoneNumber || '').replace(/[^0-9]/g, '');
                    } else {
                        senderDigits = String(m.key?.participant || '').replace(/[^0-9]/g, '');
                    }
                    if (senderDigits) {
                        const indexKey = `${groupJid}:${senderDigits}`;
                        if (!global._senderMsgIndex.has(indexKey)) global._senderMsgIndex.set(indexKey, new Set());
                        global._senderMsgIndex.get(indexKey).add(m.key.id);
                    }
                }
            }
        }

        const jid = msg.key.remoteJid;
        if (!jid) return; // guard null JID — prevents jidDecode crash
        const isGroup = jid.endsWith('@g.us');
        
        const botId = sock.user?.id?.split(':')[0] || phoneNumber;
        const fullBotJid = `${botId}@s.whatsapp.net`;
        const nodeState = getNodeState(phoneNumber);
        const nodeMode = nodeState.nodeMode || 'public';
        
        let text = (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            msg.message?.documentMessage?.caption ||
            msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
            msg.message?.buttonsResponseMessage?.selectedDisplayText ||
            msg.message?.listResponseMessage?.title ||
            msg.message?.templateButtonReplyMessage?.selectedDisplayText ||
            msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
            msg.message?.ephemeralMessage?.message?.conversation ||
            msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
            msg.message?.ephemeralMessage?.message?.imageMessage?.caption ||
            msg.message?.ephemeralMessage?.message?.videoMessage?.caption ||
            msg.message?.viewOnceMessage?.message?.imageMessage?.caption ||
            msg.message?.viewOnceMessage?.message?.videoMessage?.caption ||
            ''
        ).trim();

        // Learn rich preview cards users send so later status/godcast can reuse them.
        const directCtx = msg.message?.extendedTextMessage?.contextInfo
            || msg.message?.imageMessage?.contextInfo
            || msg.message?.videoMessage?.contextInfo;
        const ephCtx = msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
            || msg.message?.ephemeralMessage?.message?.imageMessage?.contextInfo
            || msg.message?.ephemeralMessage?.message?.videoMessage?.contextInfo;
        const observedCtx = directCtx || ephCtx;
        if (observedCtx?.externalAdReply) {
            rememberPreviewHint(text, observedCtx);
        }

        // Cache full extendedTextMessage when it has a link preview
        // so .updategstatus / .godcast / .gcast can relay it exactly
        const extMsg = msg.message?.extendedTextMessage;
        if (extMsg?.matchedText && msg.key?.id) {
            try {
                const { connection: redis } = require('../services/redis');
                const cacheKey = `ext:${extMsg.matchedText.slice(0, 200)}`;
                redis.set(cacheKey, JSON.stringify(extMsg), 'EX', 3600).catch(() => {});
            } catch {}
        }
        
        // Check if this is actually a sticker message (not text)
        const isActualSticker = !!(msg.message?.stickerMessage);
        
        // If it's a sticker, don't treat it as text
        if (isActualSticker) {
            text = ''; // Clear text so it doesn't trigger text responses
        }

        const sender = msg.key.fromMe ? fullBotJid : resolveSenderJid(msg, fullBotJid);
        let isGroupAdmin = isGroup ? getCachedAdminStatus(sock, jid, sender) : false;
        let botIsGroupAdmin = isGroup ? getCachedAdminStatus(sock, jid, fullBotJid) : false;

        // Private mode: only node owner + general owner can interact at all
        if (nodeMode === 'private' && !msg.key.fromMe && !isOwnerJidForSession(sender, phoneNumber)) {
            return;
        }

        // Hard DM policy: only the general owner OR this session's own number can interact in DM
        if (!isGroup && !msg.key.fromMe && !isOwnerJidForSession(sender, phoneNumber)) {
            return;
        }

        // ── STICKER TRIGGER HANDLER ──────────────────────────────────────────
        let isStickerTriggered = false;
        if (msg.message?.stickerMessage && !text) {
            try {
                const sticker = msg.message.stickerMessage;
                // Handle all fileSha256 formats (Buffer, {type,data}, base64 string)
                let stickerId = null;
                const sha = sticker.fileSha256;
                if (sha) {
                    if (Buffer.isBuffer(sha)) stickerId = sha.toString('base64');
                    else if (sha?.type === 'Buffer' && Array.isArray(sha?.data)) stickerId = Buffer.from(sha.data).toString('base64');
                    else if (typeof sha === 'string') stickerId = sha;
                    else stickerId = Buffer.from(sha).toString('base64');
                }
                if (stickerId) {
                    const boundCmd = global._stickerCmdsCache[stickerId];
                    if (boundCmd) {
                        text = boundCmd;
                        isStickerTriggered = true;
                        // Preserve original message structure so commands like .tag work with context
                        // Only replace conversation, keep contextInfo intact
                        const origCtxInfo = msg.message?.stickerMessage?.contextInfo || null;
                        msg.message = {
                            extendedTextMessage: {
                                text: boundCmd,
                                contextInfo: origCtxInfo || {}
                            }
                        };
                        logger.info(`[Sticker Trigger] Fired: ${boundCmd}`);
                    }
                }
            } catch (e) {
                logger.error(`[Sticker Trigger] Error: ${e.message}`);
            }
        }

        // Only refresh group meta if cache is stale — don't block on every message
        if (isGroup) refreshGroupMeta(sock, jid);

        // ── SONG PICK HANDLER — user replies with number after .song search ────────────────
        if (text && /^[1-5]$/.test(text.trim()) && global._songSearchCache?.size > 0) {
            const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
            for (const [token, entry] of global._songSearchCache.entries()) {
                if (entry.jid === jid) {
                    const pick = parseInt(text.trim()) - 1;
                    const result = entry.results?.[pick];
                    if (result) {
                        global._songSearchCache.delete(token);
                        const statusMsg = await sock.sendMessage(jid, { text: `🎵 *${result.title}*\n⏳ Downloading...` }, { quoted: msg });
                        try {
                            const { exec } = require('child_process');
                            const util = require('util');
                            const execAsync = util.promisify(exec);
                            const fsp = require('fs').promises;
                            const tmpDir = path.join(__dirname, '../data/temp_media');
                            await fsp.mkdir(tmpDir, { recursive: true });
                            const outPath = path.join(tmpDir, `song_${Date.now()}.mp3`);
                            const cookieArg = getYoutubeCookieArg();
                            await execAsync(`${YT_DLP_BIN} ${cookieArg} -x --audio-format mp3 --audio-quality 2 --max-filesize 48m --no-playlist --no-warnings -o "${outPath}" "${result.url}"`, { timeout: 120000 });
                            let fileReady = true;
                            try { await fsp.access(outPath); } catch { fileReady = false; }
                            if (fileReady) {
                                const buf = await fsp.readFile(outPath);
                                await sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false, fileName: `${result.title}.mp3` }, { quoted: msg });
                                fsp.unlink(outPath).catch(() => {});
                                await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
                            }
                        } catch (e) {
                            await sendPremiumText(sock, jid, `❌ Download failed: ${e.message}`, { quoted: msg });
                        }
                    }
                    break;
                }
            }
        }

        const normalizedCommandText = normalizeCommandText(text, phoneNumber);
        // Handle "next" reply to song info message
        const quotedMsgText = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || '';
        const isNextReply = text?.trim().toLowerCase() === 'next' && quotedMsgText.includes('Tap your choice above');
        const isCommandMessage = !!normalizedCommandText || isNextReply;
        if (isNextReply && !normalizedCommandText) {
            // Treat as .song next [query]
            const songQuery = quotedMsgText.match(/Pick a song: (.+)/)?.[1] || '';
            if (songQuery) {
                engine.triggerMessage({ sock, msg, text: `.song next ${songQuery}`, isGroup, sender, botId, isGroupAdmin, botIsGroupAdmin });
                return;
            }
        }
        if (isCommandMessage) {
            engine.triggerMessage({
                sock,
                msg,
            text: normalizedCommandText,
                isGroup,
                sender,
                botId,
                isGroupAdmin,
                botIsGroupAdmin,
                resolveIsGroupAdmin: async () => {
                    if (!isGroup) return false;
                    const meta = await getCachedGroupMeta(sock, jid);
                    const senderNorm = String(sender || '').replace(/:\d+(?=@)/g, '');
                    const participant = meta.participants.find((p) => {
                        const pid = String(p?.id || '');
                        return pid === sender || pid === senderNorm || pid.replace(/:\d+(?=@)/g, '') === senderNorm;
                    });
                    return participant?.admin?.includes('admin') || false;
                },
                resolveBotIsGroupAdmin: async () => {
                    if (!isGroup) return false;
                    const meta = await getCachedGroupMeta(sock, jid);
                    const fullNorm = String(fullBotJid || '').replace(/:\d+(?=@)/g, '');
                    const botParticipant = meta.participants.find((p) => {
                        const pid = String(p?.id || '');
                        return pid === fullBotJid || pid === fullNorm || pid.replace(/:\d+(?=@)/g, '') === fullNorm;
                    });
                    return botParticipant?.admin?.includes('admin') || false;
                }
            });
            return;
        }

        // ─── AI context — check all message types for reply context ────────
        // WA puts contextInfo in different places depending on message type
        const ctxInfo = msg.message?.extendedTextMessage?.contextInfo
            || msg.message?.imageMessage?.contextInfo
            || msg.message?.videoMessage?.contextInfo
            || msg.message?.audioMessage?.contextInfo
            || msg.message?.documentMessage?.contextInfo
            || msg.message?.stickerMessage?.contextInfo
            || msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
            || msg.message?.ephemeralMessage?.message?.imageMessage?.contextInfo
            || null;
        const mentionedJids     = ctxInfo?.mentionedJid || [];
        const isMentioned       = mentionedJids.some(j => j.startsWith(botId));
        const quotedParticipant = ctxInfo?.participant;
        const quotedStanzaId    = ctxInfo?.stanzaId;
        const cachedMsg         = quotedStanzaId ? global.messageCache.get(quotedStanzaId) : null;
        const botDigits         = String(botId).replace(/[^0-9]/g, '');
        const quotedDigits      = String(quotedParticipant || '').replace(/[^0-9]/g, '');
        const isReplyToBot = !!(
            quotedParticipant?.startsWith(botId) ||
            (quotedDigits && quotedDigits === botDigits) ||
            cachedMsg?.key?.fromMe ||
            ctxInfo?.quotedMessage?.key?.fromMe
        );
        const hasImage          = !!(msg.message?.imageMessage);
        const hasVoice          = !!(msg.message?.audioMessage?.ptt);
        const hasSticker        = !!(msg.message?.stickerMessage);
        // Quoted image — user replied to an image with text like "make sticker" or "describe"
        const quotedImageMsg    = ctxInfo?.quotedMessage?.imageMessage || ctxInfo?.quotedMessage?.ephemeralMessage?.message?.imageMessage;
        const hasQuotedImage    = !!(quotedImageMsg) && !hasImage;
        const pappyOn           = nodeState.pappyMode?.[jid] === true;
        
        // Debug: log when sticker is detected
        if (hasSticker && pappyOn && isGroup) {
            logger.info(`[STICKER] Detected sticker message from ${sender}`);
        }

        // Sticker reply-to-bot detection
        const stickerCtxInfo = msg.message?.stickerMessage?.contextInfo;
        const stickerCachedMsg = stickerCtxInfo?.stanzaId ? global.messageCache.get(stickerCtxInfo.stanzaId) : null;
        const isStickerReplyToBot = !!(stickerCtxInfo?.participant?.startsWith(botId)) || !!(stickerCachedMsg?.key?.fromMe);

        // Explicit mention/reply triggers always work in groups.
        // Keyword trigger "pappy" follows .pappy mode state so OFF truly disables it.
        const hasPappyTrigger = pappyOn && !msg.key.fromMe && /\bpappy\b/i.test(text);
        // Group AI must respect .pappy on/off strictly. If OFF, do not answer ambient or explicit AI triggers.
        const explicitGroupTrigger = pappyOn && (isMentioned || isReplyToBot || isStickerReplyToBot || hasPappyTrigger);
        const ambientGroupTrigger = pappyOn && (hasSticker || !!String(text || '').trim());

        const shouldRespond = !msg.key.fromMe && (
            (isGroup && (explicitGroupTrigger || ambientGroupTrigger)) ||
            (!isGroup && isOwnerJidForSession(sender, phoneNumber))
        );
        
        if (shouldRespond && !text.startsWith(globalPrefix)) {
            const msgId = msg.key.id || '';
            const senderCooldownKey = `${sessionKey}:${String(sender || '').replace(/:\d+(?=@)/g, '')}`;
            if (!global._aiUserCooldown) global._aiUserCooldown = new Map();
            const lastUserAiAt = Number(global._aiUserCooldown.get(senderCooldownKey) || 0);
            if (Date.now() - lastUserAiAt < AI_USER_COOLDOWN_MS) return;
            global._aiUserCooldown.set(senderCooldownKey, Date.now());

            // Dedup check — skip if same message already queued
            if (!canAiReply(msgId)) return;

            const { downloadMediaMessage } = require('gifted-baileys');
            const ai = require('./ai');
            sock.sendPresenceUpdate('composing', jid).catch(() => {});
            logger.info(`[AI] Queued - Sticker: ${hasSticker}, Mentioned: ${isMentioned}, Reply: ${isReplyToBot}`);

            // Push into per-session queue — 1 AI call at a time per node
            // setImmediate yields to event loop first so commands always get priority
            // Push into per-session queue — 1 AI call at a time per node
            // setImmediate yields to event loop first so commands always get priority
            const aiQ = getAiQueue(sessionKey);
            if (aiQ.length() >= AI_MAX_QUEUE_SIZE) {
                logger.warn(`[AI] Queue overloaded for ${sessionKey} (${aiQ.length()}) — dropping new AI task`);
                return;
            }

            setImmediate(() => {
                aiQ.push(async () => {
                    await handleWhatsAppAiEvent({
                        sock,
                        msg,
                        jid,
                        text,
                        sender,
                        hasSticker,
                        hasImage,
                        hasQuotedImage,
                        hasVoice,
                        isMentioned,
                        isReplyToBot,
                        isGroup,
                        sessionKey,
                        ctxInfo,
                        downloadMediaMessage,
                    });
                });
            }); // End setImmediate
            return;
        }

        engine.triggerMessage({ sock, msg, text, isGroup, sender, botId, isGroupAdmin });
        } catch (err) {
            logger.error(`[WA] messages.upsert crash prevented: ${err.message}`);
        }
    });

    // ─── KEEP GROUP CACHE FRESH ON PARTICIPANT / METADATA CHANGES ────────────────
    // ── POLL VOTE HANDLER — for .song poll selection ────────────────────────────────
    async function handleWhatsAppAiEvent({ sock, msg, jid, text, sender, hasSticker, hasImage, hasQuotedImage, hasVoice, isMentioned, isReplyToBot, isGroup, sessionKey, ctxInfo, downloadMediaMessage }) {
        const cleanText = String(text || '').replace(/@\d+/g, '').trim();
        const audioBuffer = hasVoice ? await downloadMediaMessage(msg, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage }) : null;
        const analysis = await aiController.analyzeWhatsAppEvent({
            sock,
            msg,
            jid,
            text: cleanText,
            sender,
            hasSticker,
            hasImage: hasImage || hasQuotedImage,
            hasVoice,
            audioBuffer,
            isReplyToBot,
            isMentioned,
            isGroup,
            sessionKey,
        }).catch((err) => {
            logger.warn('[AI Controller] analyzeWhatsAppEvent failed', { error: err.message });
            return null;
        });

        if (!analysis) {
            await sendPremiumText(sock, jid, 'I could not process that request right now.', { quoted: msg }).catch(() => {});
            return;
        }

        if (analysis.type === 'shell' && analysis.command) {
            try {
                const output = await aiController.executeSafeShell(analysis.command);
                const formattedOutput = '```' + '\n' + String(output).slice(0, 1900) + '\n' + '```';
                await sendPremiumText(sock, jid, formattedOutput, { quoted: msg });
            } catch (err) {
                await sendPremiumText(sock, jid, `Command blocked or failed: ${err.message}`, { quoted: msg }).catch(() => {});
            }
            return;
        }

        if (analysis.type === 'voice' && analysis.audio) {
            await sock.sendMessage(jid, { audio: analysis.audio, mimetype: 'audio/mpeg', ptt: true }, { quoted: msg }).catch(async () => {
                if (analysis.text) await sendPremiumText(sock, jid, analysis.text, { quoted: msg }).catch(() => {});
            });
            return;
        }

        if (analysis.type === 'sticker') {
            const prompt = analysis.prompt || 'Create an expressive sticker with dramatic anime style.';
            const imgBuffer = await ai.generateImage(prompt).catch(() => null);
            if (!imgBuffer) {
                await sendPremiumText(sock, jid, "I couldn't generate a sticker image just now.", { quoted: msg }).catch(() => {});
                return;
            }
            const stickerResult = await generateAnimatedSticker(imgBuffer).catch(() => null);
            if (!stickerResult?.buffer) {
                await sendPremiumText(sock, jid, "Failed to build the sticker.", { quoted: msg }).catch(() => {});
                return;
            }
            await sock.sendMessage(jid, { sticker: stickerResult.buffer, stickerMetadata: { packName: 'Ω Pappy Ultimate', packPublish: 'pappylung', packId: 'pappy-ultimate-v5', categories: ['🔥'], isAvatar: false, isAiSticker: true } }, { quoted: msg }).catch(() => {});
            return;
        }

        if (analysis.type === 'describe-image' || analysis.type === 'generate-image' || analysis.type === 'sticker-from-image') {
            const targetMsg = hasImage ? msg : { key: { remoteJid: jid, id: ctxInfo?.stanzaId, fromMe: false }, message: ctxInfo?.quotedMessage };
            if (!targetMsg?.message) {
                await sendPremiumText(sock, jid, 'Could not find the referenced image.', { quoted: msg }).catch(() => {});
                return;
            }
            const imageBuffer = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage }).catch(() => null);
            if (!imageBuffer) {
                await sendPremiumText(sock, jid, 'Unable to download the image.', { quoted: msg }).catch(() => {});
                return;
            }
            if (analysis.type === 'sticker-from-image') {
                const stickerResult = await generateAnimatedSticker(imageBuffer).catch(() => null);
                if (!stickerResult?.buffer) {
                    await sendPremiumText(sock, jid, 'Failed to convert image to sticker.', { quoted: msg }).catch(() => {});
                    return;
                }
                await sock.sendMessage(jid, { sticker: stickerResult.buffer, stickerMetadata: { packName: 'Ω Pappy Ultimate', packPublish: 'pappylung', packId: 'pappy-ultimate-v5', categories: ['🔥'], isAvatar: false, isAiSticker: true } }, { quoted: msg }).catch(() => {});
                return;
            }
            if (analysis.type === 'generate-image') {
                const generated = await ai.generateImage(analysis.prompt || cleanText).catch(() => null);
                if (!generated) {
                    await sendPremiumText(sock, jid, "Couldn't generate the image right now.", { quoted: msg }).catch(() => {});
                    return;
                }
                await sock.sendMessage(jid, { image: generated, caption: '' }, { quoted: msg }).catch(() => {});
                return;
            }
            if (analysis.type === 'describe-image') {
                const result = await ai.analyzeImage(imageBuffer, analysis.prompt || cleanText, sender).catch(() => null);
                if (!result) {
                    await sendPremiumText(sock, jid, "I couldn't describe that image.", { quoted: msg }).catch(() => {});
                    return;
                }
                await sendPremiumText(sock, jid, result, { quoted: msg }).catch(() => {});
                return;
            }
        }

        if (analysis.text) {
            await sendPremiumText(sock, jid, analysis.text, { quoted: msg }).catch(() => {});
            return;
        }

        await sendPremiumText(sock, jid, 'I could not generate a response.', { quoted: msg }).catch(() => {});
    }

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            try {
                if (!update.update?.pollUpdates) continue;
                const pollVote = update.update.pollUpdates[0];
                if (!pollVote) continue;
                const groupJid = update.key?.remoteJid;

                const pollCreationKey = pollVote.pollCreationMessageKey?.id || update.key?.id;
                const cachedPoll = global.messageCache?.get(pollCreationKey);
                if (!cachedPoll) continue;
                const pollName = cachedPoll?.message?.pollCreationMessageV3?.name || cachedPoll?.message?.pollCreationMessage?.name || '';
                if (!pollName.includes('Pick a song')) continue;

                const selectedNames = (await resolveSongPollSelections(pollVote, cachedPoll))
                    .map((name) => String(name || '').replace(/\s*\[.*?\]\s*$/, '').trim())
                    .filter(Boolean);
                if (!selectedNames.length) continue;

                await handleSongPollSelection(sock, groupJid, pollCreationKey || update.key?.id || '', selectedNames);
            } catch {}
        }
    });

    // ── POLL VOTE HANDLER — poll votes come as pollUpdateMessage in messages.upsert ──
    // NOTE: This is handled inside the primary messages.upsert handler above.
    // A second sock.ev.on('messages.upsert') registration was removed here to
    // prevent duplicate listener stacking which doubled event processing load.


    sock.ev.on('groups.update', (updates) => {
        if (!global._groupInvalidateQueues) global._groupInvalidateQueues = new Map();
        const key = sessionKey;
        let state = global._groupInvalidateQueues.get(key);
        if (!state) {
            state = { ids: new Set(), timer: null };
            global._groupInvalidateQueues.set(key, state);
        }
        for (const update of updates) {
            if (update.id) state.ids.add(update.id);
        }
        if (state.timer) return;
        state.timer = setTimeout(() => {
            try {
                for (const jid of state.ids) groupCache.invalidate(jid, sock);
            } finally {
                state.ids.clear();
                state.timer = null;
            }
        }, 1000);
        state.timer.unref?.();
    });
    sock.ev.on('group-participants.update', ({ id }) => {
        if (!id) return;
        if (!global._groupInvalidateQueues) global._groupInvalidateQueues = new Map();
        const key = sessionKey;
        let state = global._groupInvalidateQueues.get(key);
        if (!state) {
            state = { ids: new Set(), timer: null };
            global._groupInvalidateQueues.set(key, state);
        }
        state.ids.add(id);
        if (state.timer) return;
        state.timer = setTimeout(() => {
            try {
                for (const jid of state.ids) groupCache.invalidate(jid, sock);
            } finally {
                state.ids.clear();
                state.timer = null;
            }
        }, 1000);
        state.timer.unref?.();
    });

    return sock;
}

function setPappyMode(jid, value, phone) {
    if (phone) {
        const state = getNodeState(phone);
        if (!state.pappyMode) state.pappyMode = {};
        state.pappyMode[jid] = value;
        saveNodeState(phone);
    } else {
        if (!botState.pappyMode) botState.pappyMode = {};
        botState.pappyMode[jid] = value;
        saveState();
    }
}

module.exports = { startWhatsApp, activeSockets, loadState, saveState, botState, setPappyMode, getCommandPrefix, setCommandPrefix, getNodeMode, setNodeMode, getNodeState };
