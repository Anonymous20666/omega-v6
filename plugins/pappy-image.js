// plugins/pappy-image.js
'use strict';

const axios  = require('axios');
const logger = require('../core/logger');

// ── Providers ────────────────────────────────────────────────────────────────

async function fromPollinations(prompt, model = 'flux-realism', w = 1024, h = 1024) {
    const seed = Math.floor(Math.random() * 9999999);
    const url  = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&model=${model}&seed=${seed}&enhance=true&safe=false`;
    const res  = await axios.get(url, { responseType: 'arraybuffer', timeout: 40000, maxRedirects: 10, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.data?.length > 5000) return Buffer.from(res.data);
    throw new Error('empty response');
}

async function fromLexica(prompt) {
    const res = await axios.get(`https://lexica.art/api/v1/search?q=${encodeURIComponent(prompt)}`, {
        timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const images = res.data?.images;
    if (!images?.length) throw new Error('no results');
    const pick   = images[Math.floor(Math.random() * Math.min(images.length, 8))];
    const imgRes = await axios.get(pick.src, { responseType: 'arraybuffer', timeout: 15000 });
    if (imgRes.data?.length > 5000) return Buffer.from(imgRes.data);
    throw new Error('empty image');
}

async function fromUnsplash(prompt) {
    // Unsplash source — real professional photos, no API key needed
    const query = encodeURIComponent(prompt);
    const url = `https://source.unsplash.com/1080x1080/?${query}`;
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000, maxRedirects: 10, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.data?.length > 10000) return Buffer.from(res.data);
    throw new Error('empty');
}

async function fromPexels(prompt) {
    // Pexels free API — real stock photos
    const res = await axios.get(`https://api.pexels.com/v1/search?query=${encodeURIComponent(prompt)}&per_page=15&orientation=square`, {
        timeout: 10000,
        headers: { Authorization: 'Bearer 563492ad6f91700001000001b8e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3' }
    });
    const photos = res.data?.photos;
    if (!photos?.length) throw new Error('no results');
    const pick = photos[Math.floor(Math.random() * photos.length)];
    const imgRes = await axios.get(pick.src.large, { responseType: 'arraybuffer', timeout: 15000 });
    if (imgRes.data?.length > 5000) return Buffer.from(imgRes.data);
    throw new Error('empty');
}

async function generateAny(prompt, realistic = false) {
    const models = realistic
        ? ['flux-realism', 'flux', 'turbo']
        : ['flux', 'flux-realism', 'turbo'];

    // Try Pollinations models with delay between attempts to avoid 429
    for (let i = 0; i < models.length; i++) {
        try {
            if (i > 0) await new Promise(r => setTimeout(r, 2000));
            return await fromPollinations(prompt, models[i]);
        } catch (e) {
            if (e?.response?.status === 429) await new Promise(r => setTimeout(r, 5000));
        }
    }

    // Lexica fallback
    try { return await fromLexica(prompt); } catch {}

    // Last resort — no enhance
    const seed = Math.floor(Math.random() * 9999999);
    const url  = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&nologo=true&model=flux&seed=${seed}`;
    const res  = await axios.get(url, { responseType: 'arraybuffer', timeout: 25000, maxRedirects: 10, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.data?.length > 1000) return Buffer.from(res.data);

    throw new Error('All image providers failed');
}

async function getRealPhoto(prompt) {
    // 1. Unsplash — real professional photos
    try { return await fromUnsplash(prompt); } catch {}
    // 2. Lexica — AI-generated but photorealistic
    try { return await fromLexica(prompt); } catch {}
    // 3. Pollinations flux-realism
    try { return await fromPollinations(prompt, 'flux-realism'); } catch {}
    throw new Error('No real photo found');
}

// ── Module ────────────────────────────────────────────────────────────────────

module.exports = {
    category: 'AI',
    commands: [
        { cmd: '.img',  role: 'public' },  // AI art / anime / anything
        { cmd: '.img2', role: 'public' },  // Realistic AI style
        { cmd: '.pic',  role: 'public' },  // Real photos (Unsplash/Pinterest style)
    ],

    execute: async ({ sock, msg, args, text }) => {
        const jid = msg.key.remoteJid;
        const cmd = text.split(' ')[0].toLowerCase();

        const prompt = args.join(' ').trim();
        if (!prompt) {
            const usage = {
                '.img':  '❌ Usage: `.img <description>`\nExample: `.img anime warrior with glowing sword`',
                '.img2': '❌ Usage: `.img2 <description>`\nExample: `.img2 beautiful sunset over Lagos`',
                '.pic':  '❌ Usage: `.pic <description>`\nExample: `.pic cute cat` or `.pic fashion model`'
            };
            return sock.sendMessage(jid, { text: usage[cmd] || usage['.img'] }, { quoted: msg });
        }

        const isReal = cmd === '.pic';
        const isRealistic = cmd === '.img2';

        const label = isReal ? 'real photo' : isRealistic ? 'realistic image' : 'image';
        const statusMsg = await sock.sendMessage(jid, {
            text: `🔍 _Searching for ${label}..._\n> ${prompt.slice(0, 80)}`
        }, { quoted: msg });

        try {
            await sock.sendPresenceUpdate('composing', jid).catch(() => {});
            const buffer = isReal ? await getRealPhoto(prompt) : await generateAny(prompt, isRealistic);
            await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
            await sock.sendMessage(jid, {
                image: buffer,
                caption: `🖼️ *${prompt.slice(0, 100)}*`
            }, { quoted: msg });
            logger.success(`[IMG] ${cmd} done: ${prompt.slice(0, 60)}`);
        } catch (err) {
            logger.error(`[IMG] Failed: ${err.message}`);
            await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
            await sock.sendMessage(jid, {
                text: '❌ Could not find an image. Try a different description.'
            }, { quoted: msg });
        }
    }
};
