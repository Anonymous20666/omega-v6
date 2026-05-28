"use strict";

function parseId(raw) {
    return String(raw || '').replace(/[^0-9]/g, '');
}

module.exports = {
    name: "tgsudo",
    aliases: ["telegramsudo"],
    requiredRole: "OWNER",
    cooldown: 1,

    async handler({ ctx, args, deps }) {
        const action = String(args[0] || 'help').toLowerCase();
        const targetId = parseId(args[1]);
        const actorId = String(ctx.from?.id || '');

        if (action === 'help') {
            return ctx.reply(
                "🛡️ <b>Telegram SUDO Manager</b>\n\n" +
                "<code>/tgsudo add 123456789</code>\n" +
                "<code>/tgsudo remove 123456789</code>\n" +
                "<code>/tgsudo list</code>",
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }

        if (action === 'list') {
            const dump = deps.rbac.getAllRoleAssignments();
            const sudos = dump.sudoUserIds.length
                ? dump.sudoUserIds.map((id) => `<code>${id}</code>`).join('\n')
                : 'None';
            return ctx.reply(`🛡️ <b>Telegram SUDO IDs</b>\n\n${sudos}`, { parse_mode: 'HTML' }).catch(() => {});
        }

        if (!targetId) {
            return ctx.reply('❌ Usage: <code>/tgsudo add 123456789</code>', { parse_mode: 'HTML' }).catch(() => {});
        }

        if (action === 'add') {
            await deps.rbac.setUserRole(actorId, targetId, 'SUDO');
            return ctx.reply(`✅ Telegram user <code>${targetId}</code> is now <b>SUDO</b>.`, { parse_mode: 'HTML' }).catch(() => {});
        }

        if (action === 'remove') {
            await deps.rbac.removeDynamicRole(actorId, targetId);
            return ctx.reply(`✅ Telegram user <code>${targetId}</code> is now <b>USER</b>.`, { parse_mode: 'HTML' }).catch(() => {});
        }

        return ctx.reply('❌ Unknown action. Use <code>/tgsudo help</code>.', { parse_mode: 'HTML' }).catch(() => {});
    }
};
