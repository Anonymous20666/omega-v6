'use strict';
// modules/pairingRegistry.js — One bot per user enforcement

const fsp  = require('fs').promises;
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/pairing_registry.json');
let _registry = {}; // tgUserId → phoneNumber
let _writePending = false;

async function load() {
    try { _registry = JSON.parse(await fsp.readFile(DB_PATH, 'utf8')); }
    catch { _registry = {}; }
}

async function save() {
    if (_writePending) return;
    _writePending = true;
    try { await fsp.writeFile(DB_PATH, JSON.stringify(_registry, null, 2), 'utf8'); }
    finally { _writePending = false; }
}

function getPhone(tgUserId) { return _registry[String(tgUserId)] || null; }
function hasBot(tgUserId)   { return !!_registry[String(tgUserId)]; }

function getUserIdByPhone(phoneNumber) {
    const target = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (!target) return null;
    for (const [tgUserId, phone] of Object.entries(_registry)) {
        if (String(phone || '').replace(/[^0-9]/g, '') === target) return tgUserId;
    }
    return null;
}

async function register(tgUserId, phoneNumber) {
    _registry[String(tgUserId)] = phoneNumber;
    await save();
}

async function unregister(tgUserId) {
    delete _registry[String(tgUserId)];
    await save();
}

async function unregisterByPhone(phoneNumber) {
    const tgUserId = getUserIdByPhone(phoneNumber);
    if (!tgUserId) return;
    delete _registry[String(tgUserId)];
    await save();
}

load().catch(() => {});
module.exports = { getPhone, hasBot, getUserIdByPhone, register, unregister, unregisterByPhone, load };
