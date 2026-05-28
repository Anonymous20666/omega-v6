"use strict";

const { panel } = require("../../ui");

function parseTargetId(raw) {
    return String(raw || "").replace(/[^0-9]/g, "");
}

module.exports = {
    name: "role",
    aliases: ["roles"],
    description: "Manage Telegram RBAC roles",
    usage: "/role add <admin|sudo|user> <telegramUserId>",
    requiredRole: "OWNER",
    cooldown: 1,

    handler: async ({ ctx, args, deps }) => {
        const action = String(args[0] || "").toLowerCase();
        const requestedRole = String(args[1] || "").toUpperCase();
        const targetRaw = args[2] || args[1] || "";

        if (!action || action === "help") {
            return ctx.reply(
                panel("🛡️ <b>RBAC Role Manager</b>", [
                    "<code>/role list</code>",
                    "<code>/role add ADMIN 123456789</code>",
                    "<code>/role add SUDO 123456789</code>",
                    "<code>/role add USER 123456789</code>",
                    "<code>/role remove 123456789</code>",
                ]),
                { parse_mode: "HTML" }
            ).catch(() => {});
        }

        if (action === "list") {
            const dump = deps.rbac.getAllRoleAssignments();
            const admins = dump.adminUserIds.length ? dump.adminUserIds.map((x) => `<code>${x}</code>`).join("\n") : "None";
            const sudos = dump.sudoUserIds.length ? dump.sudoUserIds.map((x) => `<code>${x}</code>`).join("\n") : "None";

            return ctx.reply(
                panel("🛡️ <b>Current Roles</b>", [
                    `<b>OWNER:</b> <code>${dump.ownerUserId}</code>`,
                    "",
                    `<b>SUDO:</b>\n${sudos}`,
                    "",
                    `<b>ADMIN:</b>\n${admins}`,
                ]),
                { parse_mode: "HTML" }
            ).catch(() => {});
        }

        if (action === "remove") {
            const targetId = parseTargetId(args[1]);
            if (!targetId) return ctx.reply("⚠️ Usage: <code>/role remove 123456789</code>", { parse_mode: "HTML" }).catch(() => {});

            const actor = String(ctx.from?.id || "");
            await deps.rbac.removeDynamicRole(actor, targetId);
            return ctx.reply(`✅ Role removed. <code>${targetId}</code> is now USER.`, { parse_mode: "HTML" }).catch(() => {});
        }

        if (action === "add") {
            const targetId = parseTargetId(targetRaw);
            if (!targetId || !["ADMIN", "SUDO", "USER"].includes(requestedRole)) {
                return ctx.reply("⚠️ Usage: <code>/role add ADMIN 123456789</code> or <code>/role add SUDO 123456789</code>", { parse_mode: "HTML" }).catch(() => {});
            }

            const actor = String(ctx.from?.id || "");
            const finalRole = await deps.rbac.setUserRole(actor, targetId, requestedRole);
            return ctx.reply(`✅ Role updated. <code>${targetId}</code> is now <b>${finalRole}</b>.`, { parse_mode: "HTML" }).catch(() => {});
        }

        return ctx.reply("⚠️ Unknown action. Use <code>/role help</code>.", { parse_mode: "HTML" }).catch(() => {});
    },
};
