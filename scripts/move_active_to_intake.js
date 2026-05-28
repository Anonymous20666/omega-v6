#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '../data');
const { moveActiveToIntakeAll } = require('../core/linkValidator');

async function main() {
    try {
        const res = await moveActiveToIntakeAll();
        console.log(`Moved ${res.moved || 0} codes into intake (via LinkValidator API).`);
    } catch (err) {
        console.error('Failed to move active to intake:', err && err.message ? err.message : err);
        process.exit(1);
    }
}

if (require.main === module) main();
