'use strict';
// utils/validator.js — Centralized input validation & safe parsing

const path = require('path');

const SAFE_JID_RE   = /^[\d]+@(s\.whatsapp\.net|g\.us|broadcast)$/;
const SAFE_PHONE_RE = /^\d{7,15}$/;
const SAFE_CODE_RE  = /^[0-9A-Za-z]{20,24}$/;
const PRIVATE_IP_RE = /^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|::1|0\.0\.0\.0)/;

/**
 * Safely parse JSON — never throws, validates it is an object/array.
 */
function safeJsonParse(raw, fallback = null) {
    if (typeof raw !== 'string' || raw.trim() === '') return fallback;
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || (typeof parsed !== 'object' && !Array.isArray(parsed))) return fallback;
        return parsed;
    } catch {
        return fallback;
    }
}

/**
 * Resolve a file path safely within a base directory.
 * Throws if the resolved path escapes the base.
 */
function safePath(base, input) {
    if (typeof input !== 'string') throw new Error('Path input must be a string');
    if (input.includes('..') || path.isAbsolute(input)) {
        throw new Error(`Path traversal attempt blocked: ${input}`);
    }
    const resolved = path.resolve(base, path.normalize(input));
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) {
        throw new Error(`Path escapes base directory: ${resolved}`);
    }
    return resolved;
}

/** Validate a WhatsApp JID. */
function isValidJid(jid) {
    return typeof jid === 'string' && SAFE_JID_RE.test(jid);
}

/** Validate a phone number (digits only, 7-15 chars). */
function isValidPhone(phone) {
    return typeof phone === 'string' && SAFE_PHONE_RE.test(phone);
}

/** Validate a WhatsApp invite code. */
function isValidInviteCode(code) {
    return typeof code === 'string' && SAFE_CODE_RE.test(code);
}

/** Validate a URL is public (not pointing at internal infrastructure). */
function isPublicUrl(raw) {
    try {
        const u = new URL(raw);
        if (!['http:', 'https:'].includes(u.protocol)) return false;
        if (PRIVATE_IP_RE.test(u.hostname)) return false;
        return true;
    } catch {
        return false;
    }
}

/** Sanitise a string for safe Telegram HTML output. */
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/** Strip all non-digit characters. */
function digitsOnly(str) {
    return String(str).replace(/[^0-9]/g, '');
}

module.exports = { safeJsonParse, safePath, isValidJid, isValidPhone, isValidInviteCode, isPublicUrl, escapeHtml, digitsOnly };
