'use strict';
// modules/aiStickerPack.js — AI sticker pack with mood tagging
// Usage: reply to any sticker + .addsticker [mood] to add it
// Moods: happy, sad, hype, funny, angry, love, cool, shock, default

const fsp  = require('fs').promises;
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/ai_sticker_pack.json');

const VALID_MOODS = ['happy', 'sad', 'hype', 'funny', 'angry', 'love', 'cool', 'shock', 'default'];

// { mood: [fileId, ...] }
let _db = {};
let _dirty = false;

async function load() {
    try { _db = JSON.parse(await fsp.readFile(DB_PATH, 'utf8')); }
    catch { _db = {}; }
    for (const mood of VALID_MOODS) {
        if (!Array.isArray(_db[mood])) _db[mood] = [];
    }
}

async function save() {
    if (_dirty) return;
    _dirty = true;
    try { await fsp.writeFile(DB_PATH, JSON.stringify(_db, null, 2), 'utf8'); }
    finally { _dirty = false; }
}

function normalizeMood(input) {
    const m = String(input || '').toLowerCase().trim();
    return VALID_MOODS.includes(m) ? m : 'default';
}

async function addSticker(fileId, mood = 'default') {
    const m = normalizeMood(mood);
    if (!_db[m]) _db[m] = [];
    if (!_db[m].includes(fileId)) {
        _db[m].push(fileId);
        if (_db[m].length > 50) _db[m].shift(); // cap per mood
        await save();
    }
    return m;
}

async function removeSticker(fileId) {
    let removed = false;
    for (const mood of VALID_MOODS) {
        const before = (_db[mood] || []).length;
        _db[mood] = (_db[mood] || []).filter(id => id !== fileId);
        if (_db[mood].length !== before) removed = true;
    }
    if (removed) await save();
    return removed;
}

function getSticker(mood = 'default') {
    const m = normalizeMood(mood);
    const pool = _db[m] || [];
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    // fallback to default pool
    const def = _db['default'] || [];
    if (def.length) return def[Math.floor(Math.random() * def.length)];
    return null;
}

function getStickerForContext(text = '') {
    const t = text.toLowerCase();
    if (/lol|😂|haha|funny|joke|😆|🤣/.test(t)) return getSticker('funny');
    if (/hype|🔥|fire|lit|go off|let's go|🚀/.test(t)) return getSticker('hype');
    if (/sad|😢|cry|miss|hurt|pain|💔/.test(t)) return getSticker('sad');
    if (/angry|mad|😡|🤬|annoyed|stop/.test(t)) return getSticker('angry');
    if (/love|❤️|💕|crush|heart|adore/.test(t)) return getSticker('love');
    if (/wow|shock|😱|omg|no way|what/.test(t)) return getSticker('shock');
    if (/cool|😎|swag|drip|clean/.test(t)) return getSticker('cool');
    if (/hi|hey|hello|sup|yo|good|great|nice|happy|😊/.test(t)) return getSticker('happy');
    return getSticker('default');
}

function getStats() {
    const stats = {};
    let total = 0;
    for (const mood of VALID_MOODS) {
        stats[mood] = (_db[mood] || []).length;
        total += stats[mood];
    }
    return { stats, total };
}

load().catch(() => {});

module.exports = { addSticker, removeSticker, getSticker, getStickerForContext, getStats, normalizeMood, VALID_MOODS };
