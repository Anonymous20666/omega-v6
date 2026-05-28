'use strict';
// core/telegram/forwardedLinkExtractor.js

const logger = require('../logger');
const { addNewCode } = require('../linkValidator');

const INVITE_CODE_RE = /^[0-9A-Za-z]{20,24}$/;

function extractWhatsAppCodes(text) {
    const str = String(text || '');
    const codes = new Set();
    const urlRe = /chat\.whatsapp\.com\/([A-Za-z0-9]{20,24})/gi;
    const waRe  = /wa\.me\/invite\/([A-Za-z0-9]{20,24})/gi;
    const bareRe = /(?:^|[\s,|])([A-Za-z0-9]{20,24})(?:$|[\s,|])/gm;
    let m;
    while ((m = urlRe.exec(str))  !== null) codes.add(m[1]);
    while ((m = waRe.exec(str))   !== null) codes.add(m[1]);
    while ((m = bareRe.exec(str)) !== null) { if (INVITE_CODE_RE.test(m[1])) codes.add(m[1]); }
    return Array.from(codes);
}

/**
 * Try to fetch group info for a code using the running bot socket.
 * Returns { subject, size, joinApprovalMode } or null if unavailable.
 */
async function fetchGroupInfo(code) {
    try {
        const { activeSockets } = require('../whatsapp');
        const sock = Array.from(activeSockets.values()).find(s => s?.user);
        if (!sock) return null;
        const info = await Promise.race([
            sock.groupGetInviteInfo(code),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]);
        if (!info?.id) return null;
        return {
            subject: info.subject || null,
            size: typeof info.size === 'number' ? info.size : null,
            joinApprovalMode: !!info.joinApprovalMode,
        };
    } catch {
        return null;
    }
}

async function processForwardedLinks(text, meta = {}) {
    const codes = extractWhatsAppCodes(text);
    const result = {
        extracted: codes.length,
        added: 0,
        duplicate: 0,
        invalid: 0,
        details: [], // { code, outcome, subject, size, joinApprovalMode }
    };

    for (const code of codes.slice(0, 50)) {
        const outcome = addNewCode(code, {
            source: meta.source || 'telegram_forward',
            addedAt: Date.now(),
            addedBy: meta.userId || null,
        });

        if (outcome === 'added')          result.added++;
        else if (outcome === 'duplicate') result.duplicate++;
        else                              result.invalid++;

        // Fetch group info for new links only (avoid spamming WA for dupes)
        let info = null;
        if (outcome === 'added') {
            info = await fetchGroupInfo(code);
        }

        result.details.push({ code, outcome, ...(info || {}) });
    }

    if (result.added > 0) {
        logger.info(`[ForwardedLinks] +${result.added} new codes → INTAKE (${result.duplicate} dupes, ${result.invalid} invalid)`);
    }

    return result;
}

function escapeHtml(v) {
    return String(v || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatResultMessage(result) {
    if (result.extracted === 0) {
        return '🔍 <b>No WhatsApp links found</b> in that message.';
    }

    const lines = [
        `🔗 <b>LINKS CAPTURED</b>`,
        ``,
        `📊 Found <b>${result.extracted}</b> · ✅ New <b>${result.added}</b> · ♻️ Known <b>${result.duplicate}</b>${result.invalid ? ` · ❌ Invalid <b>${result.invalid}</b>` : ''}`,
    ];

    // Show details for new links
    const newLinks = (result.details || []).filter(d => d.outcome === 'added');
    if (newLinks.length > 0) {
        lines.push('');
        for (const d of newLinks.slice(0, 10)) {
            const name   = d.subject ? `<b>${escapeHtml(d.subject)}</b>` : '<i>Unknown group</i>';
            const size   = typeof d.size === 'number' ? ` · 👥 ${d.size}` : '';
            const lock   = d.joinApprovalMode ? ' · 🔒 Approval' : ' · 🔓 Open';
            const code   = `<code>${escapeHtml(d.code)}</code>`;
            lines.push(`${name}${size}${lock}`);
            lines.push(`↳ ${code}`);
        }
        if (newLinks.length > 10) lines.push(`<i>…and ${newLinks.length - 10} more</i>`);
        lines.push('');
        lines.push(`<i>⏳ Queued for validation → join pool</i>`);
    } else if (result.duplicate === result.extracted) {
        lines.push('');
        lines.push(`<i>All links already in the system.</i>`);
    }

    return lines.join('\n');
}

module.exports = { extractWhatsAppCodes, processForwardedLinks, formatResultMessage };
