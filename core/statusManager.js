// core/statusManager.js
'use strict';

const logger = require('./logger');
const { buildLinkPreview } = require('./linkPreview');


async function getGroups(sock) {
    const botId = sock.user?.id?.split(':')[0];
    if (!botId) { logger.error('[StatusManager] Socket has no user ID'); return []; }
    try {
        const groups = await require('./groupCache').getAllGroups(sock, true);
        const jids = Object.keys(groups);
        logger.info(`[${botId}] Groups fetched: ${jids.length}`);
        return jids;
    } catch (err) {
        logger.error(`[${botId}] Failed to fetch groups: ${err.message}`);
        return [];
    }
}

/**
 * Broadcast a status to all groups with batching, anti-ban delays, retry, and progress.
 * @param {Object}  sock
 * @param {string}  text
 * @param {Object}  [opts]
 * @param {number}  [opts.batchSize=10]      groups per batch
 * @param {number}  [opts.batchDelayMs=4000] delay between batches (anti-ban)
 * @param {number}  [opts.msgDelayMs=800]    delay between individual sends
 * @param {number}  [opts.retries=2]         retries per group on failure
 * @param {string}  [opts.reportJid]         JID to send progress reports to
 * @param {Object}  [opts.nativeContextInfo] pre-built WA contextInfo
 */
async function postTextStatus(sock, text, opts = {}) {
    const {
        batchSize    = 10,
        batchDelayMs = 4000,
        msgDelayMs   = 800,
        retries      = 2,
        reportJid    = null,
        nativeContextInfo = null,
    } = opts;

    const botId = sock.user?.id?.split(':')[0] || 'unknown';

    try {
        const groupJids = await getGroups(sock);
        if (!groupJids.length) {
            logger.warn(`[${botId}] No groups found for status broadcast`);
            return { success: 0, failed: 0, total: 0 };
        }

        // Build payload once
        const payload = { text };
        if (nativeContextInfo) {
            payload.contextInfo = nativeContextInfo;
            if (payload.contextInfo.externalAdReply) payload.contextInfo.externalAdReply.renderLargerThumbnail = true;
        } else {
            try {
                const preview = await buildLinkPreview(text);
                if (preview) payload.contextInfo = preview;
            } catch {}
        }

        let success = 0;
        let failed = 0;
        const total = groupJids.length;
        const failedJids = [];

        // Split into batches
        for (let batchStart = 0; batchStart < total; batchStart += batchSize) {
            const batch = groupJids.slice(batchStart, batchStart + batchSize);

            for (const jid of batch) {
                let sent = false;
                for (let attempt = 0; attempt <= retries; attempt++) {
                    try {
                        await sock.sendMessage('status@broadcast', payload, { statusJidList: [jid] });
                        sent = true;
                        break;
                    } catch (err) {
                        const isLast = attempt === retries;
                        if (!isLast) {
                            await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
                        }
                    }
                }
                if (sent) { success++; } else { failed++; failedJids.push(jid); }
                await new Promise(r => setTimeout(r, msgDelayMs));
            }

            // Progress report after each batch
            if (reportJid && batchStart + batchSize < total) {
                const done = Math.min(batchStart + batchSize, total);
                sock.sendMessage(reportJid, {
                    text: `📡 *Status Progress*\n✅ ${done}/${total} sent (${success} ok, ${failed} failed)`
                }).catch(() => {});
            }

            // Anti-ban delay between batches
            if (batchStart + batchSize < total) {
                await new Promise(r => setTimeout(r, batchDelayMs));
            }
        }

        logger.success(`[${botId}] Status broadcast done: ${success}/${total} (${failed} failed)`);

        // Final report
        if (reportJid) {
            sock.sendMessage(reportJid, {
                text: `✅ *Status Broadcast Complete*\n📊 Total: ${total}\n✅ Success: ${success}\n❌ Failed: ${failed}`
            }).catch(() => {});
        }

        return { success, failed, total, failedJids };

    } catch (err) {
        logger.error(`[${botId}] Status broadcast error: ${err.message}`);
        return { success: 0, failed: 0, total: 0 };
    }
}

module.exports = { postTextStatus, getGroups };
