'use strict';

const fs = require('fs');
const path = require('path');

const TG_ECONOMY_FILE = path.resolve(__dirname, '../../data/tg-game-economy.json');
const TG_MOOD_STICKERS_FILE = path.resolve(__dirname, '../../data/tg-mood-stickers.json');

function loadTgEconomy() {
    try {
        if (!fs.existsSync(TG_ECONOMY_FILE)) return { users: {} };
        return JSON.parse(fs.readFileSync(TG_ECONOMY_FILE, 'utf8'));
    } catch {
        return { users: {} };
    }
}

function saveTgEconomy(data) {
    try {
        fs.mkdirSync(path.dirname(TG_ECONOMY_FILE), { recursive: true });
        fs.writeFileSync(TG_ECONOMY_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch {}
}

function getTgUser(userId) {
    const data = loadTgEconomy();
    const id = String(userId);
    if (!data.users[id]) {
        data.users[id] = {
            coins: 500,
            xp: 0,
            level: 1,
            energy: 100,
            maxEnergy: 100,
            energyUpdatedAt: Date.now(),
            wins: 0,
            losses: 0,
            lastDaily: 0,
            lastSpin: 0,
            streak: 0,
            referrals: 0,
            lastSeenAt: Date.now(),
            inventory: [],
            username: '',
        };
        saveTgEconomy(data);
    }
    if (!Array.isArray(data.users[id].inventory)) data.users[id].inventory = [];
    if (typeof data.users[id].energy !== 'number') data.users[id].energy = 100;
    if (typeof data.users[id].maxEnergy !== 'number') data.users[id].maxEnergy = 100;
    if (typeof data.users[id].energyUpdatedAt !== 'number') data.users[id].energyUpdatedAt = Date.now();
    if (typeof data.users[id].referrals !== 'number') data.users[id].referrals = 0;
    if (typeof data.users[id].lastSeenAt !== 'number') data.users[id].lastSeenAt = Date.now();
    return data.users[id];
}

function saveTgUser(userId, profile) {
    const data = loadTgEconomy();
    data.users[String(userId)] = profile;
    saveTgEconomy(data);
}

function addTgCoins(userId, amount) {
    const p = getTgUser(userId);
    p.coins = Math.max(0, (p.coins || 0) + amount);
    saveTgUser(userId, p);
    return p.coins;
}

function addTgXP(userId, xpAmount) {
    const p = getTgUser(userId);
    p.xp = (p.xp || 0) + xpAmount;
    let leveled = false;
    while (p.xp >= (p.level || 1) * 100) {
        p.xp -= (p.level || 1) * 100;
        p.level = (p.level || 1) + 1;
        leveled = true;
    }
    saveTgUser(userId, p);
    return { profile: p, leveled };
}

function getTgLeaderboard(limit = 10) {
    const data = loadTgEconomy();
    return Object.entries(data.users)
        .map(([id, u]) => ({ id, ...u }))
        .sort((a, b) => (b.coins || 0) - (a.coins || 0))
        .slice(0, limit);
}

function loadTgMoodStickers() {
    try {
        if (!fs.existsSync(TG_MOOD_STICKERS_FILE)) return {};
        return JSON.parse(fs.readFileSync(TG_MOOD_STICKERS_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveTgMoodStickers(data) {
    try {
        fs.mkdirSync(path.dirname(TG_MOOD_STICKERS_FILE), { recursive: true });
        fs.writeFileSync(TG_MOOD_STICKERS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch {}
}

function addMoodSticker(mood, fileId) {
    const data = loadTgMoodStickers();
    const m = String(mood).toLowerCase().trim();
    if (!data[m]) data[m] = [];
    if (!data[m].includes(fileId)) data[m].push(fileId);
    saveTgMoodStickers(data);
    return data[m].length;
}

function pickMoodSticker(mood) {
    const data = loadTgMoodStickers();
    const m = String(mood).toLowerCase().trim();
    const arr = data[m] || [];
    if (!arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
}

function listMoods() {
    return Object.keys(loadTgMoodStickers());
}

const tgAwaitingMoodSticker = new Map();

module.exports = {
    loadTgEconomy,
    saveTgEconomy,
    getTgUser,
    saveTgUser,
    addTgCoins,
    addTgXP,
    getTgLeaderboard,
    loadTgMoodStickers,
    saveTgMoodStickers,
    addMoodSticker,
    pickMoodSticker,
    listMoods,
    tgAwaitingMoodSticker,
};
