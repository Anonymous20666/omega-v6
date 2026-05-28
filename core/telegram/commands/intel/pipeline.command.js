'use strict';
// core/telegram/commands/intel/pipeline.command.js
// Telegram UI for the 3-stage Link Pipeline.
//
// Validator Hub (Stage 2) — in main menu → pick a node → validate Main_DB links
// Join Intel    (Stage 3) — in node submenu → join Live_DB links with that node

const {
    validateBatch,
    joinLiveLink,
    getMainLinks,
    getLiveLinks,
    getDeadLinks,
    getSummary,
    isNodePaused,
} = require('../../../linkPipeline');
const { isAutoJoinOn, setAutoJoin } = require('../../../../events/autoJoinRouter');
const { safeEdit } = require('../../ui');

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function summaryText() {
    const s = getSummary();
    return `📥 Main (unvalidated): <b>${s.main}</b>\n✅ Live (validated): <b>${s.live}</b>\n⚫ Dead: <b>${s.dead}</b>`;
}

// ─── Validator Hub view (Stage 2) ─────────────────────────────────────────────
function getValidatorHubView(activeSockets) {
    const nodes = [...activeSockets.entries()]
        .filter(([, sock]) => !!sock?.user)
        .map(([key, sock]) => ({
            key,
            phone: key.split('_')[1] || key,
            nodeId: sock.user.id.split(':')[0],
        }));

    const text = [
        `🧪 <b>VALIDATOR HUB</b>`,
        ``,
        summaryText(),
        ``,
        `<i>Pick a Node to use as the validator. It will test links from Main DB and sort them into Live or Dead.</i>`,
    ].join('\n');

    const inline_keyboard = nodes.map(n => ([{
        text: `🔬 Validate with +${n.phone}`,
        callback_data: `pipeline_validate_${n.key}`,
    }]));

    inline_keyboard.push(
        [{ text: '📋 View Main DB',  callback_data: 'pipeline_view_main' }],
        [{ text: '✅ View Live DB',  callback_data: 'pipeline_view_live' }],
        [{ text: '⚫ View Dead DB',  callback_data: 'pipeline_view_dead' }],
        [{ text: '🔙 Back to Hub',   callback_data: 'menu_main' }],
    );

    return { text, reply_markup: { inline_keyboard } };
}

// ─── Join Intel view (Stage 3) ────────────────────────────────────────────────
function getJoinIntelView(sessionKey, sock) {
    const phone = sessionKey.split('_')[1] || sessionKey;
    const nodeId = sock?.user?.id?.split(':')[0] || phone;
    const paused = isNodePaused(nodeId);
    const live = getLiveLinks();
    const autoOn = isAutoJoinOn(nodeId);

    const text = [
        `🎯 <b>JOIN INTEL</b>`,
        `📱 Node: <b>+${esc(phone)}</b>`,
        ``,
        summaryText(),
        ``,
        paused ? `⚠️ <b>Node is flood-paused. Wait before joining.</b>` : ``,
        ``,
        `<i>This node will join links from the Live DB only. Dead links are auto-moved to Dead DB.</i>`,
    ].filter(l => l !== undefined).join('\n');

    const inline_keyboard = [
        [{
            text: live.length > 0 && !paused
                ? `▶️ Start Joining (${live.length} live links)`
                : live.length === 0
                    ? '⚠️ No Live Links'
                    : '⏸ Node Paused',
            callback_data: live.length > 0 && !paused
                ? `pipeline_joinintel_run_${sessionKey}`
                : 'pipeline_noop',
        }],
        [{
            text: autoOn ? '🟢 AutoJoin ON — tap to disable' : '🔴 AutoJoin OFF — tap to enable',
            callback_data: `pipeline_autojoin_toggle_${sessionKey}`,
        }],
        [{ text: '🔙 Back to Node', callback_data: `ux:n:v:${encodeURIComponent(sessionKey)}` }],
    ];

    return { text, reply_markup: { inline_keyboard } };
}

// ─── Link list view ───────────────────────────────────────────────────────────
function getLinkListView(store, title, backCb) {
    const links = store === 'main' ? getMainLinks()
        : store === 'live' ? getLiveLinks()
        : getDeadLinks();

    if (!links.length) {
        return {
            text: `📄 <b>${esc(title)}</b>\n\n<i>Empty.</i>`,
            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: backCb }]] },
        };
    }

    const preview = links.slice(0, 30)
        .map((e, i) => `${i + 1}. <code>${esc(e.code)}</code>`)
        .join('\n');

    return {
        text: `📄 <b>${esc(title)}</b> (${links.length} total)\n\n${preview}${links.length > 30 ? `\n…and ${links.length - 30} more` : ''}`,
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: backCb }]] },
    };
}

// ─── Module export ────────────────────────────────────────────────────────────
module.exports = {
    name: 'pipeline',
    description: 'Link Pipeline — Validator Hub & Join Intel',

    register(bot, deps) {
        const { activeSockets, logger: log, ownerTelegramId: ownerId } = deps;

        // ── Validator Hub entry ───────────────────────────────────────────────
        bot.action('menu_pipeline', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const view = getValidatorHubView(activeSockets);
            return safeEdit(ctx, view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup });
        });

        // ── View DB lists ─────────────────────────────────────────────────────
        bot.action('pipeline_view_main', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const v = getLinkListView('main', 'Main DB (Unvalidated)', 'menu_pipeline');
            return safeEdit(ctx, v.text, { parse_mode: 'HTML', reply_markup: v.reply_markup });
        });

        bot.action('pipeline_view_live', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const v = getLinkListView('live', 'Live DB (Validated)', 'menu_pipeline');
            return safeEdit(ctx, v.text, { parse_mode: 'HTML', reply_markup: v.reply_markup });
        });

        bot.action('pipeline_view_dead', async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const v = getLinkListView('dead', 'Dead DB', 'menu_pipeline');
            return safeEdit(ctx, v.text, { parse_mode: 'HTML', reply_markup: v.reply_markup });
        });

        // ── Stage 2: Run validation with a specific node ──────────────────────
        bot.action(/^pipeline_validate_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const sessionKey = ctx.match[1];
            const sock = activeSockets.get(sessionKey);
            const phone = sessionKey.split('_')[1] || sessionKey;

            if (!sock?.user) {
                return safeEdit(ctx, `⚠️ Node +${esc(phone)} is offline.`, {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_pipeline' }]] },
                });
            }

            const mainCount = getMainLinks().length;
            if (!mainCount) {
                return safeEdit(ctx, `ℹ️ Main DB is empty — nothing to validate.`, {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_pipeline' }]] },
                });
            }

            const statusMsg = await ctx.reply(
                `🔬 <b>Validation starting…</b>\n📱 Node: +${esc(phone)}\n📦 Links to test: <b>${mainCount}</b>\n\n<i>Testing via metadata check (no join). This is safe.</i>`,
                { parse_mode: 'HTML' }
            ).catch(() => null);

            setImmediate(async () => {
                try {
                    global._pushTelegramLiveLog?.({ sessionKey, source: 'VALIDATOR_HUB', line: `Validation started with ${mainCount} Main links using +${phone}` });
                    const result = await validateBatch(sock, { limit: 100, delayMs: 1500 });
                    const s = getSummary();
                    const msg = [
                        `✅ <b>Validation complete</b>`,
                        `📱 Node: +${esc(phone)}`,
                        ``,
                        `✅ Moved to Live: <b>${result.live}</b>`,
                        `⚫ Moved to Dead: <b>${result.dead}</b>`,
                        `❓ Unknown (left in Main): <b>${result.unknown}</b>`,
                        ``,
                        `📥 Main remaining: <b>${s.main}</b>`,
                        `✅ Live total: <b>${s.live}</b>`,
                        `⚫ Dead total: <b>${s.dead}</b>`,
                    ].join('\n');

                    if (statusMsg?.message_id) {
                        await global.tgBot?.telegram?.editMessageText(
                            ctx.chat.id, statusMsg.message_id, null, msg,
                            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Validator', callback_data: 'menu_pipeline' }]] } }
                        ).catch(() => {});
                    }
                    global._pushTelegramLiveLog?.({ sessionKey, source: 'VALIDATOR_HUB', line: `Validation complete: live=${result.live} dead=${result.dead} unknown=${result.unknown}` });
                } catch (err) {
                    log?.warn('[Pipeline] validateBatch failed', { error: err.message });
                    global._pushTelegramLiveLog?.({ sessionKey, source: 'VALIDATOR_HUB', line: `Validation failed: ${String(err.message).slice(0, 120)}` });
                    if (statusMsg?.message_id) {
                        await global.tgBot?.telegram?.editMessageText(
                            ctx.chat.id, statusMsg.message_id, null,
                            `❌ Validation failed: <code>${esc(err.message)}</code>`,
                            { parse_mode: 'HTML' }
                        ).catch(() => {});
                    }
                }
            });
        });

        // ── Stage 3: Join Intel — run joins for a specific node ───────────────
        bot.action(/^pipeline_joinintel_run_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const sessionKey = ctx.match[1];
            const sock = activeSockets.get(sessionKey);
            const phone = sessionKey.split('_')[1] || sessionKey;

            if (!sock?.user) {
                return ctx.reply(`⚠️ Node +${esc(phone)} is offline.`, { parse_mode: 'HTML' }).catch(() => {});
            }

            const liveLinks = getLiveLinks();
            if (!liveLinks.length) {
                return ctx.reply(`ℹ️ Live DB is empty. Run validation first.`, { parse_mode: 'HTML' }).catch(() => {});
            }

            const statusMsg = await ctx.reply(
                `🎯 <b>Join Intel starting…</b>\n📱 Node: +${esc(phone)}\n✅ Live links: <b>${liveLinks.length}</b>\n\n<i>Joining with human-like delays. Dead links auto-moved to Dead DB.</i>`,
                { parse_mode: 'HTML' }
            ).catch(() => null);

            setImmediate(async () => {
                global._pushTelegramLiveLog?.({ sessionKey, source: 'JOIN_INTEL', line: `Join Intel started: ${liveLinks.length} live links on +${phone}` });
                const stats = { joined: 0, dead: 0, skipped: 0, total: liveLinks.length };
                const logs = [];

                for (const entry of liveLinks) {
                    const result = await joinLiveLink(entry.code, sock);

                    if (result.outcome === 'JOIN_SUCCESS' || result.outcome === 'ALREADY_JOINED' || result.outcome === 'REQUEST_SENT') {
                        stats.joined++;
                        logs.unshift(`✅ <code>${esc(entry.code)}</code> → ${result.outcome}`);
                    } else if (result.outcome === 'DEAD') {
                        stats.dead++;
                        logs.unshift(`⚫ <code>${esc(entry.code)}</code> → dead (auto-moved)`);
                    } else if (result.outcome === 'RATE_LIMITED' || result.outcome === 'FLOOD_BLOCKED') {
                        stats.skipped++;
                        logs.unshift(`⏸ <code>${esc(entry.code)}</code> → ${result.outcome} — pausing node`);
                        // Node is now paused — stop this run
                        break;
                    } else {
                        stats.skipped++;
                        logs.unshift(`⚠️ <code>${esc(entry.code)}</code> → ${result.outcome}`);
                    }

                    if (logs.length > 8) logs.pop();

                    // Live progress update every 5 joins
                    if ((stats.joined + stats.dead + stats.skipped) % 5 === 0 && statusMsg?.message_id) {
                        const preview = logs.slice(0, 5).join('\n');
                        await global.tgBot?.telegram?.editMessageText(
                            ctx.chat.id, statusMsg.message_id, null,
                            `🎯 <b>Join Intel in progress…</b>\n📱 +${esc(phone)}\n\n✅ Joined: <b>${stats.joined}</b>  ⚫ Dead: <b>${stats.dead}</b>  ⏭ Skipped: <b>${stats.skipped}</b>\n\n${preview}`,
                            { parse_mode: 'HTML' }
                        ).catch(() => {});
                    }
                    global._pushTelegramLiveLog?.({ sessionKey, source: 'JOIN_INTEL', line: `Progress: joined=${stats.joined} dead=${stats.dead} skipped=${stats.skipped}` });
                }

                const s = getSummary();
                const finalMsg = [
                    `✅ <b>Join Intel complete</b>`,
                    `📱 Node: +${esc(phone)}`,
                    ``,
                    `✅ Joined: <b>${stats.joined}</b>`,
                    `⚫ Dead (auto-moved): <b>${stats.dead}</b>`,
                    `⏭ Skipped: <b>${stats.skipped}</b>`,
                    ``,
                    `✅ Live remaining: <b>${s.live}</b>  ⚫ Dead total: <b>${s.dead}</b>`,
                ].join('\n');

                if (statusMsg?.message_id) {
                    await global.tgBot?.telegram?.editMessageText(
                        ctx.chat.id, statusMsg.message_id, null, finalMsg,
                        {
                            parse_mode: 'HTML',
                            reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Node', callback_data: `ux:n:v:${encodeURIComponent(sessionKey)}` }]] },
                        }
                    ).catch(() => {});
                }
                global._pushTelegramLiveLog?.({ sessionKey, source: 'JOIN_INTEL', line: `Join Intel finished: joined=${stats.joined} dead=${stats.dead} skipped=${stats.skipped}` });

                // Notify owner
                if (global.tgBot && ownerId) {
                    global.tgBot.telegram.sendMessage(
                        ownerId,
                        `🎯 <b>Join Intel finished</b>\n+${esc(phone)}: joined <b>${stats.joined}</b>, dead <b>${stats.dead}</b>`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                }
            });
        });

        // ── AutoJoin toggle (per node) ─────────────────────────────────────────
        bot.action(/^pipeline_autojoin_toggle_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const sessionKey = ctx.match[1];
            const sock = activeSockets.get(sessionKey);
            const phone = sessionKey.split('_')[1] || sessionKey;
            const nodeId = sock?.user?.id?.split(':')[0] || phone;
            const next = !isAutoJoinOn(nodeId);
            setAutoJoin(nodeId, next);
            const view = getJoinIntelView(sessionKey, sock);
            return safeEdit(ctx, view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup });
        });

        // ── Join Intel entry (called from node submenu) ───────────────────────
        bot.action(/^pipeline_joinintel_(.+)$/, async (ctx) => {
            // Guard: don't match the _run_ sub-action
            if (ctx.match[1].startsWith('run_')) return;
            await ctx.answerCbQuery().catch(() => {});
            const sessionKey = ctx.match[1];
            const sock = activeSockets.get(sessionKey);
            const view = getJoinIntelView(sessionKey, sock);
            return safeEdit(ctx, view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup });
        });

        bot.action('pipeline_noop', (ctx) => ctx.answerCbQuery().catch(() => {}));
    },

    // Expose view builders so nodes.command.js can call them
    getJoinIntelView,
    getValidatorHubView,
};
