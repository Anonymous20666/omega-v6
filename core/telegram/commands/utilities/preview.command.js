"use strict";

const { panel } = require("../../ui");

function pickUrl(text) {
    const m = String(text || "").match(/https?:\/\/[^\s<>"']+/i);
    return m ? m[0] : null;
}

module.exports = {
    name: "preview",
    aliases: ["lp", "linkpreview"],
    description: "Generate universal link preview",
    usage: "/preview https://example.com",
    requiredRole: "USER",
    cooldown: 2,

    handler: async ({ ctx, args, deps }) => {
        const input = args.join(" ").trim();
        const url = pickUrl(input);

        if (!url) {
            return ctx.reply("⚠️ Usage:\n<code>/preview https://example.com</code>", { parse_mode: "HTML" }).catch(() => {});
        }

        const loading = await ctx.reply("⏳ Processing link preview...", { parse_mode: "HTML" }).catch(() => null);

        try {
            const result = await deps.buildLinkPreview(url, true);
            if (!result) {
                if (loading) await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
                return ctx.reply("⚠️ Could not fetch metadata for this link. Try another URL.", { parse_mode: "HTML" }).catch(() => {});
            }

            // Rich card format with prominent thumbnail
            const title = String(result.title || "Link Preview").replace(/</g, "&lt;").slice(0, 100);
            const desc = String(result.description || "").replace(/</g, "&lt;").slice(0, 200);
            const urlDomain = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "Link"; } })();

            const text = `
<b>🔗 ${title}</b>

${desc ? `<i>${desc}</i>\n\n` : ""}
<code>${urlDomain}</code>
<a href="${url}">Open ↗️</a>`;

            const reply_markup = {
                inline_keyboard: [[{ text: "🌐 Open", url }]]
            };

            if (result.thumbnail) {
                await ctx.replyWithPhoto(
                    { source: Buffer.isBuffer(result.thumbnail) ? result.thumbnail : Buffer.from(result.thumbnail) },
                    { caption: text.trim(), parse_mode: "HTML", reply_markup }
                ).catch(async () => {
                    await ctx.reply(text.trim(), { parse_mode: "HTML", reply_markup }).catch(() => {});
                });
            } else {
                await ctx.reply(text.trim(), { parse_mode: "HTML", reply_markup }).catch(() => {});
            }

            if (loading) await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
        } catch (err) {
            deps.logger.error(`[PreviewCommand] Failed for ${url}: ${err?.stack || err?.message || String(err)}`);
            if (loading) await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
            await ctx.reply("⚠️ Something went wrong while processing this link. Please try again.", { parse_mode: "HTML" }).catch(() => {});
        }
    },
};
