// core/models/User.js
const mongoose = require('mongoose');

// This is our blueprint for a User
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true }, // Their WhatsApp number
    name: { type: String, default: 'Unknown' },
    role: { type: String, default: 'public' }, // owner, admin, or public
    xp: { type: Number, default: 0 },
    stats: {
        messagesSent: { type: Number, default: 0 },
        commandsUsed: { type: Number, default: 0 }
    },
    activity: {
        lastSeen: { type: Date, default: Date.now },
        isBanned: { type: Boolean, default: false }
    }
});

// We export this so the rest of the bot can use it
module.exports = mongoose.model('User', userSchema);
