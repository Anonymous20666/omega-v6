// modules/kawaiiEngine.js
/**
 * 🌸 KAWAII & ELITE AESTHETIC ENGINE
 * Minimal Luxury ASCII Formatting with OpenRouter AI Injection
 */

const ai = require('../core/ai');
const logger = require('../core/logger');

// Fallback moods in case OpenRouter times out or errors
const STATIC_MOODS = [
    "soft signal received…",
    "this one feels different ✧",
    "quiet drop, loud impact",
    "transmission secured",
    "for your eyes only ♡",
    "the architecture of exclusivity",
    "silent deployment ⎔"
];

// 🎨 PREMIUM ASCII TEMPLATES
const TEMPLATES = [
    (title, url, mood) => `✦━━━━━━━━━━━━━━✦\n♡ private access ♡\n✧ curated drop ✧\n\n  ${title}\n\n  ⤷ ${url}\n\n✦━━━━━━━━━━━━━━✦\n— ${mood} ✦`,
    (title, url, mood) => `╭─〔 ✦ invitation ✦ 〕─╮\n♡ soft launch\n☆ members only\n\n→ ${title}\n\n${url}\n╰────────────────╯\n✧ ${mood} ✧`,
    (title, url, mood) => `┏━━━━━━━━━━━━━━┓\n✧ exclusive signal ✧\n\n${title}\n\n↳ ${url}\n┗━━━━━━━━━━━━━━┛\n♡ ${mood} ♡`,
    (title, url, mood) => `┌───── •✧• ─────┐\n  ethereal drop\n  limited routing\n\n  ${title}\n\n  ➶ ${url}\n└───── •✧• ─────┘\n  ${mood}`,
    (title, url, mood) => `⌠ velvet whisper ⌡\n\n ✦ ${title}\n\n ⤿ ${url}\n\n⌡ signal secured ⌠\n— ${mood}`
];

/**
 * Trims text to prevent pushing the URL off-screen on mobile devices safely.
 */
function trimText(text, maxLength = 80) {
    if (typeof text !== 'string') return "Unknown Signal";
    const cleanText = text.trim();
    return cleanText.length > maxLength 
        ? cleanText.substring(0, maxLength - 3) + "..." 
        : cleanText || "Unknown Signal";
}

/**
 * Generates the final ASCII invite payload.
 * @param {Object} params 
 * @param {string} params.url - The extracted URL
 * @param {string} params.title - The scraped website title
 * @param {boolean} params.useAI - Whether to ping OpenRouter for a dynamic mood
 */
async function generateInvite({ url, title, useAI = false }) {
    if (!url) return "Invalid Signal";

    const safeTitle = trimText(title, 80);
    let mood = STATIC_MOODS[Math.floor(Math.random() * STATIC_MOODS.length)];

    // 🧠 OPENROUTER DYNAMIC MOOD INJECTION WITH SAAS TIMEOUT
    if (useAI && ai && typeof ai.generateText === 'function') {
        try {
            const prompt = `Write a very short, 3 to 6 word aesthetic, mysterious, or kawaii "mood line" for a link titled: "${safeTitle}". Make it completely lowercase, minimal, and luxurious. Do not use quotes, and do not put punctuation at the end.`;
            const systemPrompt = "You are an elite, minimalist luxury copywriter for an exclusive underground digital club.";
            
            // 🧠 SaaS Fix: Strict 4-second timeout. Do not let external APIs hang your bot!
            const aiResponse = await Promise.race([
                ai.generateText(prompt, systemPrompt),
                new Promise((_, reject) => setTimeout(() => reject(new Error("AI Timeout (Took longer than 4s)")), 4000))
            ]);
            
            // Validate AI output isn't a massive paragraph due to hallucination
            if (aiResponse && aiResponse.length > 0 && aiResponse.length < 50) {
                mood = aiResponse.trim().replace(/["']/g, '').toLowerCase();
            } else {
                logger.warn("[KAWAII] AI mood was too long or empty, falling back to static.");
            }
        } catch (error) {
            logger.warn(`[KAWAII] OpenRouter skipped/failed: ${error.message}`);
        }
    }

    // Select a random template and compile
    const randomTemplate = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
    return randomTemplate(safeTitle, url, mood);
}

module.exports = { generateInvite };
