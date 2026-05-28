// core/models/Intel.js
const mongoose = require('mongoose');

// Shared Intel schema used by Telegram + WhatsApp runtime.
// Keep backward compatibility with old `linkCode` while using `code` as primary runtime field.
const intelSchema = new mongoose.Schema({
    code: { type: String, trim: true },
    linkCode: { type: String, trim: true },
    groupName: { type: String, default: '' },
    groupJid: { type: String, default: '' },
    members: { type: Number, default: 0 },
    status: { type: String, default: 'pending' }, // pending | valid | joined | expired | failed
    source: { type: String, default: 'unknown' },
    seenAt: { type: Date, default: Date.now },
    validatedAt: { type: Date, default: null },
    dateAdded: { type: Date, default: Date.now },
    lastError: { type: String, default: '' },
}, {
    timestamps: true,
});

intelSchema.pre('validate', function syncLegacyCode(next) {
    if (!this.code && this.linkCode) this.code = this.linkCode;
    if (!this.linkCode && this.code) this.linkCode = this.code;
    next();
});

intelSchema.index({ linkCode: 1 }, { unique: true, sparse: true });
intelSchema.index({ code: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Intel', intelSchema);
