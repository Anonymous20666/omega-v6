#!/usr/bin/env node
"use strict";
const path = require('path');
const fsp = require('fs').promises;
const fs = require('fs');
const { validateBatchAndAssign, startValidator, saveValidationCache, getValidatorSummary } = require('../core/linkValidator');
const logger = require('../core/logger');
const { connectDB } = require('../core/database');
const Intel = require('../core/models/Intel');

async function main() {
    const intelPath = path.join(__dirname, '../data/intel.json');
    if (!fs.existsSync(intelPath)) {
        console.error('intel.json not found at', intelPath);
        process.exit(1);
    }

    // initialize validator state (loads caches)
    try { startValidator(); } catch (e) { /* ignore */ }

    const raw = JSON.parse(await fsp.readFile(intelPath, 'utf8'));
    const knownLinks = Array.isArray(raw.knownLinks) ? raw.knownLinks.slice() : [];
    const pendingQueue = Array.isArray(raw.pendingQueue) ? raw.pendingQueue.slice() : [];
    const groupLinks = raw.groupLinks && typeof raw.groupLinks === 'object' ? raw.groupLinks : {};

    const allCodes = new Set();
    knownLinks.forEach((c) => { if (c) allCodes.add(String(c).trim()); });
    pendingQueue.forEach((e) => { const code = (e && (e.code || e)) || null; if (code) allCodes.add(String(code).trim()); });
    for (const links of Object.values(groupLinks)) {
        if (!Array.isArray(links)) continue;
        for (const l of links) {
            const code = (l && (l.code || l)) || null;
            if (code) allCodes.add(String(code).trim());
        }
    }

    // Also import from shared Mongo Intel DB if configured.
    let mongoCodes = 0;
    if (process.env.MONGO_URI && !process.env.MONGO_URI.includes('your_secure_password')) {
        try {
            await connectDB();
            const docs = await Intel.find({}).select('code linkCode').lean();
            docs.forEach((doc) => {
                const code = String(doc?.code || doc?.linkCode || '').trim();
                if (code) allCodes.add(code);
            });
            mongoCodes = docs.length;
        } catch (err) {
            logger.warn('[ImportScript] Failed to read Mongo Intel docs', { error: err.message });
        }
    }

    const codes = Array.from(allCodes).filter(Boolean);
    console.log(`Found ${codes.length} unique Intel codes to import (${mongoCodes} from Mongo, ${knownLinks.length} file known links).`);
    if (!codes.length) {
        console.log('No codes found in Intel DB to import.');
        return;
    }

    // Backup intel.json
    const backupPath = path.join(__dirname, `../data/intel.backup.${Date.now()}.json`);
    await fsp.copyFile(intelPath, backupPath);
    console.log('Backed up intel.json to', backupPath);

    console.log(`Found ${codes.length} unique codes — validating and assigning to validator DB in batches.`);

    // Process in batches to avoid long single-run pressure
    const BATCH = 40;
    for (let i = 0; i < codes.length; i += BATCH) {
        const batch = codes.slice(i, i + BATCH);
        console.log(`Processing batch ${i / BATCH + 1} — ${batch.length} codes`);
        try {
            await validateBatchAndAssign(batch).catch((e) => { logger.warn('[ImportScript] batch validate failed', { error: e?.message || e }); });
        } catch (e) {
            logger.warn('[ImportScript] Unexpected batch error', { error: e?.message || e });
        }
        // small delay to yield
        await new Promise((r) => setTimeout(r, 250));
    }

    // After assigning, clear known/pending/group links to start fresh
    raw.knownLinks = [];
    raw.pendingQueue = [];
    raw.groupLinks = {};
    await fsp.writeFile(intelPath, JSON.stringify(raw, null, 2), 'utf8');
    console.log('Cleared intel.json entries and imported codes to validator DB.');

    // Persist validator cache if any
    await saveValidationCache().catch(() => {});

    const summary = getValidatorSummary();
    console.log(`Validator DB summary: ${summary.active} active, ${summary.dead} dead.`);
    console.log('Import complete. Validator DB updated at data/validator-active.json and data/validator-dead.json');
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Error:', err && err.message ? err.message : err);
        process.exit(1);
    });
}
