'use strict';

const logger = require('./logger');
const runtimeFlags = require('./runtimeFlags');
const { buildLinkPreview, extractUrls } = require('./linkPreview');

function normalizeOutgoingText(text) {
    return String(text || '').replace(/\u0000/g, '').trim();
}

// Per-node backoff state when WA returns rate-overlimit
const _rateBackoff = new Map(); // botId -> { until: timestamp }

function isRateBacked(sock) {
    const botId = sock?.user?.id?.split(':')[0] || 'global';
    const entry = _rateBackoff.get(botId);
    if (!entry) return false;
    if (Date.now() < entry.until) return true;
    _rateBackoff.delete(botId);
    return false;
}

function setRateBackoff(sock, ms = 30000) {
    const botId = sock?.user?.id?.split(':')[0] || 'global';
    _rateBackoff.set(botId, { until: Date.now() + ms });
    logger.warn(`[ResponseEngine] rate-overlimit — backing off ${Math.round(ms / 1000)}s for ${botId}`);
}

async function sendPremiumText(sock, jid, text, opts = {}) {
    const safeText = normalizeOutgoingText(text);
    if (!safeText) return null;

    // Don't even try if node is in rate backoff
    if (isRateBacked(sock)) {
        logger.warn(`[ResponseEngine] Skipping send — node in rate backoff`);
        return null;
    }

    const sendOptions = opts.sendOptions || {};
    const quoted = opts.quoted;
    const hasLink = extractUrls(safeText).length > 0;

    const doSend = async () => {
        if (runtimeFlags.premiumResponseEngine && runtimeFlags.preserveLinkMetadata && hasLink) {
            try {
                const preview = await buildLinkPreview(safeText, false).catch(() => null);
                if (preview?.externalAdReply) {
                    preview.externalAdReply.renderLargerThumbnail = true;
                }
                if (preview) {
                    return await sock.sendMessage(
                        jid,
                        { text: safeText, contextInfo: preview },
                        quoted ? { ...sendOptions, quoted } : sendOptions
                    );
                }
            } catch (err) {
                logger.warn('[ResponseEngine] Link-preview route failed, using plain send', { error: err.message });
            }
        }
        return await sock.sendMessage(
            jid,
            { text: safeText },
            quoted ? { ...sendOptions, quoted } : sendOptions
        );
    };

    // Retry once with backoff on rate-overlimit
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await doSend();
        } catch (err) {
            const msg = String(err?.message || '').toLowerCase();
            if (msg.includes('rate-overlimit') || msg.includes('rate_overlimit')) {
                setRateBackoff(sock, 30000);
                return null; // don't retry rate-overlimit
            }
            if (msg.includes('connection_closing') || msg.includes('connection closed') || msg.includes('timed out')) {
                if (attempt === 0) {
                    await new Promise(r => setTimeout(r, 2000));
                    continue; // retry once
                }
            }
            throw err;
        }
    }
    return null;
}

module.exports = {
    sendPremiumText,
    normalizeOutgoingText,
    setRateBackoff,
    isRateBacked,
};
