"use strict";
// commands/intel/osint.command.js — OSINT WhatsApp link extractor

module.exports = {
    name: "osint",
    requiredRole: "ADMIN",
    cooldown: 10,

    async handler({ ctx, args, deps }) {
        const { Intel } = deps;
        const text = ctx.message?.reply_to_message?.text || args.join(" ").trim();
        if (!text) return ctx.reply("❌ *Syntax:* Reply to a message with `/osint` or paste text after the command.", { parse_mode: "Markdown" });

        const waitMsg = await ctx.reply("🕵️‍♂️ <b>ANALYZING TEXT FOR WHATSAPP INTELLIGENCE...</b>", { parse_mode: "HTML" });

        try {
            const regex = /chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/ig;
            let match;
            let addedCount = 0;
            let duplicates = 0;

            while ((match = regex.exec(text)) !== null) {
                const code = match[1];
                try {
                    const result = await Intel.updateOne(
                        { linkCode: code },
                        { $setOnInsert: { linkCode: code, status: "pending" } },
                        { upsert: true }
                    );
                    if (result.upsertedCount > 0) addedCount++;
                    else duplicates++;
                } catch { duplicates++; }
            }

            const msg = addedCount > 0
                ? `✅ <b>OSINT SUCCESS</b>\n\nExtracted and securely saved <b>${addedCount}</b> new WhatsApp links to the database. (Skipped ${duplicates} duplicates).`
                : `⚠️ <b>NO NEW LINKS</b>\nFound ${duplicates} links, but they were already safely secured in the database.`;

            await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, msg, { parse_mode: "HTML" });
        } catch (err) {
            await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `❌ <b>ERROR:</b> ${err.message}`, { parse_mode: "HTML" });
        }
    },
};
