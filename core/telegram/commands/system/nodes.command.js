"use strict";

const { panel, safeEdit, getPagination } = require("../../ui");

const PAGE_SIZE = 5;

function listNodes(activeSockets) {
    return Array.from(activeSockets.entries())
        .map(([sessionKey, sock]) => {
            const parts = String(sessionKey).split("_");
            const phone = parts[1] || sessionKey;
            const slot = parts[2] || "1";
            return { sessionKey, phone, slot, online: !!sock?.user };
        })
        .sort((a, b) => a.phone.localeCompare(b.phone));
}

function renderNodesPage(nodes, page = 0) {
    const totalPages = Math.max(1, Math.ceil(nodes.length / PAGE_SIZE));
    const p = Math.max(0, Math.min(page, totalPages - 1));
    const start = p * PAGE_SIZE;
    const items = nodes.slice(start, start + PAGE_SIZE);

    const text = panel("🌐 <b>Node Control Center</b>", [
        "Manage your WhatsApp nodes with a clean premium panel.",
        "Select a node to open quick actions.",
        `Total nodes: <b>${nodes.length}</b>`,
    ]);

    const inline_keyboard = [];
    for (const item of items) {
        const icon = item.online ? "🟢" : "🟠";
        inline_keyboard.push([
            { text: `${icon} +${item.phone} (slot ${item.slot})`, callback_data: `ux:n:v:${encodeURIComponent(item.sessionKey)}` },
        ]);
    }

    inline_keyboard.push(getPagination(p, totalPages, "ux:n"));
    inline_keyboard.push([{ text: "❌ Close", callback_data: "ux:n:close" }]);

    return { text, reply_markup: { inline_keyboard } };
}

function renderNodeMenu(item) {
    const status = item.online ? "Online" : "Offline";
    const text = panel(`📱 <b>Node +${item.phone}</b>`, [
        `Status: <b>${status}</b>`,
        `Session: <code>${item.sessionKey}</code>`,
        "Choose an action below.",
    ]);

    return {
        text,
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📡 Broadcast Guide", callback_data: `ux:n:g:${encodeURIComponent(item.sessionKey)}` },
                    { text: "📸 Status Guide", callback_data: `ux:n:s:${encodeURIComponent(item.sessionKey)}` },
                ],
                [
                    { text: "🔄 Restart Node", callback_data: `ux:n:r:${encodeURIComponent(item.sessionKey)}` },
                    { text: "⚙️ Settings", callback_data: `ux:n:t:${encodeURIComponent(item.sessionKey)}` },
                ],
                [
                        { text: "🔗 URL Tools", callback_data: `ux:n:u:${encodeURIComponent(item.sessionKey)}` },
                        { text: "🗑️ Clear Redis", callback_data: `ux:n:clr:${encodeURIComponent(item.sessionKey)}` },
                ],
                [
                    { text: "🔙 Back to Nodes", callback_data: "ux:n:p:0" },
                    { text: "❌ Close", callback_data: "ux:n:close" },
                ],
            ],
        },
    };
}

module.exports = {
    name: "nodes",
    aliases: ["nodepanel"],
    description: "Open premium paginated node control panel",
    usage: "/nodes",
    requiredRole: "ADMIN",
    cooldown: 2,

    handler: async ({ ctx, deps }) => {
        const nodes = listNodes(deps.activeSockets);
        const ui = renderNodesPage(nodes, 0);
        await ctx.reply(ui.text, { parse_mode: "HTML", reply_markup: ui.reply_markup });
        if (ctx.session) ctx.session.lastAction = "nodes:list";
    },

    register: (bot, deps) => {
        bot.action(/^ux:n:p:(\d+)$/, async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const nodes = listNodes(deps.activeSockets);
            const ui = renderNodesPage(nodes, Number(ctx.match[1] || 0));
            await safeEdit(ctx, ui.text, { parse_mode: "HTML", reply_markup: ui.reply_markup });
            if (ctx.session) ctx.session.lastAction = "nodes:list";
        });

        bot.action(/^ux:n:v:(.+)$/, async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const key = decodeURIComponent(ctx.match[1]);
            const nodes = listNodes(deps.activeSockets);
            const item = nodes.find(n => n.sessionKey === key);

            if (!item) {
                return safeEdit(ctx, "⚠️ Node not found. It may have gone offline.", {
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "ux:n:p:0" }]] },
                });
            }

            const ui = renderNodeMenu(item);
            await safeEdit(ctx, ui.text, { parse_mode: "HTML", reply_markup: ui.reply_markup });
            if (ctx.session) ctx.session.lastAction = `node:${item.sessionKey}`;
        });

        bot.action(/^ux:n:g:(.+)$/, async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const key = decodeURIComponent(ctx.match[1]);
            const text = panel("📡 <b>Broadcast Guide</b>", [
                "Use these commands in Telegram:",
                "<code>/gcast Your message</code>",
                "<code>/godcast Your premium message</code>",
                "For media URL tools in WhatsApp:",
                "<code>.tourl</code> / <code>.imgurl</code> / <code>.videourl</code> / <code>.fileurl</code>",
                "Tip: Keep messages short for better delivery.",
            ]);
            await safeEdit(ctx, text, {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Node", callback_data: `ux:n:v:${encodeURIComponent(key)}` }]] },
            });
        });

        bot.action(/^ux:n:s:(.+)$/, async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const key = decodeURIComponent(ctx.match[1]);
            const text = panel("📸 <b>Status Guide</b>", [
                "Use:",
                "<code>/status Your text status</code>",
                "For media status, send a photo/video with caption:",
                "<code>/castmedia</code>",
                "Need a direct media link? Use in WhatsApp:",
                "<code>.tourl</code>",
            ]);
            await safeEdit(ctx, text, {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Node", callback_data: `ux:n:v:${encodeURIComponent(key)}` }]] },
            });
        });

        bot.action(/^ux:n:t:(.+)$/, async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const key = decodeURIComponent(ctx.match[1]);
            const text = panel("⚙️ <b>Node Settings</b>", [
                "This panel is ready for node-specific settings.",
                "Quick action available:",
                "• Restart node connection",
            ]);
            await safeEdit(ctx, text, {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔄 Restart Node", callback_data: `ux:n:r:${encodeURIComponent(key)}` }],
                        [{ text: "🔙 Back to Node", callback_data: `ux:n:v:${encodeURIComponent(key)}` }],
                    ],
                },
            });
        });

        bot.action(/^ux:n:u:(.+)$/, async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            const key = decodeURIComponent(ctx.match[1]);
            const text = panel("🔗 <b>Media URL Tools</b>", [
                "Run these in WhatsApp chat:",
                "<code>.tourl</code> - auto detect image/video/file",
                "<code>.imgurl</code> - image only",
                "<code>.videourl</code> - video only",
                "<code>.fileurl</code> - document only",
                "Usage: Reply to media then run the command.",
            ]);
            await safeEdit(ctx, text, {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔙 Back to Node", callback_data: `ux:n:v:${encodeURIComponent(key)}` }],
                    ],
                },
            });
        });

        bot.action(/^ux:n:r:(.+)$/, async (ctx) => {
            await ctx.answerCbQuery("Restarting node...").catch(() => {});
            const key = decodeURIComponent(ctx.match[1]);
            const sock = deps.activeSockets.get(key);

            if (!sock) {
                return safeEdit(ctx, "⚠️ Node is offline or unavailable.", {
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "ux:n:p:0" }]] },
                });
            }

            const parts = key.split("_");
            const chatId = parts[0];
            const phone = parts[1];
            const slot = parts[2] || "1";

            await safeEdit(ctx, "⏳ Restarting node connection...", { parse_mode: "HTML" });

            try {
                try { sock.ws?.close(); } catch (_) {}
                deps.activeSockets.delete(key);
                await deps.startWhatsApp(chatId, phone, slot, true);

                await safeEdit(
                    ctx,
                    panel("✅ <b>Node Restarted</b>", [
                        `Node <code>+${phone}</code> is reconnecting.`,
                        "Would you like to open Broadcast Guide now?",
                    ]),
                    {
                        parse_mode: "HTML",
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "📡 Open Broadcast Guide", callback_data: `ux:n:g:${encodeURIComponent(key)}` }],
                                [{ text: "🔙 Back to Node", callback_data: `ux:n:v:${encodeURIComponent(key)}` }],
                            ],
                        },
                    }
                );
            } catch (err) {
                deps.logger.error("[NodesCommand] Restart failed", { sessionKey: key, error: err.message });
                await safeEdit(ctx, "⚠️ Something went wrong while restarting this node. Please try again.", {
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: `ux:n:v:${encodeURIComponent(key)}` }]] },
                });
            }
        });

        bot.action("ux:n:close", async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            await safeEdit(ctx, "✅ Closed. Use /nodes anytime to reopen the control center.", { parse_mode: "HTML" });
        });
    },
};
