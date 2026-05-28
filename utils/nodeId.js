'use strict';
// utils/nodeId.js — Single source of truth for this instance's NODE_ID

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const NODE_ID_PATH = path.join(__dirname, '../data/node-id.txt');

function loadOrCreate() {
    const dir = path.dirname(NODE_ID_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(NODE_ID_PATH)) {
        const id = fs.readFileSync(NODE_ID_PATH, 'utf8').trim();
        if (id) return id;
    }

    const id = 'NODE_' + crypto.randomBytes(3).toString('hex').toUpperCase();
    fs.writeFileSync(NODE_ID_PATH, id, 'utf8');
    return id;
}

const NODE_ID = loadOrCreate();
module.exports = NODE_ID;
