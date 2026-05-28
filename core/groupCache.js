// core/groupCache.js
// Centralized group metadata cache — single source of truth for all plugins
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CACHE_FILE = path.join(__dirname, '../data/group_meta_cache.json');
const TTL_MS     = 45 * 60 * 1000; // 45 min
const MAX_ENTRIES = 2000;
const WARMUP_COOLDOWN_MS = 20 * 60 * 1000;

// In-memory store: botId -> Map<jid, { data, ts }>
const _caches = new Map(); // per-bot cache
let _savePending = false;
let _loadPromise = null;
const _warmupState = new Map(); // botId -> { at, running }

function _getCache(sock) {
    const botId = String(sock?.user?.id?.split(':')[0] || 'global');
    if (!_caches.has(botId)) _caches.set(botId, new Map());
    return { cache: _caches.get(botId), botId };
}

// ── Load from disk on startup ──────────────────────────────────────────────
async function _load() {
    try {
        const rawText = await fs.promises.readFile(CACHE_FILE, 'utf8').catch(() => '');
        if (!rawText) return;
        const raw = JSON.parse(rawText);
        const now = Date.now();
        let loaded = 0;
        for (const [botId, groups] of Object.entries(raw || {})) {
            if (typeof groups !== 'object') continue;
            const cache = new Map();
            for (const [jid, entry] of Object.entries(groups)) {
                if (entry?.ts && (now - entry.ts) < TTL_MS) { cache.set(jid, entry); loaded++; }
            }
            if (cache.size > 0) _caches.set(botId, cache);
        }
        if (loaded > 0) logger.info(`[GroupCache] Loaded ${loaded} groups from disk`);
    } catch (e) {
        logger.warn(`[GroupCache] Failed to load cache: ${e.message}`);
    }
}

// ── Persist to disk (debounced 3s) ────────────────────────────────────────
function _persist() {
    if (_savePending) return;
    _savePending = true;
    setTimeout(async () => {
        try {
            const obj = {};
            for (const [botId, cache] of _caches.entries()) {
                obj[botId] = {};
                for (const [jid, entry] of cache.entries()) obj[botId][jid] = entry;
            }
            await fs.promises.mkdir(path.dirname(CACHE_FILE), { recursive: true });
            await fs.promises.writeFile(CACHE_FILE, JSON.stringify(obj));
        } catch (e) {
            logger.warn(`[GroupCache] Failed to persist: ${e.message}`);
        } finally {
            _savePending = false;
        }
    }, 3000);
}

// ── Evict expired + overflow entries ─────────────────────────────────────
function _evict() {
    const now = Date.now();
    for (const [, cache] of _caches.entries()) {
        for (const [jid, entry] of cache.entries()) {
            if (!entry?.ts || (now - entry.ts) >= TTL_MS) cache.delete(jid);
        }
        if (cache.size > MAX_ENTRIES) {
            const sorted = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
            sorted.slice(0, cache.size - MAX_ENTRIES).forEach(([jid]) => cache.delete(jid));
        }
    }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Get group metadata — returns cache if fresh, otherwise fetches from WA.
 * @param {object} sock - Baileys socket
 * @param {string} jid  - Group JID
 */
async function getGroupMeta(sock, jid) {
    const { cache } = _getCache(sock);
    const entry = cache.get(jid);
    if (entry && (Date.now() - entry.ts) < TTL_MS) return entry.data;
    try {
        const meta = await sock.groupMetadata(jid);
        cache.set(jid, { data: meta, ts: Date.now() });
        _persist();
        return meta;
    } catch (err) {
        if (entry) return entry.data;
        throw err;
    }
}

/**
 * Get all groups the bot is in — returns cache if any fresh entries exist,
 * otherwise fetches all from WA and bulk-stores them.
 * @param {object} sock - Baileys socket
 * @param {boolean} forceRefresh - bypass cache
 */
async function getAllGroups(sock, forceRefresh = false) {
    const { cache, botId } = _getCache(sock);
    if (!forceRefresh && cache.size > 0) {
        const now = Date.now();
        const fresh = {};
        for (const [jid, entry] of cache.entries()) {
            if ((now - entry.ts) < TTL_MS) fresh[jid] = entry.data;
        }
        if (Object.keys(fresh).length > 0) return fresh;
    }
    try {
        const groups = await sock.groupFetchAllParticipating();
        const now = Date.now();
        _evict();
        for (const [jid, meta] of Object.entries(groups)) {
            cache.set(jid, { data: meta, ts: now });
        }
        _persist();
        logger.info(`[GroupCache] [${botId}] Fetched & cached ${Object.keys(groups).length} groups`);
        return groups;
    } catch (err) {
        logger.warn(`[GroupCache] [${botId}] groupFetchAllParticipating failed: ${err.message} — using stale cache`);
        const stale = {};
        for (const [jid, entry] of cache.entries()) stale[jid] = entry.data;
        return stale;
    }
}

/**
 * Warm up cache for a socket — called on connection.open
 * Staggered so it doesn't block the event loop on boot
 */
async function warmUp(sock) {
    const { cache, botId } = _getCache(sock);
    const now = Date.now();
    const state = _warmupState.get(botId) || { at: 0, running: false };
    if (state.running) return;
    if (now - Number(state.at || 0) < WARMUP_COOLDOWN_MS) return;
    state.running = true;
    _warmupState.set(botId, state);
    // Stagger warmup per session — each bot gets a different delay so they don't all
    // hammer groupFetchAllParticipating at the same time and trigger rate-overlimit
    const sessionIndex = _caches.size;
    const staggerMs = 10000 + (sessionIndex * 30000); // 10s, 40s, 70s, 100s, 130s
    setTimeout(async () => {
        try {
            if (sock?.ws?.readyState !== 1) return;
            // Skip if cache already has enough fresh data from disk.
            const checkNow = Date.now();
            const freshCount = [...cache.entries()].filter(([, e]) => (checkNow - e.ts) < TTL_MS).length;
            if (freshCount > 50) {
                logger.info(`[GroupCache] [${botId}] Skipping warm-up — ${freshCount} fresh entries already cached`);
                return;
            }
            const groups = await sock.groupFetchAllParticipating();
            let added = 0;
            for (const [jid, meta] of Object.entries(groups)) {
                if (!cache.has(jid) || (checkNow - cache.get(jid).ts) > TTL_MS) {
                    cache.set(jid, { data: meta, ts: checkNow });
                    added++;
                }
            }
            if (added > 0) {
                _persist();
                logger.info(`[GroupCache] [${botId}] Warmed ${added} new groups (total: ${cache.size})`);
            }
        } catch (e) {
            logger.warn(`[GroupCache] [${botId}] Warm-up failed: ${e.message}`);
        } finally {
            const done = _warmupState.get(botId) || { at: 0, running: false };
            done.at = Date.now();
            done.running = false;
            _warmupState.set(botId, done);
        }
    }, staggerMs);
}

/**
 * Invalidate a single group (e.g. after participant change)
 */
function invalidate(jid, sock) {
    if (sock) { const { cache } = _getCache(sock); cache.delete(jid); return; }
    for (const cache of _caches.values()) cache.delete(jid);
}

function set(jid, meta, sock) {
    if (sock) { const { cache } = _getCache(sock); cache.set(jid, { data: meta, ts: Date.now() }); }
    _persist();
}

function isAdmin(jid, senderJid, sock) {
    if (!sock) return false;
    const { cache } = _getCache(sock);
    const entry = cache.get(jid);
    if (!entry || (Date.now() - entry.ts) >= TTL_MS) return false;
    const norm = String(senderJid || '').replace(/:\d+(?=@)/g, '');
    const p = (entry.data?.participants || []).find(p => {
        const pid = String(p?.id || '');
        return pid === senderJid || pid === norm || pid.replace(/:\d+(?=@)/g, '') === norm;
    });
    return !!(p?.admin);
}

/**
 * Async admin check with fallback: tries cache first, then refreshes if stale.
 * @param {string} jid - Group JID
 * @param {string} senderJid - Sender JID
 * @param {object} sock - Baileys socket
 * @param {number} timeoutMs - Max wait time (default 2000ms)
 * @returns {Promise<boolean>}
 */
async function isAdminWithFallback(jid, senderJid, sock, timeoutMs = 2000) {
    if (!sock) return false;
    
    // Fast path: try cache first
    const cached = isAdmin(jid, senderJid, sock);
    if (cached) return true;
    
    // Slow path: refresh metadata if cache miss/stale
    try {
        await Promise.race([
            getGroupMeta(sock, jid),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
        ]);
        // After refresh, check again
        return isAdmin(jid, senderJid, sock);
    } catch (err) {
        // Timeout or error: fallback to cached result even if stale
        const { cache } = _getCache(sock);
        const entry = cache.get(jid);
        if (!entry) return false;
        const norm = String(senderJid || '').replace(/:\d+(?=@)/g, '');
        const p = (entry.data?.participants || []).find(p => {
            const pid = String(p?.id || '');
            return pid === senderJid || pid === norm || pid.replace(/:\d+(?=@)/g, '') === norm;
        });
        return !!(p?.admin);
    }
}

function stats() {
    const result = {};
    for (const [botId, cache] of _caches.entries()) result[botId] = cache.size;
    return result;
}

// Load on module init without blocking startup
_loadPromise = _load();

// Periodic eviction every 30 min
setInterval(_evict, 30 * 60 * 1000).unref();

module.exports = { getGroupMeta, getAllGroups, warmUp, invalidate, set, isAdmin, isAdminWithFallback, stats };
