'use strict';
// core/linkValidator.js
// ─── 3-BUCKET LINK PIPELINE ───────────────────────────────────────────────────
//
//  MAIN  (validator-intake.json)  — unvalidated entry point
//  LIVE  (validator-active.json)  — validated & joinable
//  DEAD  (validator-dead.json)    — revoked / expired / confirmed dead
//
// Rules:
//  • A code lives in exactly ONE bucket at any time.
//  • Validation (MAIN → LIVE or DEAD) uses groupGetInviteInfo — no join, no ban risk.
//  • Join Intel reads ONLY from LIVE.
//  • If a join attempt fails with a dead-link error → code goes back to MAIN for revalidation.
//  • No retry bucket, no request bucket, no queue bucket.

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');
const eventBus = require('./eventBus');

const DATA_DIR   = path.join(__dirname, '../data');
const PATH_MAIN  = path.join(DATA_DIR, 'validator-intake.json');
const PATH_LIVE  = path.join(DATA_DIR, 'validator-active.json');
const PATH_DEAD  = path.join(DATA_DIR, 'validator-dead.json');

const CODE_RE = /^[0-9A-Za-z]{20,24}$/;

// ─── Status constants (kept for external compat) ──────────────────────────────
const STATUS = Object.freeze({
    PENDING:          'PENDING',
    LIVE:             'LIVE',
    DEAD:             'DEAD',
    // legacy aliases used by pappy-intel / telegram.js
    ACTIVE_JOINABLE:  'LIVE',
    JOIN_SUCCESS:     'LIVE',
    ALREADY_JOINED:   'LIVE',
    REQUEST_REQUIRED: 'LIVE',
    EXPIRED:          'DEAD',
    REVOKED:          'DEAD',
    INVALID:          'DEAD',
    FLOOD_BLOCKED:    'PENDING',
    RATE_LIMITED:     'PENDING',
    UNKNOWN_FAILURE:  'PENDING',
});

const DEAD_STATUSES = new Set(['DEAD', 'EXPIRED', 'REVOKED', 'INVALID']);

// ─── In-memory state ──────────────────────────────────────────────────────────
let _db = { main: {}, live: {}, dead: {} };
let _loaded = false;
let _saveTimer = null;

// Per-node flood-pause: nodeId → resumeAt ms
const _nodePause = new Map();
const NODE_PAUSE_MS = 30 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _norm(code) {
    const c = String(code || '').trim();
    return CODE_RE.test(c) ? c : null;
}

function _load() {
    if (_loaded) return;
    const read = (p) => { try { return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) || {}) : {}; } catch { return {}; } };
    _db.main = read(PATH_MAIN);
    _db.live = read(PATH_LIVE);
    _db.dead = read(PATH_DEAD);
    _loaded = true;
}

async function _flush() {
    const pairs = [[PATH_MAIN, 'main'], [PATH_LIVE, 'live'], [PATH_DEAD, 'dead']];
    for (const [p, k] of pairs) {
        const tmp = `${p}.tmp`;
        try {
            await fs.promises.writeFile(tmp, JSON.stringify(_db[k], null, 2));
            await fs.promises.rename(tmp, p);
        } catch (e) {
            logger.warn(`[LinkValidator] flush ${k} failed: ${e.message}`);
        }
    }
}

function _scheduleSave() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(async () => { _saveTimer = null; await _flush().catch(() => {}); }, 800);
}

// Move a code to one bucket, removing it from all others atomically.
function _moveTo(bucket, code, meta = {}) {
    _load();
    for (const k of Object.keys(_db)) delete _db[k][code];
    _db[bucket][code] = { code, ...meta, updatedAt: Date.now(), lastSeenAt: Date.now() };
    _scheduleSave();
    return _db[bucket][code];
}

// ─── Public write API ─────────────────────────────────────────────────────────

/**
 * addNewCode — safe entry point for any new scraped link.
 * Returns: 'added' | 'duplicate' | 'invalid'
 */
function addNewCode(code, meta = {}) {
    const c = _norm(code);
    if (!c) return 'invalid';
    _load();
    if (_db.main[c] || _db.live[c] || _db.dead[c]) return 'duplicate';
    _moveTo('main', c, { status: 'PENDING', source: meta.source || 'scrape', ...meta });
    logger.info(`[LinkValidator] ${c} → MAIN`);
    return 'added';
}

/**
 * markLinkLive — move a code from MAIN → LIVE after successful validation.
 */
async function markLinkLive(code, meta = {}) {
    const c = _norm(code);
    if (!c) return false;
    _load();
    _moveTo('live', c, { status: 'LIVE', ...meta });
    _scheduleSave();
    return true;
}

/**
 * markLinkDead — move a code to DEAD from any bucket.
 */
async function markLinkDead(code, meta = {}) {
    const c = _norm(code);
    if (!c) return false;
    _load();
    _moveTo('dead', c, { status: 'DEAD', ...meta });
    _scheduleSave();
    return true;
}

/**
 * markLinkActive — legacy alias used by pappy-intel / telegram.js.
 * Treats as markLinkLive.
 */
async function markLinkActive(code, meta = {}) {
    return markLinkLive(code, meta);
}

/**
 * returnLinkToMain — called by Join Intel when a live link fails at join time.
 * Sends it back to MAIN for revalidation instead of killing it permanently.
 */
function returnLinkToMain(code, reason = 'join_failed') {
    const c = _norm(code);
    if (!c) return false;
    _load();
    if (!_db.live[c]) return false;
    _moveTo('main', c, { status: 'PENDING', source: 'join_feedback', reason, returnedAt: Date.now() });
    logger.info(`[LinkValidator] ${c} → MAIN (${reason})`);
    return true;
}

/**
 * purgeDeadLink — permanently remove a code from DEAD.
 */
async function purgeDeadLink(code) {
    const c = _norm(code);
    if (!c) return false;
    _load();
    delete _db.dead[c];
    _scheduleSave();
    return true;
}

// ─── Public read API ──────────────────────────────────────────────────────────

function getMainLinks()     { _load(); return Object.values(_db.main); }
function getLiveLinks()     { _load(); return Object.values(_db.live); }
function getDeadLinks()     { _load(); return Object.values(_db.dead); }
function getActiveLinks()   { return getLiveLinks(); }  // legacy alias
function getJoinableLinks() { return getLiveLinks(); }  // legacy alias
function getJoinableCodes() { return getLiveLinks().map(e => e.code); }
function getActiveCodes()   { return getJoinableCodes(); }
function getRetryLinks()    { return []; }   // removed — no retry bucket
function getRequestLinks()  { return []; }  // removed — no request bucket

function getValidatorSummary() {
    _load();
    const live = Object.values(_db.live);
    return {
        intake:   Object.keys(_db.main).length,
        queue:    0,
        active:   live.length,
        joinable: live.length,
        joined:   0,
        retry:    0,
        request:  0,
        dead:     Object.keys(_db.dead).length,
        byStatus: { LIVE: live.length, DEAD: Object.keys(_db.dead).length, PENDING: Object.keys(_db.main).length },
        validationNode: _validationNodeId || 'auto',
        pausedNodes: [..._nodePause.entries()]
            .filter(([, until]) => Date.now() < until)
            .map(([id, until]) => ({ id, resumesIn: Math.round((until - Date.now()) / 60000) + 'min' })),
    };
}

function getValidatorEntry(code) {
    _load();
    const c = _norm(code);
    if (!c) return null;
    return _db.live[c] || _db.dead[c] || _db.main[c] || null;
}

function hasValidatorEntry(code) { return !!getValidatorEntry(code); }

// ─── Validation node management ───────────────────────────────────────────────
let _validationNodeId = null;

function setValidationNode(botId) {
    _validationNodeId = botId ? String(botId).trim() : null;
    logger.info(`[LinkValidator] Validation node: ${_validationNodeId || 'auto'}`);
}
function getValidationNode() { return _validationNodeId; }

function resolveValidationSock() {
    if (_validationNodeId && global.waSocks) {
        for (const [k, s] of global.waSocks.entries()) {
            if (k.includes(_validationNodeId) && s?.user) return s;
        }
    }
    if (global.waSocks) {
        for (const s of global.waSocks.values()) { if (s?.user) return s; }
    }
    return null;
}

function isNodePaused(nodeId) {
    const until = _nodePause.get(String(nodeId || ''));
    return until ? Date.now() < until : false;
}
function pauseNode(nodeId, ms = NODE_PAUSE_MS) {
    const id = String(nodeId || '');
    if (!id) return;
    _nodePause.set(id, Date.now() + ms);
    logger.warn(`[LinkValidator] Node ${id} paused ${Math.round(ms / 60000)}min`);
}
function clearNodePause(nodeId) { _nodePause.delete(String(nodeId || '')); }

// ─── Error classifier ─────────────────────────────────────────────────────────
function classifyJoinError(err) {
    const m = String(err?.message || err || '').toLowerCase();
    const code = Number(err?.output?.statusCode || err?.data?.statusCode || err?.statusCode || 0);
    if (m.includes('not-found') || m.includes('not found') || code === 404) return 'DEAD';
    if (m.includes('revoked') || m.includes('gone') || code === 410)         return 'DEAD';
    if (m.includes('expired') || m.includes('invalid'))                       return 'DEAD';
    if (m.includes('already') || m.includes('already-participant'))           return 'ALREADY_JOINED';
    if (m.includes('approval') || m.includes('request') || code === 406)     return 'REQUEST_REQUIRED';
    if (m.includes('rate') || m.includes('429') || m.includes('too many'))   return 'RATE_LIMITED';
    if (m.includes('spam') || m.includes('flood') || code === 403)           return 'FLOOD_BLOCKED';
    return 'UNKNOWN_FAILURE';
}

// ─── Core: validate a single code (metadata only, no join) ───────────────────
async function validateGroupLink(code, sock = null) {
    const c = _norm(code);
    if (!c) return { valid: false, status: 'DEAD', error: 'invalid_format' };
    if (!sock?.groupGetInviteInfo) return { valid: true, status: 'LIVE', error: null };
    try {
        const info = await sock.groupGetInviteInfo(c);
        // Only LIVE if we get a real group id back
        if (info?.id) return { valid: true, status: 'LIVE', error: null };
        // groupGetInviteInfo returned but no id — treat as dead
        return { valid: false, status: 'DEAD', error: 'no_group_id' };
    } catch (err) {
        const m = String(err?.message || '').toLowerCase();
        // Rate limit / flood / socket errors — transient, keep in Main for retry
        const isTransient = m.includes('rate') || m.includes('429') || m.includes('too many')
            || m.includes('spam') || m.includes('flood') || m.includes('timeout')
            || m.includes('timed out') || m.includes('socket') || m.includes('connection')
            || m.includes('econn') || m.includes('etimedout') || m.includes('unavailable');
        if (isTransient) return { valid: false, status: 'PENDING', error: m };
        // not-authorized/403/forbidden = group exists but bot can't join = DEAD
        // Everything else (not-found, gone, bad-request, expired, invalid, revoked) = DEAD
        return { valid: false, status: 'DEAD', error: m };
    }
}

/**
 * recordJoinOutcome — called by Join Intel after every real join attempt.
 * SUCCESS / ALREADY_JOINED / REQUEST_REQUIRED → keep in LIVE (already there).
 * DEAD errors → return to MAIN for revalidation.
 * RATE_LIMITED / FLOOD_BLOCKED → return to MAIN, pause node.
 */
async function recordJoinOutcome(code, outcome, meta = {}) {
    const c = _norm(code);
    if (!c) return;
    _load();
    const nodeId = String(meta.botId || meta.nodeId || '');

    if (outcome === 'DEAD' || outcome === 'EXPIRED' || outcome === 'REVOKED' || outcome === 'INVALID') {
        returnLinkToMain(c, `join_outcome_${outcome.toLowerCase()}`);
    } else if (outcome === 'RATE_LIMITED' || outcome === 'FLOOD_BLOCKED') {
        returnLinkToMain(c, `join_outcome_${outcome.toLowerCase()}`);
        if (nodeId) pauseNode(nodeId);
    }
    // SUCCESS / ALREADY_JOINED / REQUEST_REQUIRED — link stays in LIVE, nothing to move

    await _flush().catch(() => {});
    try { eventBus.emit('validator.commit', { code: c, outcome, nodeId, updatedAt: Date.now() }); } catch {}
}

// ─── Batch validation (MAIN → LIVE or DEAD) ───────────────────────────────────
async function validateBatch(codes, sock = null) {
    if (!Array.isArray(codes)) return { valid: [], invalid: [], expired: [] };
    const results = { valid: [], invalid: [], expired: [] };
    for (const code of codes) {
        const { valid, status } = await validateGroupLink(code, sock).catch(() => ({ valid: false, status: 'PENDING' }));
        if (status === 'DEAD') results.expired.push(code);
        else if (valid) results.valid.push(code);
        else results.invalid.push(code);
    }
    return results;
}

async function validateBatchAndAssign(codes, sock = null) {
    const normalized = Array.isArray(codes) ? [...new Set(codes.map(_norm).filter(Boolean))] : [];
    if (!normalized.length) return { valid: [], invalid: [], expired: [] };
    const results = await validateBatch(normalized, sock).catch(() => ({ valid: [], invalid: normalized, expired: [] }));
    for (const code of results.valid) {
        if (!_db.live[code] && !_db.dead[code]) addNewCode(code, { source: 'batch_prescreen' });
    }
    for (const code of [...results.invalid, ...results.expired]) {
        _moveTo('dead', code, { status: 'DEAD', source: 'batch_prescreen' });
    }
    _scheduleSave();
    return results;
}

async function validateAndAssign(code, sock = null) {
    const c = _norm(code);
    if (!c) return { valid: false, status: 'DEAD', error: 'invalid_code' };
    const result = await validateGroupLink(c, sock).catch(err => ({ valid: false, status: 'PENDING', error: err.message }));
    if (result.valid) {
        _moveTo('live', c, { status: 'LIVE', source: 'single_validate', validatedAt: Date.now() });
        _scheduleSave();
    } else if (result.status === 'DEAD') {
        _moveTo('dead', c, { status: 'DEAD', source: 'single_validate', lastError: result.error });
        _scheduleSave();
    }
    return result;
}

// ─── Retest dead links ────────────────────────────────────────────────────────
async function retestDeadLinksWithNode(sock = null) {
    _load();
    const deadCodes = Object.keys(_db.dead);
    const results = [];
    for (const code of deadCodes) {
        const check = await validateGroupLink(code, sock).catch(() => ({ valid: false, status: 'DEAD' }));
        if (check.valid || check.status === 'LIVE') {
            _moveTo('main', code, { status: 'PENDING', source: 'dead_retest', returnedAt: Date.now() });
            results.push({ code, restored: true });
        } else {
            // PENDING = transient error, leave in dead for now
            // DEAD = confirmed dead, stays dead
            results.push({ code, restored: false });
        }
    }
    _scheduleSave();
    return results;
}

// ─── Reset all links back to MAIN ────────────────────────────────────────────
async function resetAllValidatorLinksToIntake() {
    _load();
    let moved = 0;
    for (const code of Object.keys(_db.live)) {
        _moveTo('main', code, { status: 'PENDING', source: 'admin_reset', resetAt: Date.now() });
        moved++;
    }
    await _flush().catch(() => {});
    return { moved, total: moved };
}

// ─── Intel DB dedup (no-op stub — kept for compat) ───────────────────────────
async function deduplicateIntelDb() { return { deduped: 0, removed: 0 }; }
async function watchAndCleanupIntelDB() {}

// ─── Startup ──────────────────────────────────────────────────────────────────
function startValidator() {
    _load();
    logger.success('[LinkValidator] Started (3-bucket: main/live/dead)');
}

// ─── Legacy shims ─────────────────────────────────────────────────────────────
async function initValidationCache() { _load(); }
async function saveValidationCache() { await _flush().catch(() => {}); }
async function initValidatorState()  { _load(); }
async function moveActiveToIntakeAll() { return resetAllValidatorLinksToIntake(); }

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
    STATUS,
    DEAD_STATUSES,
    ACTIVE_STATUSES: new Set(['LIVE', 'PENDING']),
    RETRYABLE_STATUSES: new Set(['PENDING']),

    // Validation node
    setValidationNode, getValidationNode, resolveValidationSock,
    isNodePaused, pauseNode, clearNodePause,

    // Read
    getMainLinks, getLiveLinks, getDeadLinks,
    getActiveLinks, getJoinableLinks, getJoinableCodes, getActiveCodes,
    getRetryLinks, getRequestLinks,
    getValidatorSummary, getValidatorEntry, hasValidatorEntry,

    // Write
    addNewCode,
    markLinkLive, markLinkActive, markLinkDead,
    returnLinkToMain, purgeDeadLink,

    // Outcome recording
    recordJoinOutcome, classifyJoinError,

    // Validation
    validateGroupLink, validateBatch, validateBatchAndAssign, validateAndAssign,

    // Maintenance
    retestDeadLinksWithNode, deduplicateIntelDb, watchAndCleanupIntelDB,
    startValidator, resetAllValidatorLinksToIntake, moveActiveToIntakeAll,

    // Legacy shims
    initValidationCache, saveValidationCache, initValidatorState,
    getIntakeCount: () => { _load(); return Object.keys(_db.main).length; },
    getQueueCount:  () => 0,
    restoreLinkToActive: async (code, meta) => markLinkLive(code, meta),
};
