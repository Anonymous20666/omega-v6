'use strict';

const logger = require('./logger');

const HEAVY_COMMAND_MAX_PENDING = Math.max(20, Number(process.env.HEAVY_COMMAND_MAX_PENDING || 120));
const queues = new Map(); // botId -> { running, items }

function getQueue(botId) {
    const key = String(botId || 'global');
    if (!queues.has(key)) {
        queues.set(key, { running: false, items: [] });
    }
    return queues.get(key);
}

function runNext(botId) {
    const key = String(botId || 'global');
    const q = getQueue(key);
    if (q.running) return;

    const next = q.items.shift();
    if (!next) return;

    q.running = true;
    Promise.resolve()
        .then(() => next.run())
        .catch((err) => {
            logger.warn(`[CommandScheduler] Heavy command failed (${next.commandName}): ${err.message}`);
        })
        .finally(() => {
            q.running = false;
            setImmediate(() => runNext(key));
        });
}

function enqueueHeavyCommand({ botId, commandName, run }) {
    const key = String(botId || 'global');
    const q = getQueue(key);

    if (q.items.length >= HEAVY_COMMAND_MAX_PENDING) {
        return { enqueued: false, reason: 'queue-full', pending: q.items.length };
    }

    q.items.push({ commandName: String(commandName || '').toLowerCase(), run });
    setImmediate(() => runNext(key));

    return { enqueued: true, reason: 'queued', pending: q.items.length };
}

module.exports = {
    enqueueHeavyCommand,
};
