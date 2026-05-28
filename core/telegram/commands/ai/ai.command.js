"use strict";
// commands/ai/ai.command.js — AI chat + prompt management

module.exports = {
    name: "ai",
    requiredRole: "USER",
    cooldown: 5,

    async handler({ ctx, args, deps }) {
        const { ai } = deps;
        if (!ai) return ctx.reply("AI is offline right now.");
        const prompt = args.join(" ").trim();
        if (!prompt) return ctx.reply("just ask me something\nexample: /ai what is 2+2");
        try {
            const response = await ai.generateText(prompt, String(ctx.from.id));
            await ctx.reply(response);
        } catch (e) {
            await ctx.reply(`couldn't reach AI: ${e.message}`);
        }
    },

    register(bot, deps) {
        const { getCustomPrompt, saveCustomPrompt, PROMPT_FILE, fsp } = deps;

        bot.action("cmd_ai_help", (ctx) => {
            ctx.answerCbQuery();
            ctx.editMessageText(
                "🧠 <b>OMEGA AI ASSISTANT</b>\n\nThe AI is connected. To use it, simply type:\n\n<code>/ai [Your prompt here]</code>\n\nExample: <code>/ai Write a high-converting promotional message for my crypto group</code>",
                { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Hub", callback_data: "menu_main" }]] } }
            ).catch(() => {});
        });

        bot.action("cmd_ai_prompt", async (ctx) => {
            ctx.answerCbQuery();
            const current = getCustomPrompt() || "(using default prompt)";
            const preview = current.length > 300 ? current.slice(0, 300) + "..." : current;
            ctx.editMessageText(
                `🧠 <b>AI PROMPT EDITOR</b>\n\n<b>Current prompt:</b>\n<code>${preview.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>\n\n<i>Send your new prompt as a message now.\nOr tap Reset to go back to default.</i>`,
                { parse_mode: "HTML", reply_markup: { inline_keyboard: [
                    [{ text: "🔄 Reset to Default", callback_data: "cmd_ai_prompt_reset" }],
                    [{ text: "🔙 Back to Hub", callback_data: "menu_main" }]
                ]}}
            ).catch(() => {});
            ctx.session = ctx.session || {};
            ctx.session.awaitingPrompt = true;
        });

        bot.action("cmd_ai_prompt_reset", async (ctx) => {
            ctx.answerCbQuery("Prompt reset.");
            try { await fsp.unlink(PROMPT_FILE); } catch { /* already gone */ }
            ctx.editMessageText("✅ <b>AI prompt reset to default.</b>", {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Hub", callback_data: "menu_main" }]] }
            }).catch(() => {});
        });
    },
};
