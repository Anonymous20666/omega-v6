"use strict";

const {
    getTgUser,
    saveTgUser,
    addTgCoins,
    addTgXP,
    getTgLeaderboard,
} = require("../../storage");

const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SPIN_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const ENERGY_REGEN_MS = 5 * 60 * 1000;
const ENERGY_REGEN_STEP = 2;

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function now() {
    return Date.now();
}

function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function computeTitle(level) {
    if (level >= 60) return "God Tier";
    if (level >= 40) return "Shadow King";
    if (level >= 25) return "Elite";
    if (level >= 12) return "Grinder";
    return "Rookie";
}

function regenEnergy(profile) {
    const p = profile;
    const ts = Number(p.energyUpdatedAt || now());
    const elapsed = now() - ts;
    if (elapsed < ENERGY_REGEN_MS) return p;
    const ticks = Math.floor(elapsed / ENERGY_REGEN_MS);
    if (ticks <= 0) return p;
    p.energy = Math.min(Number(p.maxEnergy || 100), Number(p.energy || 0) + (ticks * ENERGY_REGEN_STEP));
    p.energyUpdatedAt = now();
    return p;
}

function gameMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: "🎡 Spin", callback_data: "tg_game_spin" }, { text: "🎁 Daily", callback_data: "tg_game_daily" }],
            [{ text: "💰 Balance", callback_data: "tg_game_balance" }, { text: "👤 Profile", callback_data: "tg_game_profile" }],
            [{ text: "🎒 Inventory", callback_data: "tg_game_inventory" }, { text: "🏆 Leaderboard", callback_data: "tg_game_lb" }],
        ],
    };
}

async function sendBalance(ctx) {
    const uid = String(ctx.from?.id || "");
    const profile = regenEnergy(getTgUser(uid));
    profile.username = ctx.from?.username || profile.username || "";
    profile.lastSeenAt = now();
    saveTgUser(uid, profile);

    const text = [
        "💰 <b>Balance</b>",
        `Coins: <b>${Number(profile.coins || 0).toLocaleString()}</b>`,
        `XP: <b>${Number(profile.xp || 0)}</b>`,
        `Level: <b>${Number(profile.level || 1)}</b> (${computeTitle(Number(profile.level || 1))})`,
        `Energy: <b>${Number(profile.energy || 0)}/${Number(profile.maxEnergy || 100)}</b>`,
    ].join("\n");

    await ctx.reply(text, { parse_mode: "HTML", reply_markup: gameMenuKeyboard() }).catch(() => {});
}

async function sendProfile(ctx) {
    const uid = String(ctx.from?.id || "");
    const profile = regenEnergy(getTgUser(uid));
    profile.username = ctx.from?.username || profile.username || "";
    profile.lastSeenAt = now();
    saveTgUser(uid, profile);

    const wins = Number(profile.wins || 0);
    const losses = Number(profile.losses || 0);
    const total = wins + losses;
    const wr = total > 0 ? ((wins / total) * 100).toFixed(1) : "0.0";

    const text = [
        "🧬 <b>Player Profile</b>",
        `Name: <b>${escapeHtml(ctx.from?.first_name || ctx.from?.username || "Player")}</b>`,
        `Title: <b>${computeTitle(Number(profile.level || 1))}</b>`,
        `Level: <b>${Number(profile.level || 1)}</b>`,
        `XP: <b>${Number(profile.xp || 0)}</b> / ${(Number(profile.level || 1) * 100)}`,
        `Coins: <b>${Number(profile.coins || 0).toLocaleString()}</b>`,
        `Energy: <b>${Number(profile.energy || 0)}/${Number(profile.maxEnergy || 100)}</b>`,
        `Wins/Losses: <b>${wins}/${losses}</b> (WR ${wr}%)`,
        `Daily Streak: <b>${Number(profile.streak || 0)}</b>`,
        `Referrals: <b>${Number(profile.referrals || 0)}</b>`,
    ].join("\n");

    await ctx.reply(text, { parse_mode: "HTML", reply_markup: gameMenuKeyboard() }).catch(() => {});
}

async function doDaily(ctx) {
    const uid = String(ctx.from?.id || "");
    const profile = regenEnergy(getTgUser(uid));
    const last = Number(profile.lastDaily || 0);
    const elapsed = now() - last;
    if (elapsed < DAILY_COOLDOWN_MS) {
        await ctx.reply(`⏳ Daily already claimed. Try again in <b>${formatDuration(DAILY_COOLDOWN_MS - elapsed)}</b>.`, { parse_mode: "HTML", reply_markup: gameMenuKeyboard() }).catch(() => {});
        return;
    }

    const yesterdayWindow = elapsed <= (DAILY_COOLDOWN_MS + (4 * 60 * 60 * 1000));
    profile.streak = yesterdayWindow ? Number(profile.streak || 0) + 1 : 1;
    profile.lastDaily = now();
    const streakBonus = Math.min(profile.streak * 20, 500);
    const baseCoins = 700;
    const totalCoins = baseCoins + streakBonus;
    profile.coins = Number(profile.coins || 0) + totalCoins;
    profile.username = ctx.from?.username || profile.username || "";
    profile.lastSeenAt = now();
    saveTgUser(uid, profile);
    addTgXP(uid, 35);

    await ctx.reply(
        `🎁 <b>Daily Claimed</b>\n+<b>${baseCoins}</b> coins\n🔥 Streak bonus: +<b>${streakBonus}</b>\n\nTotal: <b>${totalCoins}</b> coins`,
        { parse_mode: "HTML", reply_markup: gameMenuKeyboard() }
    ).catch(() => {});
}

function randomSpinReward() {
    const roll = Math.random() * 100;
    if (roll < 1) return { type: "jackpot", coins: 5000, label: "💥 JACKPOT" };
    if (roll < 8) return { type: "legendary", coins: 1500, label: "🟠 Legendary" };
    if (roll < 28) return { type: "epic", coins: 650, label: "🟣 Epic" };
    if (roll < 65) return { type: "rare", coins: 280, label: "🔵 Rare" };
    if (roll < 92) return { type: "common", coins: 120, label: "🟢 Common" };
    return { type: "miss", coins: 0, label: "⚫ Miss" };
}

async function doSpin(ctx) {
    const uid = String(ctx.from?.id || "");
    const profile = regenEnergy(getTgUser(uid));
    const last = Number(profile.lastSpin || 0);
    const elapsed = now() - last;
    if (elapsed < SPIN_COOLDOWN_MS) {
        await ctx.reply(`⏳ Spin cooldown active. Try again in <b>${formatDuration(SPIN_COOLDOWN_MS - elapsed)}</b>.`, { parse_mode: "HTML", reply_markup: gameMenuKeyboard() }).catch(() => {});
        return;
    }

    const reward = randomSpinReward();
    profile.lastSpin = now();
    profile.username = ctx.from?.username || profile.username || "";
    profile.lastSeenAt = now();

    if (reward.coins > 0) {
        profile.coins = Number(profile.coins || 0) + reward.coins;
        addTgXP(uid, reward.type === "jackpot" ? 80 : 25);
    } else {
        addTgXP(uid, 8);
    }

    if (reward.type === "legendary" || reward.type === "jackpot") {
        profile.inventory.push({
            item_name: reward.type === "jackpot" ? "Mythic Lucky Core" : "Lucky Token",
            rarity: reward.type === "jackpot" ? "mythic" : "legendary",
            amount: 1,
        });
    }

    saveTgUser(uid, profile);

    const text = [
        "🎡 <b>Spin Result</b>",
        `Tier: <b>${reward.label}</b>`,
        `Reward: <b>${reward.coins > 0 ? `+${reward.coins} coins` : "No coin reward"}</b>`,
        `Balance: <b>${Number(profile.coins || 0).toLocaleString()}</b>`,
    ].join("\n");

    await ctx.reply(text, { parse_mode: "HTML", reply_markup: gameMenuKeyboard() }).catch(() => {});
}

async function sendInventory(ctx) {
    const uid = String(ctx.from?.id || "");
    const profile = regenEnergy(getTgUser(uid));
    profile.username = ctx.from?.username || profile.username || "";
    profile.lastSeenAt = now();
    saveTgUser(uid, profile);

    const inv = Array.isArray(profile.inventory) ? profile.inventory : [];
    if (!inv.length) {
        await ctx.reply("🎒 <b>Inventory is empty.</b>\nUse /spin and /daily to collect loot.", { parse_mode: "HTML", reply_markup: gameMenuKeyboard() }).catch(() => {});
        return;
    }
    const top = inv.slice(-12).reverse();
    const rows = top.map((it, i) => `${i + 1}. <b>${escapeHtml(it.item_name || "Item")}</b> • ${escapeHtml(it.rarity || "common")} x${Number(it.amount || 1)}`);
    await ctx.reply(`🎒 <b>Inventory</b>\n\n${rows.join("\n")}`, { parse_mode: "HTML", reply_markup: gameMenuKeyboard() }).catch(() => {});
}

async function sendLeaderboard(ctx) {
    const rows = getTgLeaderboard(10);
    if (!rows.length) {
        await ctx.reply("🏆 Leaderboard is empty.", { reply_markup: gameMenuKeyboard() }).catch(() => {});
        return;
    }
    const textRows = rows.map((u, i) => {
        const rank = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
        const name = escapeHtml(u.username || `user_${u.id}`);
        return `${rank} <b>${name}</b> — ${Number(u.coins || 0).toLocaleString()} coins`;
    });
    await ctx.reply(`🏆 <b>Top Players</b>\n\n${textRows.join("\n")}`, { parse_mode: "HTML", reply_markup: gameMenuKeyboard() }).catch(() => {});
}

module.exports = {
    name: "game",
    aliases: ["games"],
    requiredRole: "USER",
    cooldown: 2,

    async handler({ ctx }) {
        await ctx.reply(
            "🎮 <b>Games Hub</b>\nSpin, claim daily rewards, build profile, and climb leaderboard.",
            { parse_mode: "HTML", reply_markup: gameMenuKeyboard() }
        ).catch(() => {});
    },

    register(bot) {
        bot.command("balance", async (ctx) => sendBalance(ctx));
        bot.command("daily", async (ctx) => doDaily(ctx));
        bot.command("spin", async (ctx) => doSpin(ctx));
        bot.command("profile", async (ctx) => sendProfile(ctx));
        bot.command("inventory", async (ctx) => sendInventory(ctx));
        bot.command("leaderboard", async (ctx) => sendLeaderboard(ctx));

        bot.action("tg_game_open", async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            await ctx.reply(
                "🎮 <b>Games Hub</b>\nPick an action below.",
                { parse_mode: "HTML", reply_markup: gameMenuKeyboard() }
            ).catch(() => {});
        });

        bot.action("tg_game_balance", async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await sendBalance(ctx); });
        bot.action("tg_game_daily", async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await doDaily(ctx); });
        bot.action("tg_game_spin", async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await doSpin(ctx); });
        bot.action("tg_game_profile", async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await sendProfile(ctx); });
        bot.action("tg_game_inventory", async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await sendInventory(ctx); });
        bot.action("tg_game_lb", async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await sendLeaderboard(ctx); });
    },
};
