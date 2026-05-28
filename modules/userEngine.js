// modules/userEngine.js
const User = require('../core/models/User');
const mongoose = require('mongoose');
const { ownerWhatsAppJids } = require('../config');
const ownerManager = require('./ownerManager');
const logger = require('../core/logger');

const USER_CACHE_TTL_MS = 10 * 60 * 1000;
const USER_DB_TIMEOUT_MS = 400;
const STATIC_OWNER_SET = new Set((ownerWhatsAppJids || []).map((j) => String(j || '').trim()).filter(Boolean));

function normalizeJid(jid) {
    return String(jid || '').trim().replace(/:\d+(?=@)/g, '');
}

function extractDigits(jid) {
    return normalizeJid(jid).replace(/[^0-9]/g, '');
}

function isOwnerFromAnySource(userId) {
    const raw = String(userId || '').trim();
    if (!raw) return false;

    const norm = normalizeJid(raw);
    const digits = extractDigits(raw);
    const staticDigits = new Set(Array.from(STATIC_OWNER_SET).map(extractDigits).filter(Boolean));

    if (STATIC_OWNER_SET.has(raw) || STATIC_OWNER_SET.has(norm) || staticDigits.has(digits)) {
        return true;
    }

    return ownerManager.isOwner(raw) || ownerManager.isOwner(norm) || ownerManager.isOwner(digits);
}

function withTimeout(promise, ms) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('UserEngine timeout')), ms);
        })
    ]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

class UserEngine {
    constructor() {
        this.userCache = new Map();
        this.pendingRefreshes = new Map();
    }

    _canUseDatabase() {
        return mongoose.connection.readyState === 1;
    }

    _getCached(userId) {
        const entry = this.userCache.get(userId);
        if (!entry) return null;
        if (Date.now() - entry.ts > USER_CACHE_TTL_MS) {
            this.userCache.delete(userId);
            return null;
        }
        return entry.user;
    }

    _setCached(userId, user) {
        if (!userId || !user) return;
        this.userCache.set(userId, { user, ts: Date.now() });
    }

    _makeRuntimeUser(userId, name, role) {
        return {
            userId,
            name: name || 'Unknown',
            role,
            activity: { isBanned: false, lastSeen: Date.now() },
            stats: { messagesSent: 0, commandsUsed: 0 }
        };
    }

    _refreshFromDatabase(userId, name = 'Unknown', isGroupAdmin = false) {
        if (!userId || !this._canUseDatabase()) return;
        if (this.pendingRefreshes.has(userId)) return this.pendingRefreshes.get(userId);

        const refreshPromise = (async () => {
            const derivedRole = this._deriveRole(userId, isGroupAdmin);

            try {
                let user = await withTimeout(
                    User.findOne({ userId }).lean().exec(),
                    USER_DB_TIMEOUT_MS
                );

                if (!user) {
                    user = await User.create({ userId, name, role: derivedRole });
                    logger.info(`👤 New user registered: ${name} (${userId})`);
                } else {
                    const updateFields = { "activity.lastSeen": Date.now() };
                    if (derivedRole === 'owner' && user.role !== 'owner') {
                        updateFields.role = 'owner';
                        user.role = 'owner';
                    } else if (derivedRole === 'admin' && user.role === 'public') {
                        updateFields.role = 'admin';
                        user.role = 'admin';
                    }

                    User.updateOne(
                        { userId },
                        { $set: updateFields, $inc: { "stats.messagesSent": 1 } }
                    ).catch(() => {});
                }

                const plainUser = typeof user.toObject === 'function' ? user.toObject() : user;
                this._setCached(userId, plainUser);
            } catch (error) {
                logger.error(`[UserEngine] Database error fetching user ${userId}: ${error.message}`);
            } finally {
                this.pendingRefreshes.delete(userId);
            }
        })();

        this.pendingRefreshes.set(userId, refreshPromise);
        return refreshPromise;
    }

    _deriveRole(userId, isGroupAdmin = false) {
        if (isOwnerFromAnySource(userId)) return 'owner';
        if (isGroupAdmin) return 'admin';
        return 'public';
    }

    /**
     * Fetches an existing user or creates a new one in the database.
     * @param {string} userId - The WhatsApp JID of the user.
     * @param {string} name - The pushname or display name.
     * @param {boolean} isGroupAdmin - Whether the user is currently an admin in the context.
     * @returns {Promise<Object>} The user document.
     */
    async getOrCreate(userId, name = 'Unknown', isGroupAdmin = false) {
        if (!userId) return this._fallbackUser();

        const derivedRole = this._deriveRole(userId, isGroupAdmin);

        const cached = this._getCached(userId);
        if (cached) {
            let resolvedRole = cached.role || 'public';
            if (derivedRole === 'owner' && resolvedRole !== 'owner') resolvedRole = 'owner';
            else if (derivedRole === 'admin' && resolvedRole === 'public') resolvedRole = 'admin';

            const merged = {
                ...cached,
                role: resolvedRole,
                activity: { ...(cached.activity || {}), lastSeen: Date.now() }
            };
            this._setCached(userId, merged);
            return {
                ...merged,
            };
        }

        const fallback = this._makeRuntimeUser(userId, name, derivedRole);
        this._setCached(userId, fallback);
        this._refreshFromDatabase(userId, name, isGroupAdmin);
        return fallback;
    }

    /**
     * Atomically increments the command usage counter for a user.
     * @param {string} userId - The WhatsApp JID.
     */
    async recordCommand(userId) {
        if (!userId) return;
        if (!this._canUseDatabase()) return;
        try {
            await User.updateOne({ userId: userId }, { $inc: { "stats.commandsUsed": 1 } });
        } catch (error) {
            logger.warn(`[UserEngine] Failed to record command for ${userId}`);
        }
    }

    /**
     * Generates a safe fallback user object to prevent crashes if MongoDB goes offline.
     * @private
     */
    _fallbackUser(role = 'public') {
        return { 
            role, 
            activity: { isBanned: false, lastSeen: Date.now() }, 
            stats: { messagesSent: 0, commandsUsed: 0 } 
        };
    }
}

module.exports = new UserEngine();
