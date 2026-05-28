"use strict";
// commands/messaging/broadcast.command.js — gcast, godcast, castmedia, dm, status

const axios = require("axios");
const ghostMode = require("../../../ghostMode");

module.exports = {
    name: "gcast",
    aliases: [],
    requiredRole: "SUDO",

    async handler({ ctx, args, deps }) {
        const { activeSockets, broadcastQueue, logger, resolveTelegramNodeScope } = deps;
        const text = args.join(" ").trim();
        if (!text) return ctx.reply("❌ Syntax: <code>/gcast Message</code>", { parse_mode: "HTML" });
        const userId = String(ctx.from?.id || "");
        const userRole = deps.rbac.getUserRole(userId);
        const scoped = resolveTelegramNodeScope(userId, userRole);
        const firstActiveSocket = scoped?.sock || null;
        if (!firstActiveSocket) return ctx.reply("❌ <b>No active WhatsApp nodes.</b>", { parse_mode: "HTML" });
        const botId = firstActiveSocket.user.id.split(":")[0];
        const requestId = `${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const raw = await require("../../../groupCache").getAllGroups(firstActiveSocket).catch(() => ({}));
        const jids = Object.values(raw).filter(g => g.participants.length >= 5).map(g => ({ id: g.id, size: g.participants.length }));
        const jobs = jids.map(group => ({
            name: `GCAST_${botId}_${group.id}_${requestId}`,
            data: { botId, targetJid: group.id, textContent: text, mode: "normal", useGhostProtocol: false },
            opts: { priority: 3, removeOnComplete: true }
        }));
        for (let i = 0; i < jobs.length; i += 500) await broadcastQueue.addBulk(jobs.slice(i, i + 500));
        ctx.reply(`🌸 <b>ENGINE ENGAGED:</b> ${jids.length} drops queued.`, { parse_mode: "HTML" });
    },

    register(bot, deps) {
        const { activeSockets, broadcastQueue, taskManager, logger, resolveTelegramNodeScope } = deps;

        bot.command("ghost", async (ctx) => {
            const userId = String(ctx.from?.id || "");
            if (!deps.rbac?.hasPermission(userId, "SUDO")) return ctx.reply("⚠️ Access denied.", { parse_mode: "HTML" });
            const arg = String(ctx.message.text || "").replace("/ghost", "").trim().toLowerCase();

            if (!arg) {
                return ctx.reply(
                    `👻 <b>Ghost Mode</b><br/>Current: <b>${ghostMode.getMode().toUpperCase()}</b><br/><br/>Usage: <code>/ghost auto</code>, <code>/ghost on</code>, <code>/ghost off</code>`,
                    { parse_mode: "HTML" }
                );
            }

            if (!["auto", "on", "off"].includes(arg)) {
                return ctx.reply("❌ Use <code>/ghost auto</code>, <code>/ghost on</code>, or <code>/ghost off</code>", { parse_mode: "HTML" });
            }

            ghostMode.setMode(arg);
            return ctx.reply(`👻 <b>Ghost Mode Set:</b> ${arg.toUpperCase()}`, { parse_mode: "HTML" });
        });

        // /godcast
        bot.command("godcast", async (ctx) => {
            const userId = String(ctx.from?.id || "");
            if (!deps.rbac?.hasPermission(userId, "SUDO")) return ctx.reply("⚠️ Access denied.", { parse_mode: "HTML" });
            const text = ctx.message.text.replace("/godcast", "").trim();
            if (!text) return ctx.reply("❌ Syntax: <code>/godcast Message</code>", { parse_mode: "HTML" });
            const userRole = deps.rbac.getUserRole(userId);
            const scoped = resolveTelegramNodeScope(userId, userRole);
            const firstActiveSocket = scoped?.sock || null;
            if (!firstActiveSocket) return ctx.reply("❌ <b>No active WhatsApp nodes.</b>", { parse_mode: "HTML" });
            const botId = firstActiveSocket.user.id.split(":")[0];
            const gsPlugin = deps.gsPlugin || null;
            const gsConfig = gsPlugin?.getGsConfig(scoped?.sessionKey || botId) || { backgroundColor: '#FFB7C5', font: 3 };
            const requestId = `${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const raw = await require("../../../groupCache").getAllGroups(firstActiveSocket).catch(() => ({}));
            const jids = Object.values(raw).filter(g => g.participants.length >= 5).map(g => ({ id: g.id, size: g.participants.length }));
            const shouldUseGhost = ghostMode.shouldUseGhost(jids.length);
            const jobs = jids.map(group => ({
                name: `GODCAST_${botId}_${group.id}_${requestId}`,
                data: { botId, targetJid: group.id, textContent: text, mode: "advanced_status", font: gsConfig.font, backgroundColor: gsConfig.backgroundColor, useGhostProtocol: shouldUseGhost, commandType: 'godcast' },
                opts: { priority: 1, removeOnComplete: true }
            }));
            for (let i = 0; i < jobs.length; i += 500) await broadcastQueue.addBulk(jobs.slice(i, i + 500));
            const ghostNote = `<br/>👻 <b>Ghost:</b> ${ghostMode.describeMode(jids.length)}`;
            ctx.reply(`🌸 <b>ENGINE ENGAGED:</b> ${jids.length} drops queued.${ghostNote}`, { parse_mode: "HTML" });
        });

        // /dm
        bot.command("dm", async (ctx) => {
            const userId = String(ctx.from?.id || "");
            if (!deps.rbac?.hasPermission(userId, "SUDO")) return ctx.reply("⚠️ Access denied.", { parse_mode: "HTML" });
            const args = ctx.message.text.split(" ");
            if (args.length < 3) return ctx.reply("❌ Usage: /dm 2348123456789 Your Message");
            const targetPhone = args[1].replace(/[^0-9]/g, "");
            const message = args.slice(2).join(" ");
            const targetJid = `${targetPhone}@s.whatsapp.net`;
            const userRole = deps.rbac.getUserRole(userId);
            const scoped = resolveTelegramNodeScope(userId, userRole);
            const firstSocket = scoped?.sock || null;
            if (!firstSocket) return ctx.reply("❌ No active sockets.");
            try {
                await firstSocket.sendMessage(targetJid, { text: message });
                ctx.reply(`✅ <b>DM SENT to +${targetPhone}</b>`, { parse_mode: "HTML" });
            } catch (e) {
                ctx.reply(`❌ <b>FAILED:</b> ${e.message}`, { parse_mode: "HTML" });
            }
        });

        // /status
        bot.command("status", async (ctx) => {
            const userId = String(ctx.from?.id || "");
            if (!deps.rbac?.hasPermission(userId, "SUDO")) return ctx.reply("⚠️ Access denied.", { parse_mode: "HTML" });
            const text = ctx.message.text.replace("/status", "").trim();
            if (!text) return ctx.reply("❌ Provide text for the status.");
            const userRole = deps.rbac.getUserRole(userId);
            const scoped = resolveTelegramNodeScope(userId, userRole);
            if (!scoped?.sock) return ctx.reply("❌ No WhatsApp account connected for your Telegram ID.");
            ctx.reply("📱 <b>UPLOADING STATUS...</b>", { parse_mode: "HTML" });
            let successCount = 0;
            try {
                const groups = await require("../../../groupCache").getAllGroups(scoped.sock);
                await scoped.sock.sendMessage("status@broadcast", { text: `Ω ELITE BROADCAST\n\n${text}` }, { statusJidList: Object.keys(groups) });
                successCount++;
            } catch (e) { logger.warn("Status upload failed for node", { error: e.message }); }
            ctx.reply(`✅ <b>STATUS UPLOADED</b>\nSuccessfully posted on ${successCount} account(s).`, { parse_mode: "HTML" });
        });

        // /castmedia
        bot.command("castmedia", async (ctx) => {
            const userId = String(ctx.from?.id || "");
            if (!deps.rbac?.hasPermission(userId, "SUDO")) return ctx.reply("⚠️ Access denied.", { parse_mode: "HTML" });
            if (!ctx.message.photo && !ctx.message.video) return ctx.reply("❌ Send a Photo/Video with /castmedia caption.");
            const userRole = deps.rbac.getUserRole(userId);
            const scoped = resolveTelegramNodeScope(userId, userRole);
            const firstSocket = scoped?.sock || null;
            if (!firstSocket) return ctx.reply("❌ No connected WhatsApp nodes.");
            ctx.reply("🚀 <b>DOWNLOADING MEDIA & DISPATCHING TO JITTER QUEUE...</b>", { parse_mode: "HTML" });
            try {
                const fileId = ctx.message.photo
                    ? ctx.message.photo[ctx.message.photo.length - 1].file_id
                    : ctx.message.video.file_id;
                const fileUrl = await ctx.telegram.getFileLink(fileId);
                const response = await axios.get(fileUrl.href, { responseType: "arraybuffer" });
                const mediaBuffer = Buffer.from(response.data, "binary");
                const caption = ctx.message.caption ? ctx.message.caption.replace("/castmedia", "").trim() : "";
                const isPhoto = !!ctx.message.photo;
                taskManager.submit(`TG_MEDIA_${userId}_${scoped?.sessionKey || 'none'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, async (abortSignal) => {
                    const groups = await require("../../../groupCache").getAllGroups(firstSocket);
                    const jids = Object.keys(groups);
                    for (let i = 0; i < jids.length; i++) {
                        if (abortSignal.aborted) break;
                        await firstSocket.sendMessage(jids[i], { [isPhoto ? "image" : "video"]: mediaBuffer, caption }).catch(() => {});
                        await new Promise(res => setTimeout(res, 2500 + Math.random() * 2000));
                    }
                }, { priority: 2, timeout: 600000 });
                ctx.reply("✅ <b>MEDIA BROADCAST QUEUED</b>", { parse_mode: "HTML" });
            } catch (err) {
                ctx.reply(`❌ <b>FAILED:</b> ${err.message}`, { parse_mode: "HTML" });
            }
        });
    },
};
