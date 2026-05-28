// core/database.js
'use strict';

const mongoose = require('mongoose');
const logger = require('./logger');
require('dotenv').config();

mongoose.set('bufferCommands', false);

const MONGO_URI = process.env.MONGO_URI;
const CONNECT_OPTS = {
    serverSelectionTimeoutMS: 8000,
    heartbeatFrequencyMS: 15000,
    maxPoolSize: 10,
    minPoolSize: 1,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
    retryWrites: true,
    retryReads: true,
};

let _reconnectTimer = null;

function scheduleReconnect(delayMs = 10000) {
    if (_reconnectTimer) return; // already scheduled — don't stack
    _reconnectTimer = setTimeout(async () => {
        _reconnectTimer = null;
        await connectDB();
    }, delayMs);
}

mongoose.connection.on('disconnected', () => {
    logger.warn('[DATABASE] MongoDB disconnected — reconnecting in 10s...');
    scheduleReconnect(10000);
});

mongoose.connection.on('error', (err) => {
    logger.error(`[DATABASE] MongoDB error: ${err.message}`);
});

mongoose.connection.on('reconnected', () => {
    logger.success('[DATABASE] MongoDB reconnected');
});

async function connectDB() {
    // Already connected or connecting — skip
    if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
    if (!MONGO_URI || MONGO_URI.includes('your_secure_password')) {
        logger.warn('[DATABASE] MONGO_URI not configured — running without database');
        return;
    }
    try {
        await mongoose.connect(MONGO_URI, CONNECT_OPTS);
        logger.success('[DATABASE] MongoDB connected');
    } catch (err) {
        logger.error(`[DATABASE] Connection failed: ${err.message} — retrying in 15s`);
        scheduleReconnect(15000);
    }
}

module.exports = { connectDB };
