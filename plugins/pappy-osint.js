// plugins/pappy-osint.js
// 🌐 OSINT HARVESTER: Web Scraping & Mass Link Extraction

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../core/logger');
const { addNewCode, hasValidatorEntry } = require('../core/linkValidator');

const INTEL_DB_PATH = path.join(__dirname, '../data/intel.json');

// Helper to safely load the auto-joiner database
function loadIntelCache() {
    if (fs.existsSync(INTEL_DB_PATH)) {
        try { return JSON.parse(fs.readFileSync(INTEL_DB_PATH, 'utf8')); } 
        catch (e) { return null; }
    }
    return { knownLinks: [], pendingQueue: [], dailyJoins: 0, lastJoinDate: '', lastJoinTimestamp: 0 };
}

function saveIntelCache(data) {
    fs.writeFileSync(INTEL_DB_PATH, JSON.stringify(data, null, 2));
}

// The core extraction logic
async function extractAndQueueLinks(text, intelCache, sock) {
    const regex = /chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/ig;
    let match;
    let addedCount = 0;
    const seen = new Set();

    while ((match = regex.exec(text)) !== null) {
        const code = String(match[1] || '').trim();
        if (!code || seen.has(code)) continue;
        seen.add(code);

        if (hasValidatorEntry(code)) continue;
        // Route to validator intake. Validator worker will classify and promote as needed.
        const outcome = addNewCode(code, { source: 'osint_scrape', scrapedAt: Date.now() });
        if (outcome === 'added') addedCount++;
    }
    return addedCount;
}

module.exports = {
    category: 'INTEL',
    commands: [
        { cmd: '.scrape', role: 'owner' },
        { cmd: '.massdrop', role: 'owner' }
    ],

    execute: async (sock, msg, args, userProfile, cmd) => {
        const chat = msg.key.remoteJid;
        const intelCache = loadIntelCache();
        if (!intelCache) return sock.sendMessage(chat, { text: '❌ Intel Engine DB is offline.' });

        // 🕸️ FEATURE 1: URL SCRAPER
        if (cmd === '.scrape') {
            const targetUrl = args[0];
            if (!targetUrl || !targetUrl.startsWith('http')) {
                return sock.sendMessage(chat, { text: '❌ *Syntax:* `.scrape https://example.com/whatsapp-links`' });
            }

            await sock.sendMessage(chat, { text: `🕸️ *OSINT ENGINE ENGAGED*\nTargeting: ${targetUrl}\nBypassing basic security...` });

            try {
                // 2026 Stealth Headers to bypass basic Cloudflare/Bot protections
                const response = await axios.get(targetUrl, {
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml',
                        'Accept-Language': 'en-US,en;q=0.9'
                    }
                });

                const $ = cheerio.load(response.data);
                const pageText = $('body').text() + ' ' + response.data; // Check both visible text and raw HTML (hrefs)

                const addedCount = await extractAndQueueLinks(pageText, intelCache, sock);

                if (addedCount > 0) {
                    saveIntelCache(intelCache);
                    return sock.sendMessage(chat, { text: `✅ *SCRAPE SUCCESSFUL*\n\nExtracted: ${addedCount} new unique links.\nThey have been pushed to the Auto-Joiner queue.` });
                } else {
                    return sock.sendMessage(chat, { text: `⚠️ *NO LINKS FOUND*\nThe page might be heavily protected by JavaScript rendering or contains no valid links.` });
                }

            } catch (err) {
                logger.error(`Scrape failed for ${targetUrl}:`, err.message);
                return sock.sendMessage(chat, { text: `❌ *SCRAPE FAILED:*\n${err.message}` });
            }
        }

        // 📥 FEATURE 2: MASS TEXT DROP
        if (cmd === '.massdrop') {
            const rawText = args.join(' ') || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation;
            
            if (!rawText) {
                return sock.sendMessage(chat, { text: '❌ *Syntax:* Reply to a giant wall of text with `.massdrop` or paste it directly.' });
            }

            const addedCount = await extractAndQueueLinks(rawText, intelCache, sock);

            if (addedCount > 0) {
                saveIntelCache(intelCache);
                return sock.sendMessage(chat, { text: `✅ *MASS DROP ACCEPTED*\n\nParsed: ${addedCount} new unique links.\nThe Auto-Joiner radar is now tracking them.` });
            } else {
                return sock.sendMessage(chat, { text: `⚠️ No valid WhatsApp invite links detected in that text.` });
            }
        }
    }
};
