'use strict';
// modules/stickerPackManager.js — Per-user Telegram sticker pack management

const fsp  = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '../data/sticker_packs.json');
const BOT_USERNAME = String(process.env.TELEGRAM_BOT_USERNAME || 'pappyv2bot')
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '') || 'pappyv2bot';
const MAX_PACK_SIZE = 120; // Telegram limit per pack

let _db = {}; // { userId: { packName, title, stickers: [file_id, ...] } }
let _writePending = false;

async function load() {
    try { _db = JSON.parse(await fsp.readFile(DB_PATH, 'utf8')); }
    catch { _db = {}; }
}

async function save() {
    if (_writePending) return;
    _writePending = true;
    try { await fsp.writeFile(DB_PATH, JSON.stringify(_db, null, 2), 'utf8'); }
    finally { _writePending = false; }
}

function buildValidStickerSetName(rawPrefix, rawUserId, rawBotUsername) {
    const bot = String(rawBotUsername || BOT_USERNAME)
        .replace(/^@+/, '')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '') || 'pappyv2bot';
    const suffix = `_by_${bot}`;

    const prefix = String(rawPrefix || 'pappy').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'pappy';
    const userPart = String(rawUserId || '').toLowerCase().replace(/[^a-z0-9_]/g, '') || '0';

    let base = `${prefix}_${userPart}`.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (!/^[a-z]/.test(base)) base = `p_${base}`;

    const maxBaseLen = Math.max(1, 64 - suffix.length);
    base = base.slice(0, maxBaseLen).replace(/^_+|_+$/g, '');
    if (!base) base = 'pappy';

    return `${base}${suffix}`;
}

function getPackName(userId) {
    const existing = _db[String(userId)]?.packName;
    if (existing) return String(existing);
    return buildValidStickerSetName('pappy', userId, BOT_USERNAME);
}

function generatePackNameVariants(userId, botUsername, limit = 6) {
    const variants = [];
    const base = buildValidStickerSetName('pappy', userId, botUsername);
    variants.push(base);

    const suffix = `_by_${String(botUsername || BOT_USERNAME).replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'pappyv2bot'}`;
    const basePrefix = base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
    const room = Math.max(1, 64 - suffix.length);

    for (let i = 0; i < limit; i++) {
        const rand = crypto.randomBytes(2).toString('hex');
        const candidatePrefix = `${basePrefix}_${rand}`.replace(/_+/g, '_').slice(0, room).replace(/^_+|_+$/g, '');
        const safePrefix = candidatePrefix || `pappy_${rand}`;
        variants.push(`${safePrefix}${suffix}`);
    }

    return Array.from(new Set(variants));
}

function getPackTitle(userName) {
    return `${userName || 'User'}'s Pappy Pack`;
}

function getUserPack(userId) {
    return _db[String(userId)] || null;
}

async function registerPack(userId, userName, packNameOverride) {
    const packName = String(packNameOverride || getPackName(userId));
    _db[String(userId)] = {
        packName,
        title: getPackTitle(userName),
        stickers: [],
    };
    await save();
    return _db[String(userId)];
}

async function clearPack(userId) {
    delete _db[String(userId)];
    await save();
}

async function addStickerToRecord(userId, fileId) {
    const uid = String(userId);
    if (!_db[uid]) return;
    if (!_db[uid].stickers.includes(fileId)) {
        _db[uid].stickers.push(fileId);
        if (_db[uid].stickers.length > MAX_PACK_SIZE) {
            _db[uid].stickers.shift();
        }
        await save();
    }
}

async function removeStickerFromRecord(userId, fileId) {
    const uid = String(userId);
    if (!_db[uid]) return;
    _db[uid].stickers = _db[uid].stickers.filter(id => id !== fileId);
    await save();
}

load().catch(() => {});

module.exports = {
    buildValidStickerSetName,
    generatePackNameVariants,
    getPackName,
    getPackTitle,
    getUserPack,
    registerPack,
    clearPack,
    addStickerToRecord,
    removeStickerFromRecord,
    BOT_USERNAME,
    MAX_PACK_SIZE,
};
