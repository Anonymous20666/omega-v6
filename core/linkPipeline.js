'use strict';
// core/linkPipeline.js
// THE LINK PIPELINE — Single source of truth for the 3-stage link lifecycle.
//
// Stage 1 — MAIN  (validator-intake.json)  : unverified, freshly scraped
// Stage 2 — LIVE  (validator-active.json)  : validated, safe to join
// Stage 3 — DEAD  (validator-dead.json)    : revoked / expired / invalid
//
// Rules:
//  • A code lives in exactly ONE store at any time.
//  • Only real join outcomes (not metadata) promote/demote a code.
//  • All writes are atomic (tmp → rename).

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA = path.join(__dirname, '../data');
const PATHS = {
    main: path.join(DATA, 'validator-intake.json'),
    live: path.join(DATA, 'validator-active.json'),
    dead: path.join(DATA, 'validator-dead.json'),
};

const CODE_RE = /^[0-9A-Za-z]{20,24}$/;

// ─── In-memory stores ─────────────────────────────────────────────────────────
let _db = { main: {}, live: {}, dead: {} };
let _loaded = false;
let _saveTimer = null;

// ─── Node flood-pause map: nodeId → resumeAt ─────────────────────────────────
const _nodePause = new Map();
const NODE_PAUSE_MS = 30 * 60 * 1000; // 30 min

// ─── Helpers ──────────────────────────────────────────────────────────────────
function norm(code) {
    const c = String(code || '').trim();
    return CODE_RE.test(c) ? c : null;
}

function _load() {
    if (_loaded) return;
    for (const [key, p] of Object.entries(PATHS)) {
        try {
            _db[key] = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) || {}) : {};
        } catch {
            _db[key] = {};
        }
    }
    _loaded = true;
}

async function _flush() {
    for (const [key, p] of Object.entries(PATHS)) {
        const tmp = `${p}.tmp`;
        try {
            await fs.promises.writeFile(tmp, JSON.stringify(_db[key], null, 2));
            await fs.promises.rename(tmp, p);
        } catch (e) {
            logger.warn(`[Pipeline] flush failed for ${key}: ${e.message}`);
        }
    }
}

function _scheduleSave() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(async () => {
        _saveTimer = null;
        await _flush().catch(() => {});
    }, 600);
}

// Move a code to a target store, removing it from all others.
function _moveTo(store, code, meta = {}) {
    _load();
    for (const k of Object.keys(_db)) delete _db[k][code];
    _db[store][code] = { code, ...meta, updatedAt: Date.now() };
    _scheduleSave();
    return _db[store][code];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * ingestLink — Stage 1 entry point.
 * Drops a raw scraped code into Main_DB if not already known anywhere.
 * Returns: 'added' | 'duplicate' | 'invalid'
 */
function ingestLink(code, meta = {}) {
    const c = norm(code);
    if (!c) return 'invalid';
    _load();
    if (_db.main[c] || _db.live[c] || _db.dead[c]) return 'duplicate';
    _moveTo('main', c, { status: 'PENDING', source: meta.source || 'scrape', ...meta });
    logger.info(`[Pipeline] Ingested ${c} → MAIN`);
    return 'added';
}

/**
 * getMainLinks — returns all unvalidated links from Main_DB.
 */
function getMainLinks() {
    _load();
    return Object.values(_db.main);
}

/**
 * getLiveLinks — returns all validated links from Live_DB.
 */
function getLiveLinks() {
    _load();
    return Object.values(_db.live);
}

/**
 * getDeadLinks — returns all dead links.
 */
function getDeadLinks() {
    _load();
    return Object.values(_db.dead);
}

function getSummary() {
    _load();
    return {
        main: Object.keys(_db.main).length,
        live: Object.keys(_db.live).length,
        dead: Object.keys(_db.dead).length,
    };
}

/**
 * classifyError — maps a Baileys error to a pipeline outcome string.
 */
function classifyError(err) {
    const m = String(err?.message || err || '').toLowerCase();
    if (m.includes('not-found') || m.includes('not found') || m.includes('404')) return 'DEAD';
    if (m.includes('revoked') || m.includes('gone') || m.includes('410'))         return 'DEAD';
    if (m.includes('expired') || m.includes('invalid'))                            return 'DEAD';
    if (m.includes('already') || m.includes('already-participant'))                return 'ALREADY_JOINED';
    if (m.includes('approval') || m.includes('request') || m.includes('406'))     return 'REQUEST_REQUIRED';
    if (m.includes('rate') || m.includes('429') || m.includes('too many'))         return 'RATE_LIMITED';
    if (m.includes('spam') || m.includes('flood') || m.includes('403'))            return 'FLOOD_BLOCKED';
    return 'UNKNOWN';
}

/**
 * testLinkStatus — Stage 2 core.
 * Uses groupGetInviteInfo (metadata only, no join) to pre-screen a code.
 * Returns: 'live' | 'dead' | 'unknown'
 */
async function testLinkStatus(code, sock) {
    const c = norm(code);
    if (!c || !sock?.groupGetInviteInfo) return 'unknown';
    try {
        const info = await sock.groupGetInviteInfo(c);
        return info?.id ? 'live' : 'dead';
    } catch (err) {
        const outcome = classifyError(err);
        return outcome === 'DEAD' ? 'dead' : 'unknown';
    }
}

/**
 * validateBatch — Stage 2 batch runner.
 * Pulls codes from Main_DB, tests each with the given sock,
 * moves them to Live or Dead, removes from Main.
 * Returns a summary object.
 */
async function validateBatch(sock, opts = {}) {
    _load();
    const limit = opts.limit || 50;
    const delayMs = opts.delayMs || 2000;
    const codes = Object.keys(_db.main).slice(0, limit);
    const result = { live: 0, dead: 0, unknown: 0, total: codes.length };

    for (const code of codes) {
        const status = await testLinkStatus(code, sock).catch(() => 'unknown');
        if (status === 'live') {
            _moveTo('live', code, { status: 'LIVE', validatedAt: Date.now() });
            result.live++;
        } else if (status === 'dead') {
            _moveTo('dead', code, { status: 'DEAD', validatedAt: Date.now() });
            result.dead++;
        } else {
            // unknown — leave in main for retry
            result.unknown++;
        }
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs + Math.random() * 1000));
    }

    await _flush().catch(() => {});
    logger.info(`[Pipeline] validateBatch done — live:${result.live} dead:${result.dead} unknown:${result.unknown}`);
    return result;
}

/**
 * moveLinkToDead — moves a code from Live → Dead.
 * Called by Join Intel feedback loop when a live link fails at join time.
 */
function moveLinkToDead(code, reason = 'runtime_dead') {
    const c = norm(code);
    if (!c) return false;
    _load();
    if (!_db.live[c] && !_db.main[c]) return false;
    _moveTo('dead', c, { status: 'DEAD', reason, diedAt: Date.now() });
    logger.info(`[Pipeline] ${c} → DEAD (${reason})`);
    return true;
}

/**
 * handleAutoJoin — Stage 1 event handler.
 * Called from the message router when a WA node has AutoJoin ON.
 * Extracts invite codes from message text and ingests them into Main_DB.
 * Does NOT join — purely collects.
 */
function handleAutoJoin(text, meta = {}) {
    if (!text?.includes('chat.whatsapp.com')) return [];
    const matches = [...text.matchAll(/chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/gi)];
    const added = [];
    for (const m of matches) {
        const code = m[1];
        const result = ingestLink(code, { source: 'autojoin_scrape', ...meta });
        if (result === 'added') added.push(code);
    }
    return added;
}

/**
 * joinLiveLink — Stage 3 core.
 * Attempts to join a single code from Live_DB using the given sock.
 * Handles the feedback loop: dead-link errors → moveLinkToDead().
 * Returns: { success, outcome, groupJid? }
 */
async function joinLiveLink(code, sock) {
    const c = norm(code);
    if (!c) return { success: false, outcome: 'INVALID' };
    _load();
    if (!_db.live[c]) return { success: false, outcome: 'NOT_IN_LIVE_DB' };

    // Human-like delay before joining
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000));

    try {
        const groupJid = await sock.groupAcceptInvite(c);
        logger.info(`[Pipeline] Joined ${c} → ${groupJid}`);
        return { success: true, outcome: 'JOIN_SUCCESS', groupJid };
    } catch (err) {
        const outcome = classifyError(err);
        if (outcome === 'DEAD') {
            moveLinkToDead(c, 'join_failed_dead');
            return { success: false, outcome: 'DEAD', error: err.message };
        }
        if (outcome === 'ALREADY_JOINED') {
            return { success: true, outcome: 'ALREADY_JOINED' };
        }
        if (outcome === 'REQUEST_REQUIRED') {
            // Attempt V4 join request
            try {
                const info = await sock.groupGetInviteInfo(c).catch(() => null);
                if (info?.id) {
                    await sock.groupAcceptInviteV4(sock.user.id, {
                        groupJid: info.id,
                        inviteCode: c,
                        inviteExpiration: info.inviteExpiration || 0,
                    });
                    return { success: true, outcome: 'REQUEST_SENT', groupJid: info.id };
                }
            } catch {}
            return { success: false, outcome: 'REQUEST_REQUIRED', error: err.message };
        }
        if (outcome === 'RATE_LIMITED' || outcome === 'FLOOD_BLOCKED') {
            const nodeId = String(sock.user?.id?.split(':')[0] || '');
            if (nodeId) pauseNode(nodeId);
            return { success: false, outcome, error: err.message };
        }
        return { success: false, outcome: 'UNKNOWN', error: err.message };
    }
}

// ─── Node pause helpers ───────────────────────────────────────────────────────
function pauseNode(nodeId, ms = NODE_PAUSE_MS) {
    _nodePause.set(String(nodeId), Date.now() + ms);
    logger.warn(`[Pipeline] Node ${nodeId} paused for ${Math.round(ms / 60000)}min`);
}

function isNodePaused(nodeId) {
    const until = _nodePause.get(String(nodeId || ''));
    return until ? Date.now() < until : false;
}

function clearNodePause(nodeId) {
    _nodePause.delete(String(nodeId || ''));
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
    // Stage 1
    ingestLink,
    handleAutoJoin,
    // Stage 2
    testLinkStatus,
    validateBatch,
    // Stage 3
    joinLiveLink,
    moveLinkToDead,
    // Read
    getMainLinks,
    getLiveLinks,
    getDeadLinks,
    getSummary,
    // Node safety
    pauseNode,
    isNodePaused,
    clearNodePause,
    // Util
    classifyError,
    norm,
};
