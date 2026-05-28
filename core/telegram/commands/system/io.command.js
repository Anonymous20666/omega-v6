"use strict";

const { panel } = require("../../ui");
const {
    getIoStats,
    getIoMonitorLevel,
    setIoMonitorLevel,
    getSessionState,
} = require("../../../whatsapp");

function formatAgo(ts) {
    if (!ts) return "never";
    const sec = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    return `${hr}h ago`;
}

function summarizeNode(sessionKey, sock) {
    const parts = String(sessionKey).split("_");
    const phone = parts[1] || sessionKey;
    const stat = getIoStats(sessionKey) || { in: 0, out: 0, lastIn: 0, lastOut: 0 };
    const state = getSessionState(sessionKey) || "unknown";
    const online = !!sock?.user;

    const inCount = Number(stat.in || 0);
    const outCount = Number(stat.out || 0);
    const inAgo = formatAgo(stat.lastIn);
    const outAgo = formatAgo(stat.lastOut);

    let health = "ok";
    if (!online) health = "offline";
    else if (outCount > 20 && !stat.lastIn) health = "incoming-stalled";
    else if (stat.lastOut && (!stat.lastIn || (Date.now() - Number(stat.lastIn || 0)) > (10 * 60 * 1000))) {
        health = "incoming-stalled";
    }

    return {
        sessionKey,
        phone,
        state,
        online,
        inCount,
        outCount,
        inAgo,
        outAgo,
        health,
    };
}

module.exports = {
    name: "iostats",
    aliases: ["io", "iolog"],
    description: "Show per-node WhatsApp incoming/outgoing stats and logger mode",
    usage: "/iostats | /io | /iolog [off|normal|verbose]",
    requiredRole: "ADMIN",
    cooldown: 2,

    handler: async ({ ctx, deps }) => {
        const text = String(ctx.message?.text || "").trim();
        const [rawCmd, rawArg] = text.split(/\s+/, 2);
        const cmd = String(rawCmd || "").toLowerCase();
        const arg = String(rawArg || "").trim().toLowerCase();

        if (cmd.startsWith("/iolog")) {
            if (!arg) {
                return ctx.reply(
                    `🔎 <b>WA IO Logger</b>\nCurrent mode: <code>${getIoMonitorLevel()}</code>\n\nUsage: <code>/iolog off</code>, <code>/iolog normal</code>, <code>/iolog verbose</code>`,
                    { parse_mode: "HTML" }
                );
            }
            const next = setIoMonitorLevel(arg);
            return ctx.reply(`✅ IO logger mode set to <code>${next}</code>.`, { parse_mode: "HTML" });
        }

        const rows = [];
        for (const [sessionKey, sock] of deps.activeSockets.entries()) {
            rows.push(summarizeNode(sessionKey, sock));
        }

        rows.sort((a, b) => a.phone.localeCompare(b.phone));

        const lines = [
            `Logger mode: <code>${getIoMonitorLevel()}</code>`,
            `Active sockets: <b>${rows.length}</b>`,
            "",
        ];

        for (const row of rows.slice(0, 30)) {
            const icon = row.health === "ok" ? "🟢" : (row.health === "incoming-stalled" ? "🟠" : "🔴");
            lines.push(`${icon} <b>+${row.phone}</b> <code>${row.state}</code>`);
            lines.push(`in=<code>${row.inCount}</code> (${row.inAgo}) | out=<code>${row.outCount}</code> (${row.outAgo})`);
        }

        if (rows.length > 30) {
            lines.push("");
            lines.push(`…showing first 30 of ${rows.length} nodes`);
        }

        lines.push("");
        lines.push("Legend: 🟢 healthy, 🟠 outgoing but incoming stalled, 🔴 offline");

        const msg = panel("📶 <b>WhatsApp IO Health</b>", lines);
        await ctx.reply(msg, { parse_mode: "HTML" });
    },
};
