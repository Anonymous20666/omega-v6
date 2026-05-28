'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/ghost-mode.json');
const DEFAULT_MODE = 'auto';
const AUTO_THRESHOLD = 12;

function ensureDir() {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readStoredMode() {
    try {
        if (!fs.existsSync(DATA_FILE)) return DEFAULT_MODE;
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const mode = String(raw?.mode || '').toLowerCase();
        return ['auto', 'on', 'off'].includes(mode) ? mode : DEFAULT_MODE;
    } catch {
        return DEFAULT_MODE;
    }
}

let currentMode = readStoredMode();

function getMode() {
    return currentMode;
}

function setMode(mode) {
    const normalized = String(mode || '').toLowerCase();
    if (!['auto', 'on', 'off'].includes(normalized)) {
        throw new Error('Invalid ghost mode');
    }
    currentMode = normalized;
    ensureDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify({ mode: normalized, updatedAt: Date.now() }, null, 2));
    return currentMode;
}

function shouldUseGhost(batchSize = 1) {
    if (currentMode === 'on') return true;
    if (currentMode === 'off') return false;
    return Number(batchSize || 0) <= AUTO_THRESHOLD;
}

function describeMode(batchSize = 1) {
    if (currentMode === 'on') return 'ON (forced)';
    if (currentMode === 'off') return 'OFF (forced)';
    return shouldUseGhost(batchSize) ? 'ON (auto)' : 'AUTO-OFF (large batch stability mode)';
}

module.exports = {
    AUTO_THRESHOLD,
    getMode,
    setMode,
    shouldUseGhost,
    describeMode,
};
