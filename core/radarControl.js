'use strict';

const fs = require('fs');
const path = require('path');

const RADAR_STATE_FILE = path.join(__dirname, '../data/radar-state.json');

function readState() {
    try {
        if (!fs.existsSync(RADAR_STATE_FILE)) return {};
        const parsed = JSON.parse(fs.readFileSync(RADAR_STATE_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(RADAR_STATE_FILE), { recursive: true });
    fs.writeFileSync(RADAR_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function normalizeBotId(botId) {
    return String(botId || '').trim();
}

function isRadarEnabled(botId) {
    const id = normalizeBotId(botId);
    if (!id) return true;
    const state = readState();
    if (typeof state[id] !== 'boolean') return true;
    return state[id];
}

function setRadarEnabled(botId, enabled) {
    const id = normalizeBotId(botId);
    if (!id) return;
    const state = readState();
    state[id] = !!enabled;
    writeState(state);
}

module.exports = {
    isRadarEnabled,
    setRadarEnabled,
};
