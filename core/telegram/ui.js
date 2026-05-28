"use strict";

function panel(title, lines = [], footer = "") {
    const body = lines.filter(Boolean).join("\n");
    return `${title}${body ? `\n\n${body}` : ""}${footer ? `\n\n${footer}` : ""}`;
}

function safeEdit(ctx, text, extra = {}) {
    return ctx.editMessageText(text, extra).catch(() => {});
}

function getPagination(page, totalPages, prefix) {
    const p = Number.isFinite(page) ? page : 0;
    const t = Math.max(1, totalPages);
    const prev = Math.max(0, p - 1);
    const next = Math.min(t - 1, p + 1);

    return [
        { text: "⬅️ Previous", callback_data: `${prefix}:p:${prev}` },
        { text: `Page ${p + 1}/${t}`, callback_data: "ux:noop" },
        { text: "➡️ Next", callback_data: `${prefix}:p:${next}` },
    ];
}

module.exports = { panel, safeEdit, getPagination };
