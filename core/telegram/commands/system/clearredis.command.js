"use strict";

const { panel, safeEdit } = require("../../ui");

module.exports = {
    name: "clearredis",
    aliases: ["flushqueue", "clearqueue"],
    description: "Clear all Redis queue jobs for this node",
    usage: "/clearredis",
    requiredRole: "ADMIN",
    cooldown: 5,

    handler: async ({ ctx, deps }) => {
        const msg = await ctx.reply(
            panel("🗑️ <b>Clearing Redis</b>", ["Wiping all pending jobs..."]),
            { parse_mode: "HTML" }
        );
        try {
            const { connection } = require('../../../services/redis');
            await connection.flushall();
            await ctx.telegram.editMessageText(
                ctx.chat.id, msg.message_id, undefined,
                panel("✅ <b>Redis Cleared</b>", ["All queue jobs wiped.", "Queue is fresh and ready."]),
                { parse_mode: "HTML" }
            );
        } catch (err) {
            deps.logger.error("[ClearRedis] Failed", { error: err.message });
            await ctx.telegram.editMessageText(
                ctx.chat.id, msg.message_id, undefined,
                panel("❌ <b>Clear Failed</b>", [`Error: ${err.message}`]),
                { parse_mode: "HTML" }
            );
        }
    },

    register: (bot, deps) => {
        bot.action(/^ux:n:clr:(.+)$/, async (ctx) => {
            await ctx.answerCbQuery("Clearing Redis...").catch(() => {});
            await safeEdit(ctx, "⏳ Wiping all queue jobs...", { parse_mode: "HTML" });
            try {
                const { connection } = require('../../../services/redis');
                await connection.flushall();
                const key = decodeURIComponent(ctx.match[1]);
                await safeEdit(ctx,
                    panel("✅ <b>Redis Cleared</b>", ["All pending jobs wiped.", "Queue is fresh and ready."]),
                    { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Node", callback_data: `ux:n:v:${encodeURIComponent(key)}` }]] } }
                );
            } catch (err) {
                deps.logger.error("[ClearRedis] Inline wipe failed", { error: err.message });
                const key = decodeURIComponent(ctx.match[1]);
                await safeEdit(ctx, `❌ Failed: ${err.message}`, {
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: `ux:n:v:${encodeURIComponent(key)}` }]] }
                });
            }
        });
    },
};
