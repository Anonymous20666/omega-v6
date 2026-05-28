/**
 * 🔗 INTEL BROADCAST COMMAND
 * 
 * Handles per-node Intel DB link retrieval and pagination
 * Telegram users can request "send all intel links" to get stored WhatsApp group invites
 * 
 * Features:
 * - Paginated display (10 links per page)
 * - Shows group name, member count, code, validation status
 * - Next/Previous navigation
 * - Per-node filtering (each node has its own Intel DB)
 * - Edit mode for browsing without spam
 */

const Intel = require('../../../models/Intel');
const logger = require('../../../logger');

const PAGE_SIZE = 10;

async function getIntelLinksForNode(sock) {
    try {
        if (!sock?.user) return [];
        
        const botId = String(sock.user.id || '').split(':')[0];
        const docs = await Intel.find({ botId }).sort({ seenAt: -1 }).lean();
        
        return docs.map(doc => ({
            id: doc._id,
            groupJid: doc.groupJid,
            groupName: doc.groupName || doc.groupJid,
            members: doc.members || 0,
            code: doc.code || '',
            status: doc.status || 'unknown',
            validatedAt: doc.validatedAt || 0,
            seenAt: doc.seenAt || Date.now(),
        }));
    } catch (err) {
        logger.warn('[IntelBroadcast] getIntelLinksForNode failed', { error: err.message });
        return [];
    }
}

function buildIntelPage(allLinks, page = 0) {
    const start = page * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const pageLinks = allLinks.slice(start, end);
    const totalPages = Math.ceil(allLinks.length / PAGE_SIZE);
    
    if (!pageLinks.length) {
        return {
            text: '🔗 <b>INTEL LINKS DATABASE</b>\n\n❌ No links stored yet.\n\n<i>When nodes join groups, links will appear here.</i>',
            hasMore: false,
            currentPage: page,
            totalPages: 0,
        };
    }

    const lines = pageLinks.map((link, idx) => {
        const globalIdx = start + idx + 1;
        const statusEmoji = link.status === 'valid' ? '✅' : link.status === 'expired' ? '❌' : '❓';
        const memberText = link.members > 0 ? ` • ${link.members} members` : '';
        return `${globalIdx}. ${statusEmoji} <b>${escapeHtml(link.groupName)}</b>${memberText}\n   <code>${link.code || 'N/A'}</code>`;
    });

    const text = [
        '🔗 <b>INTEL LINKS DATABASE</b>',
        `<i>Page ${page + 1} of ${totalPages} • Total: ${allLinks.length} link(s)</i>`,
        '',
        ...lines,
        '',
        '<i>Reply with Next/Previous to browse, or Close to return.</i>'
    ].join('\n');

    return {
        text,
        hasMore: end < allLinks.length,
        currentPage: page,
        totalPages,
    };
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = {
    name: 'intel_broadcast',
    description: 'Broadcast all Intel links stored in database',
    
    async handler(ctx, { sessionKey, sock, userId }) {
        const phone = sessionKey.split('_')[1] || sessionKey;
        const allLinks = await getIntelLinksForNode(sock);

        if (!allLinks.length) {
            return ctx.reply(
                '🔗 <b>INTEL DATABASE</b>\n\n❌ No links stored yet.\n\n<i>When nodes join groups, links will be saved here for cross-node access.</i>',
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }

        // Store pagination state in session for Next/Previous
        ctx.session = ctx.session || {};
        ctx.session.intelBroadcastState = {
            sessionKey,
            userId,
            allLinks: allLinks.map(l => ({
                id: l.id,
                groupJid: l.groupJid,
                groupName: l.groupName,
                members: l.members,
                code: l.code,
                status: l.status,
            })),
            currentPage: 0,
        };

        const page = buildIntelPage(allLinks, 0);
        const inline_keyboard = [];

        if (page.hasMore) {
            inline_keyboard.push([{ text: '➡️ Next Page', callback_data: 'intel_bcast_next' }]);
        }

        inline_keyboard.push([
            { text: '❌ Close', callback_data: 'intel_bcast_close' },
        ]);

        return ctx.reply(page.text, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard },
        }).catch(() => {});
    },

    // Pagination handlers (optional, can be registered in telegram.js)
    paginationHandlers: {
        async next(ctx) {
            const state = ctx.session?.intelBroadcastState;
            if (!state) {
                return ctx.answerCbQuery('Session expired.', { show_alert: true }).catch(() => {});
            }

            state.currentPage = Math.min(state.currentPage + 1, Math.ceil(state.allLinks.length / PAGE_SIZE) - 1);
            const page = buildIntelPage(state.allLinks, state.currentPage);

            const inline_keyboard = [];
            if (state.currentPage > 0) {
                inline_keyboard.push([{ text: '⬅️ Prev Page', callback_data: 'intel_bcast_prev' }]);
            }
            if (page.hasMore) {
                inline_keyboard.push([{ text: '➡️ Next Page', callback_data: 'intel_bcast_next' }]);
            } else {
                if (state.currentPage > 0) {
                    // Add prev if we're on last page with prev option
                } else {
                    inline_keyboard.push([{ text: '➡️ Next Page', callback_data: 'intel_bcast_next' }]);
                }
            }

            inline_keyboard.push([
                { text: '❌ Close', callback_data: 'intel_bcast_close' },
            ]);

            await ctx.answerCbQuery().catch(() => {});
            return ctx.editMessageText(page.text, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard },
            }).catch(() => {});
        },

        async prev(ctx) {
            const state = ctx.session?.intelBroadcastState;
            if (!state) {
                return ctx.answerCbQuery('Session expired.', { show_alert: true }).catch(() => {});
            }

            state.currentPage = Math.max(state.currentPage - 1, 0);
            const page = buildIntelPage(state.allLinks, state.currentPage);

            const inline_keyboard = [];
            if (state.currentPage > 0) {
                inline_keyboard.push([{ text: '⬅️ Prev Page', callback_data: 'intel_bcast_prev' }]);
            }
            if (page.hasMore) {
                inline_keyboard.push([{ text: '➡️ Next Page', callback_data: 'intel_bcast_next' }]);
            }

            inline_keyboard.push([
                { text: '❌ Close', callback_data: 'intel_bcast_close' },
            ]);

            await ctx.answerCbQuery().catch(() => {});
            return ctx.editMessageText(page.text, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard },
            }).catch(() => {});
        },

        async close(ctx) {
            await ctx.answerCbQuery().catch(() => {});
            ctx.session.intelBroadcastState = null;
            return ctx.deleteMessage().catch(() => {});
        }
    }
};
