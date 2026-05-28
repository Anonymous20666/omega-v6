"use strict";

const fs = require("fs");
const path = require("path");

function walk(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;

    for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) out.push(...walk(full));
        else if (entry.endsWith(".js")) out.push(full);
    }

    return out;
}

function normalize(cmd) {
    return String(cmd || "").trim().toLowerCase();
}

function normalizeRole(role) {
    return String(role || "USER").trim().toUpperCase();
}

function createCommandRegistry({ logger, baseDir, ownerTelegramId, deps }) {
    const byName = new Map();
    const cooldowns = new Map();

    function register(def) {
        if (!def || !def.name || typeof def.handler !== "function") return;
        const names = [def.name, ...(def.aliases || [])].map(normalize);
        for (const n of names) byName.set(n, def);
    }

    function load() {
        const files = walk(baseDir);
        for (const file of files) {
            try {
                delete require.cache[require.resolve(file)];
                const def = require(file);
                register(def);
            } catch (err) {
                logger.warn("[TelegramCommandRegistry] Failed to load command", {
                    file,
                    error: err.message,
                });
            }
        }
    }

    function getRequiredRole(def) {
        return normalizeRole(def.requiredRole || def.permissions || "USER");
    }

    function hasPermission(def, ctx) {
        const userId = String(ctx.from?.id || "");
        const requiredRole = getRequiredRole(def);
        if (deps?.rbac) return deps.rbac.hasPermission(userId, requiredRole);
        return userId === String(ownerTelegramId);
    }

    function checkCooldown(def, ctx) {
        const seconds = Number(def.cooldown || 0);
        if (!seconds) return { ok: true, wait: 0 };

        const key = `${def.name}:${String(ctx.from?.id || "0")}`;
        const now = Date.now();
        const until = cooldowns.get(key) || 0;

        if (now < until) {
            return { ok: false, wait: Math.ceil((until - now) / 1000) };
        }

        cooldowns.set(key, now + seconds * 1000);
        return { ok: true, wait: 0 };
    }

    async function execute(def, ctx) {
        const text = String(ctx.message?.text || "").trim();
        const parts = text.split(/\s+/);
        parts.shift();
        const args = parts;
        const userId = String(ctx.from?.id || "");
        const userRole = deps?.rbac ? deps.rbac.getUserRole(userId) : (userId === String(ownerTelegramId) ? "OWNER" : "USER");
        const requiredRole = getRequiredRole(def);

        logger.info("[RBAC] Telegram command attempt", {
            userId,
            role: userRole,
            command: def.name,
            requiredRole,
        });

        if (!hasPermission(def, ctx)) {
            logger.warn("[RBAC] Telegram command denied", {
                userId,
                role: userRole,
                command: def.name,
                requiredRole,
            });
            await ctx.reply("⚠️ Access denied. Your role does not have permission to run this command.", { parse_mode: "HTML" }).catch(() => {});
            return;
        }

        const cooldown = checkCooldown(def, ctx);
        if (!cooldown.ok) {
            await ctx.reply(`⏳ Please wait ${cooldown.wait}s before using /${def.name} again.`, { parse_mode: "HTML" }).catch(() => {});
            return;
        }

        try {
            await def.handler({ ctx, args, deps });
        } catch (err) {
            const errMsg = err?.stack || err?.message || String(err);
            logger.error(`[TelegramCommandRegistry] Command failed [${def.name}]: ${errMsg}`);
            await ctx.reply(`⚠️ <b>Error:</b> <code>${err?.message || String(err)}</code>`, { parse_mode: 'HTML' }).catch(() => {});
        }
    }

    function registerWithBot(bot) {
        const seen = new Set();

        for (const def of byName.values()) {
            if (seen.has(def.name)) continue;
            seen.add(def.name);

            bot.command(def.name, async (ctx) => execute(def, ctx));
            for (const alias of def.aliases || []) {
                bot.command(alias, async (ctx) => execute(def, ctx));
            }

            if (typeof def.register === "function") {
                try {
                    def.register(bot, deps);
                } catch (err) {
                    logger.warn("[TelegramCommandRegistry] Callback registration failed", {
                        command: def.name,
                        error: err.message,
                    });
                }
            }
        }

        bot.action("ux:noop", async (ctx) => ctx.answerCbQuery().catch(() => {}));
    }

    return { load, registerWithBot };
}

module.exports = { createCommandRegistry };
