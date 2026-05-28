'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/menu-song-library.json');
const SONG_DIR = path.join(__dirname, '../data/menu-songs');

function ensureStorage() {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.mkdirSync(SONG_DIR, { recursive: true });
}

function fallbackState() {
    return {
        activeId: null,
        songs: [],
        updatedAt: Date.now(),
    };
}

function loadState() {
    ensureStorage();
    try {
        if (!fs.existsSync(DATA_FILE)) return fallbackState();
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const songs = Array.isArray(raw?.songs) ? raw.songs : [];
        const cleaned = songs
            .map((s) => ({
                id: String(s?.id || ''),
                name: String(s?.name || '').trim() || 'Untitled Menu Song',
                filePath: String(s?.filePath || ''),
                mimeType: String(s?.mimeType || 'audio/mpeg'),
                addedBy: String(s?.addedBy || ''),
                createdAt: Number(s?.createdAt || Date.now()),
            }))
            .filter((s) => s.id && s.filePath);

        const activeId = cleaned.some((s) => s.id === raw?.activeId) ? raw.activeId : (cleaned[0]?.id || null);
        return {
            activeId,
            songs: cleaned,
            updatedAt: Number(raw?.updatedAt || Date.now()),
        };
    } catch {
        return fallbackState();
    }
}

function saveState(state) {
    ensureStorage();
    const normalized = {
        activeId: state?.activeId || null,
        songs: Array.isArray(state?.songs) ? state.songs : [],
        updatedAt: Date.now(),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(normalized, null, 2), 'utf8');
    return normalized;
}

function getLibrary() {
    const state = loadState();
    const activeSong = state.songs.find((s) => s.id === state.activeId) || null;
    return { ...state, activeSong };
}

function detectExtFromMime(mimeType) {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
    if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
    if (mime.includes('ogg') || mime.includes('opus')) return 'ogg';
    if (mime.includes('wav')) return 'wav';
    if (mime.includes('aac')) return 'aac';
    return 'mp3';
}

function addSongFromBuffer({ buffer, mimeType, name, addedBy, replaceActive = false }) {
    ensureStorage();
    const state = loadState();
    const id = `ms_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const ext = detectExtFromMime(mimeType);
    const fileName = `${id}.${ext}`;
    const absPath = path.join(SONG_DIR, fileName);
    const relPath = path.relative(path.join(__dirname, '..'), absPath).replace(/\\/g, '/');

    fs.writeFileSync(absPath, buffer);

    const song = {
        id,
        name: String(name || '').trim() || `Menu Song ${state.songs.length + 1}`,
        filePath: relPath,
        mimeType: String(mimeType || 'audio/mpeg'),
        addedBy: String(addedBy || ''),
        createdAt: Date.now(),
    };

    state.songs.push(song);
    if (replaceActive || !state.activeId) state.activeId = id;
    saveState(state);
    return { ...song, absolutePath: absPath };
}

function setActiveSong(songId) {
    const state = loadState();
    const exists = state.songs.some((s) => s.id === songId);
    if (!exists) return null;
    state.activeId = songId;
    saveState(state);
    return state.songs.find((s) => s.id === songId) || null;
}

function switchActive(step = 1) {
    const state = loadState();
    if (!state.songs.length) return null;

    const currentIndex = Math.max(0, state.songs.findIndex((s) => s.id === state.activeId));
    const delta = step >= 0 ? 1 : -1;
    const nextIndex = (currentIndex + delta + state.songs.length) % state.songs.length;
    state.activeId = state.songs[nextIndex].id;
    saveState(state);
    return state.songs[nextIndex];
}

function renameSong(songId, nextName) {
    const state = loadState();
    const song = state.songs.find((s) => s.id === songId);
    if (!song) return null;
    const clean = String(nextName || '').trim();
    if (!clean) return null;
    song.name = clean.slice(0, 80);
    saveState(state);
    return song;
}

function deleteSong(songId) {
    const state = loadState();
    const idx = state.songs.findIndex((s) => s.id === songId);
    if (idx < 0) return null;

    const [removed] = state.songs.splice(idx, 1);
    try {
        const abs = path.join(__dirname, '..', removed.filePath);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {}

    if (!state.songs.length) {
        state.activeId = null;
    } else if (state.activeId === removed.id) {
        state.activeId = state.songs[0].id;
    }

    saveState(state);
    return removed;
}

function getActiveSong() {
    const state = loadState();
    if (!state.activeId) return null;
    const song = state.songs.find((s) => s.id === state.activeId);
    if (!song) return null;
    return {
        ...song,
        absolutePath: path.join(__dirname, '..', song.filePath),
    };
}

module.exports = {
    getLibrary,
    getActiveSong,
    addSongFromBuffer,
    setActiveSong,
    switchActive,
    renameSong,
    deleteSong,
};
