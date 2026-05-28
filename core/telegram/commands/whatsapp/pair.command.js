"use strict";
// commands/whatsapp/pair.command.js — pair and rmsession

const path = require("path");
const fsp  = require("fs").promises;

const SESSIONS_PATH = path.resolve(__dirname, "../../../data/sessions");

module.exports = {
    name: "pair",
    requiredRole: "USER",

    async handler({ ctx, args, deps }) {
        const { startWhatsApp, activeSockets, ownerTelegramId, botState, ownerManager } = deps;
        const tgId = String(ctx.from?.id || '');
        if (!tgId) return ctx.reply('⚠️ Unable to identify sender.', { parse_mode: 'HTML' });

        // Check if auto-pair is enabled
        if (!botState.autoPairEnabled && String(tgId) !== String(ownerTelegramId)) {
            return ctx.reply('⚠️ <b>AUTO-PAIR DISABLED</b>\n\nThe owner has temporarily disabled automatic pairing. Please try again later.', { parse_mode: 'HTML' });
        }

        if (!args[0]) return ctx.reply("⚠️ <b>Usage:</b>\n<code>/pair [phone] [optional_owner_number]</code>", { parse_mode: "HTML" });

        // Channel gate: must join @pappylung first
        try {
            const member = await ctx.telegram.getChatMember("@pappylung", ctx.from.id);
            if (!["member", "administrator", "creator"].includes(member.status)) {
                return ctx.reply(
                    "🚨 <b>Join Required!</b>\n\nYou must join our channel before using this bot:\n\n👉 <a href=\"https://t.me/pappylung\">@pappylung</a>\n\n<i>Join then try /pair again.</i>",
                    { parse_mode: "HTML", disable_web_page_preview: false }
                );
            }
        } catch { /* private channel or bot not in it — allow through */ }

        // One bot per user
        const pairingRegistry = require("../../../../modules/pairingRegistry");
        if (tgId !== String(ownerTelegramId) && pairingRegistry.hasBot(tgId)) {
            const existing = pairingRegistry.getPhone(tgId);
            return ctx.reply(
                `⚠️ <b>You already have a bot paired!</b>\n\n📱 Number: <code>+${existing}</code>\n\n<i>You can only pair one number. Use /rmsession to remove it first.</i>`,
                { parse_mode: "HTML" }
            );
        }

        const phone = args[0].replace(/[^0-9]/g, "");
        const ownerCandidate = args[1] ? args[1].replace(/[^0-9]/g, '') : '';
        const ownerNumber = ownerCandidate && ownerCandidate.length >= 9 && ownerCandidate.length <= 15
            ? ownerCandidate
            : null;

        try {
            if (ownerNumber) {
                await ownerManager.addOwner(`${ownerNumber}@s.whatsapp.net`);
            } else {
                await ownerManager.registerPairedNumber(phone);
            }
        } catch {}

        await ctx.reply(`⚙️ <b>INITIALIZING STEALTH LINK...</b>\n\n📱 <code>+${phone}</code>\n<i>Please wait for your pairing code...</i>`, { parse_mode: "HTML" });
        try {
            await startWhatsApp(tgId, phone, "1");
            await pairingRegistry.register(tgId, phone).catch(() => {});
        } catch (err) {
            const msg = err?.message || String(err);
            await ctx.reply(`❌ <b>ERROR:</b>\n<code>${msg}</code>`, { parse_mode: 'HTML' }).catch(() => {});
        }
    },

    register(bot, deps) {
        const { activeSockets, logger } = deps;

        bot.command("rmsession", async (ctx) => {
            const userId = String(ctx.from?.id || "");
            const userRole = deps.rbac?.getUserRole(userId) || 'USER';
            const isOwner = deps.rbac?.hasPermission(userId, 'OWNER');
            const pairingRegistry = require("../../../../modules/pairingRegistry");

            const phone = ctx.message.text.split(" ")[1]?.replace(/[^0-9]/g, '');
            if (!phone) return ctx.reply("❌ Usage: <code>/rmsession [phone]</code>", { parse_mode: "HTML" });

            // Non-owners can only remove their own paired session
            if (!isOwner) {
                const ownedPhone = pairingRegistry.getPhone(userId);
                if (!ownedPhone || ownedPhone.replace(/[^0-9]/g, '') !== phone) {
                    return ctx.reply('⚠️ You can only remove your own paired session.', { parse_mode: 'HTML' });
                }
            }

            let targetKey = null;
            for (const key of activeSockets.keys()) {
                if (key.includes(phone)) targetKey = key;
            }

            if (!targetKey) {
                // Session may be offline — still clean up files and registry
                const sessionDir = path.join(SESSIONS_PATH, `${userId}_${phone}_1`);
                try { await fsp.rm(sessionDir, { recursive: true, force: true }); } catch {}
                await pairingRegistry.unregister(userId).catch(() => {});
                return ctx.reply(`🗑️ <b>SESSION REMOVED</b>\n+${phone} has been cleared.`, { parse_mode: "HTML" });
            }

            const sock = activeSockets.get(targetKey);
            if (sock) {
                try { sock.logout(); } catch { sock.ws?.close(); }
                activeSockets.delete(targetKey);
            }

            const sessionDir = path.join(SESSIONS_PATH, path.basename(targetKey));
            try { await fsp.rm(sessionDir, { recursive: true, force: true }); }
            catch (e) { logger.warn("Failed to rm session dir", { error: e.message }); }

            await pairingRegistry.unregister(userId).catch(() => {});
            ctx.reply(`🗑️ <b>SESSION DESTROYED</b>\n+${phone} has been completely removed.`, { parse_mode: "HTML" });
        });
    },
};
