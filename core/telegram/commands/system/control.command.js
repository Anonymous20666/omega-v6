"use strict";
// commands/system/control.command.js — sleep/wake/restart/wipequeue/plugins/analytics/help_pair

module.exports = {
    name: "wipequeue",
    requiredRole: "SUDO",

    async handler({ ctx, args, deps }) {
        const { broadcastQueue } = deps;
        try {
            await ctx.reply("🗑️ <b>WIPING REDIS DATABASE...</b>\n<i>Please wait...</i>", { parse_mode: "HTML" });
            await broadcastQueue.pause();
            await broadcastQueue.obliterate({ force: true });
            await broadcastQueue.resume();
            await ctx.reply("✅ <b>QUEUE DESTROYED</b>\nAll pending Godcasts and broadcasts have been completely wiped from the Redis Cloud.", { parse_mode: "HTML" });
        } catch (err) {
            await ctx.reply(`❌ <b>ERROR:</b> ${err.message}`, { parse_mode: "HTML" });
        }
    },

    register(bot, deps) {
        const { broadcastQueue, botState, saveState, getMainDashboardMenu, getDynamicPlugins, activeSockets, taskManager, os, logger } = deps;

        bot.action("cmd_wipequeue", async (ctx) => {
            ctx.answerCbQuery("Wiping Redis...");
            try {
                ctx.editMessageText("🗑️ <b>WIPING REDIS...</b>\n<i>Please wait...</i>", { parse_mode: "HTML" }).catch(() => {});
                const { connection } = require('../../../../services/redis');
                await connection.flushall();
                ctx.editMessageText("✅ <b>REDIS WIPED</b>\nAll pending jobs cleared. Queue is fresh.", {
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Hub", callback_data: "menu_main" }]] }
                }).catch(() => {});
            } catch (err) {
                logger.error("[Telegram] cmd_wipequeue failed", { error: err.message });
                ctx.editMessageText(`❌ <b>ERROR:</b> ${err.message}`, {
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Hub", callback_data: "menu_main" }]] }
                }).catch(() => {});
            }
        });

        bot.action("help_pair", (ctx) => {
            ctx.answerCbQuery();
            ctx.editMessageText(
                "➕ <b>HOW TO DEPLOY A NEW NODE:</b>\n\nTo pair a new WhatsApp number, send the following command in this chat:\n\n<code>/pair [phone_number]</code>\n\n<i>Example:</i> <code>/pair 2348123456789</code>",
                { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Hub", callback_data: "menu_main" }]] } }
            ).catch(() => {});
        });

        bot.action("cmd_plugins", (ctx) => {
            ctx.answerCbQuery("Loading Command Book...");
            const categories = getDynamicPlugins();
            let menuText = `📚 <b>PAPPY DYNAMIC PLUGIN MENU</b>\n<i>Send these directly in Telegram to execute!</i>\n\n`;
            for (const [cat, cmds] of Object.entries(categories)) {
                menuText += `◈ <b>[ ${cat} ]</b>\n  └ <code>${cmds.join("</code>, <code>")}</code>\n\n`;
            }
            ctx.editMessageText(menuText, {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Hub", callback_data: "menu_main" }]] }
            }).catch(() => {});
        });

        bot.action("cmd_analytics", (ctx) => {
            ctx.answerCbQuery("Fetching Telemetry...");
            const sysUsed = Math.round((os.totalmem() - os.freemem()) / 1024 / 1024);
            const botRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
            const stats = taskManager.getStats();
            const dashboard =
                `📊 <b>ENGINE ANALYTICS</b>\n\n🟢 Nodes Online: ${activeSockets.size}\n⚡ Tasks Running: ${stats.running}\n⏳ Tasks Queued: ${stats.queued}\n🤖 Engine RAM: ${botRss}MB\n💻 Server RAM: ${sysUsed}MB`;
            ctx.editMessageText(dashboard, {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Hub", callback_data: "menu_main" }]] }
            }).catch(() => {});
        });

        bot.action("cmd_sleep", (ctx) => {
            ctx.answerCbQuery("System Sleeping...");
            botState.isSleeping = true;
            saveState();
            const { text, reply_markup } = getMainDashboardMenu();
            ctx.editMessageText(text, { parse_mode: "HTML", reply_markup }).catch(() => {});
        });

        bot.action("cmd_wake", (ctx) => {
            ctx.answerCbQuery("System Waking...");
            botState.isSleeping = false;
            saveState();
            const { text, reply_markup } = getMainDashboardMenu();
            ctx.editMessageText(text, { parse_mode: "HTML", reply_markup }).catch(() => {});
        });

        bot.action("cmd_restart", (ctx) => {
            ctx.answerCbQuery("Restarting System...");
            ctx.editMessageText(
                "🔄 <b>RESTARTING ENGINE...</b>\n\n<i>The control panel will go offline for 5 seconds while the engine reboots.</i>",
                { parse_mode: "HTML" }
            ).catch(() => {});
            setTimeout(() => process.exit(0), 1500);
        });
    },
};
