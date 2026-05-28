#!/usr/bin/env node
'use strict';
const v = require('../core/linkValidator');
const logger = require('../core/logger');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runOnce({ maxIterations = 200, delayMs = 500 } = {}) {
    try {
        // Ensure validator started
        v.startValidator();
    } catch (e) {}

    let it = 0;
    while (it++ < maxIterations) {
        const intake = v.getIntakeCount ? v.getIntakeCount() : 0;
        const queue = v.getQueueCount ? v.getQueueCount() : 0;
        logger.info(`[RunValidator] Iteration ${it} — intake=${intake} queue=${queue}`);
        if (intake > 0) {
            v._popIntakeToQueue(100);
        }
        if (queue > 0) {
            await v._processValidationQueueOnce(null, 50).catch(err => logger.warn('[RunValidator] worker err', err.message));
        }
        if (intake === 0 && queue === 0) break;
        await sleep(delayMs);
    }

    const summary = v.getValidatorSummary();
    console.log('Validation run complete — summary:', summary);
}

if (require.main === module) {
    runOnce().catch(err => {
        console.error('Run failed:', err && err.message ? err.message : err);
        process.exit(1);
    });
}
