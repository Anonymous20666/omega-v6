// index.js
// Ω ELITE MULTI-SESSION OPERATOR (ADVANCED CORE)

const fs = require('fs');
const path = require('path');
const { startWhatsApp, activeSockets } = require('./core/whatsapp');
const { startTelegram } = require('./core/telegram');
const logger = require('./core/logger');
const { ownerTelegramId } = require('./config');
const watchdog = require('./core/watchdog');
const { connectDB } = require('./core/database'); // 👈 NEW: Importing our database connector
const crashGuard = require('./core/stability/crashGuard');
const healthMonitor = require('./core/stability/healthMonitor');
const sessionRepair = require('./core/stability/sessionRepair');
const tempCleaner = require('./core/stability/tempCleaner');
const { getKernel } = require('./core/runtimeKernel');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 🛡️ ENTERPRISE CRASH GUARD
crashGuard.install();
crashGuard.registerShutdown('stability-services', async () => {
    try { healthMonitor.stop(); } catch {}
    try { tempCleaner.stop(); } catch {}
    try { getKernel({ logger, engine: require('./core/engine') }).shutdown('crash-guard'); } catch {}
});

// Suppress gifted-baileys internal signal session console.log spam
// Only suppress to file — never intercept console.log as it breaks Baileys event processing
const _origLog = console.log.bind(console);
// Do NOT override console.log — it breaks Baileys internal event handling

// Suppress libsignal Bad MAC / Session error spam from stderr
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, encoding, cb) => {
    const s = String(chunk || '');
    if (s.includes('Bad MAC') || s.includes('Session error') || s.includes('Failed to decrypt') || s.includes('Closing session') || s.includes('Closing open session')) {
        if (typeof cb === 'function') cb();
        return true;
    }
    return _origStderrWrite(chunk, encoding, cb);
};

async function isBootableSessionDir(sessionsDir, folder) {
    const full = path.join(sessionsDir, folder);
    if (!fs.existsSync(full)) return false;
    try {
        if (!fs.statSync(full).isDirectory()) return false;
    } catch {
        return false;
    }
    const result = await sessionRepair.validateCredentials(folder);
    return result.valid && result.registered === true;
}

async function bootEliteOperator() {
    try {
        const kernel = getKernel({ logger, engine: require('./core/engine') });
        kernel.start();
        console.clear();
        logger.info('🚀 IGNITING PAPPY ULTIMATE ENGINE...');

        tempCleaner.start();
        healthMonitor.start();

        // 👈 NEW: Connect to our new MongoDB fortress first!
        await connectDB();

        let tgBot;
        try {
            tgBot = await startTelegram();
            global.tgBot = tgBot;
            logger.success('✅ Telegram Command Center Online');
        } catch (e) { logger.error(`Telegram Dashboard failed to boot: ${e.message}`); }

        global.waSocks = activeSockets || new Map();
        const sessionsDir = path.join(__dirname, 'data/sessions');

        if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
        
        logger.info('🔍 Running pre-flight diagnostics...');
        // Never delete session dirs during boot; only validate/prune safely.
        await sessionRepair.sweepGhostSessions({ destructive: false });
        await sessionRepair.runFullAudit();

        const allSessionEntries = fs.readdirSync(sessionsDir);
        const sessionChecks = await Promise.all(
            allSessionEntries.map(async (file) => ({
                file,
                bootable: await isBootableSessionDir(sessionsDir, file),
            }))
        );
        const validSessions = sessionChecks.filter((x) => x.bootable).map((x) => x.file);

        if (validSessions.length === 0) {
            logger.info('⚠️ No saved sessions found. Use /pair in Telegram to link a bot.');
        } else {
            logger.info(`📁 Found ${validSessions.length} active session(s). Initiating parallel boot lanes...`);

            await Promise.allSettled(validSessions.map(async (sessionFolder, idx) => {
                logger.info(`Booting instance: ${sessionFolder}...`);
                const parts = sessionFolder.split('_');
                const chatId = parts.length >= 2 ? parts[0] : ownerTelegramId;
                const phoneNumber = parts.length >= 2 ? parts[1] : sessionFolder;
                const slotId = parts[2] || '1';

                try {
                    // Small stagger avoids thundering herd while keeping lanes independent.
                    await delay(idx * 250);
                    const waSock = await startWhatsApp(chatId, phoneNumber, slotId, true);

                    if (waSock) {
                        global.waSocks.set(sessionFolder, waSock);
                        // Attach watchdog after connection is open so waSock.user is populated
                        waSock.ev.on('connection.update', ({ connection }) => {
                            if (connection !== 'open') return;
                            const botId = waSock.user?.id?.split(':')[0];
                            if (!botId) return;
                            try {
                                watchdog.attach(botId, waSock, async () => {
                                    logger.error(`[WATCHDOG] Restarting frozen session: ${sessionFolder}`);
                                    try { waSock.ws.close(); } catch(e){}
                                    activeSockets.delete(sessionFolder);
                                    await delay(1500);
                                    await startWhatsApp(chatId, phoneNumber, slotId, true);
                                });
                            } catch(e) { logger.warn(`[WATCHDOG] Attach failed: ${e.message}`); }
                        });
                    }
                } catch (e) {
                    logger.error(`❌ Failed to boot session ${sessionFolder}: ${e.message}`);
                }
            }));
        }
        
        logger.system('✅ SYSTEM FULLY ONLINE AND AWAITING COMMANDS.');

        // Warm up AI model — eliminates cold start lag on first group message
        setTimeout(async () => {
            try {
                const ai = require('./core/ai');
                await ai.generateText('hi', 'warmup', { platform: 'whatsapp', extra: '' });
                logger.info('[AI] Model warmed up and ready');
            } catch (e) {
                logger.warn(`[AI] Warmup skipped: ${e.message}`);
            }
        }, 5000);

    } catch (error) { logger.error(`Critical Boot Failure: ${error.message}`); }
}

bootEliteOperator();
