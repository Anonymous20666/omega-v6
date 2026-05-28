'use strict';
// plugins/pappy-triggers.js — Auto-response triggers

const fs   = require('fs');
const path = require('path');
const logger = require('../core/logger');

const DB_PATH = path.join(__dirname, '../data/triggers.json');

// Default built-in triggers (keyword → responses array, one picked at random)
const DEFAULT_TRIGGERS = {
    'pappy':       ['yeah?', 'who called?', 'sup', 'talk to me', 'i\'m here, what you want'],
    'good morning':['morning 🌅', 'rise and grind', 'morning, now get to work'],
    'good night':  ['night 🌙', 'rest up', 'sleep tight, don\'t let the bedbugs bite 😂'],
    'lol':         ['😂', '💀', 'bro really typed lol', 'not even funny tho'],
    'gm':          ['gm', 'morning', '🌅'],
    'gn':          ['gn', 'night 🌙', 'sleep well'],
    'yo':          ['yo', 'what\'s good', 'sup'],
    'gg':          ['gg', 'easy', 'no diff 😈'],
    'facts':       ['💯', 'real talk', 'no cap'],
    'cap':         ['nah fr tho', '💯 no cap', 'that\'s not cap bro'],
    'no cap':      ['💯', 'real', 'say less'],
    'ratio':       ['ratio attempt spotted 💀', 'not today bro', 'the ratio failed, go home'],
    'slay':        ['💅', 'periodt', 'you ate that fr'],
    'fr':          ['fr fr', 'no cap', '💯'],
    'ngl':         ['respect the honesty', 'real talk', 'say less'],
    'bet':         ['bet', 'say less', 'locked in 🔒'],
    'lowkey':      ['lowkey same', 'say it louder', 'you scared to commit 😂'],
    'bruh':        ['💀', 'bro said bruh 💀', 'i feel that'],
    'sus':         ['📍 noted', '👀', 'very sus energy in here'],
    'sheesh':      ['SHEEEESH 🥶', '❄️ cold', 'bro went crazy'],
};

let _triggers = {}; // merged: defaults + custom
let _writePending = false;

function loadTriggers() {
    try {
        const raw = fs.readFileSync(DB_PATH, 'utf8');
        const custom = JSON.parse(raw);
        _triggers = { ...DEFAULT_TRIGGERS, ...custom };
    } catch {
        _triggers = { ...DEFAULT_TRIGGERS };
    }
}

async function saveTriggers(custom) {
    if (_writePending) return;
    _writePending = true;
    try {
        await fs.promises.writeFile(DB_PATH, JSON.stringify(custom, null, 2), 'utf8');
        loadTriggers();
    } finally {
        _writePending = false;
    }
}

function getCustom() {
    try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return {}; }
}

function match(text) {
    if (!text) return null;
    const lower = text.toLowerCase().trim();
    for (const [keyword, responses] of Object.entries(_triggers)) {
        // Match if the message IS the keyword or CONTAINS it as a whole word
        const regex = new RegExp(`(^|\\s)${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|[!?.,])`, 'i');
        if (regex.test(lower) || lower === keyword) {
            return responses[Math.floor(Math.random() * responses.length)];
        }
    }
    return null;
}

loadTriggers();

module.exports = {
    category: 'TRIGGERS',
    commands: [
        { cmd: '.addtrigger',  role: 'admin' },
        { cmd: '.deltrigger',  role: 'admin' },
        { cmd: '.triggers',    role: 'public' },
    ],

    // Called by commandRouter on every message — checks non-command messages too
    checkTrigger: (text) => match(text),

    execute: async ({ sock, msg, args, text, user }) => {
        const jid = msg.key.remoteJid;
        const cmd = text.split(' ')[0].toLowerCase();

        if (cmd === '.triggers') {
            const custom = getCustom();
            const builtinKeys = Object.keys(DEFAULT_TRIGGERS).join(', ');
            const customKeys  = Object.keys(custom).length ? Object.keys(custom).join(', ') : 'none yet';
            return sock.sendMessage(jid, {
                text: `*ACTIVE TRIGGERS*\n\n*Built-in:*\n${builtinKeys}\n\n*Custom:*\n${customKeys}\n\nAdd yours: .addtrigger word | response1 | response2`
            }, { quoted: msg });
        }

        if (cmd === '.addtrigger') {
            // Usage: .addtrigger keyword | response1 | response2
            const full = args.join(' ');
            const parts = full.split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length < 2) return sock.sendMessage(jid, { text: 'Usage: .addtrigger keyword | response1 | response2' }, { quoted: msg });
            const keyword   = parts[0].toLowerCase();
            const responses = parts.slice(1);
            const custom = getCustom();
            custom[keyword] = responses;
            await saveTriggers(custom);
            return sock.sendMessage(jid, { text: `✅ Trigger added: "${keyword}" → ${responses.length} response(s)` }, { quoted: msg });
        }

        if (cmd === '.deltrigger') {
            const keyword = args.join(' ').toLowerCase().trim();
            if (!keyword) return sock.sendMessage(jid, { text: 'Usage: .deltrigger keyword' }, { quoted: msg });
            const custom = getCustom();
            if (!custom[keyword]) return sock.sendMessage(jid, { text: `No custom trigger found for "${keyword}"` }, { quoted: msg });
            delete custom[keyword];
            await saveTriggers(custom);
            return sock.sendMessage(jid, { text: `🗑️ Trigger removed: "${keyword}"` }, { quoted: msg });
        }
    }
};
