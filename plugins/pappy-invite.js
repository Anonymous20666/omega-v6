// plugins/pappy-invite.js
// 🌸 Cinematic Invite Generator (60+ Soft Life & Kaomoji Templates - SaaS Edition)

const axios = require('axios');
const logger = require('../core/logger');
const { buildLinkPreview, fetchImageBuffer } = require('../core/linkPreview'); 

const FALLBACK_THUMB_URL = 'https://upload.wikimedia.org/wikipedia/commons/5/5e/WhatsApp_icon.png';

function extractQuotedPreviewContext(msg) {
    const primaryCtx = msg?.message?.extendedTextMessage?.contextInfo || null;
    const quotedMsg = primaryCtx?.quotedMessage || {};

    const candidates = [
        quotedMsg?.extendedTextMessage?.contextInfo,
        quotedMsg?.imageMessage?.contextInfo,
        quotedMsg?.videoMessage?.contextInfo,
        primaryCtx,
    ];

    return candidates.find((ctx) => !!ctx?.externalAdReply) || null;
}

// 🎨 60+ SOFT LIFE & KAWAII ASCII AESTHETICS
const inviteAesthetics = [
    // --- SOFT & COZY ---
    (n, s, o, d, c) => `(づ｡◕‿‿◕｡)づ 💕\n\ncome join *${n}* ✨\nit’s giving soft life 🌸\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `ʕ•ᴥ•ʔ 🍯\n\nsweetest spot on your dash 🧸\nmeet ${s} cuties in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(✿◠‿◠) 🍵\n\npure aesthetics & good vibes\nstep into *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ˘ ³˘)♥︎ 💅\n\nmain character energy only\njoin *${n}* 🎀\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧\n\nvibe check passed ✅\nwe're ${s} deep in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(灬º‿º灬)♡ 🍓\n\nyour new digital home~\ncome to *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(o˘◡˘o) ☁️\n\nhead in the clouds\nchilling in *${n}* ✨\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(◕‿◕✿) 🌷\n\ngrowing our little garden\n*${n}* is waiting for u~\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(,,>﹏<,,) 🎧\n\nplaylist on, world off\nvibing in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(ꈍᴗꈍ) 🌙\n\nsleepy soft vibes\ngoodnight from *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,

    // --- SPARKLY & ANGELIC ---
    (n, s, o, d, c) => `ଘ(੭ˊᵕˋ)੭* ੈ✩‧₊˚\n\nangel energy activated 🕊️\njoin *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(✧ω✧) 💎\n\nflawless aesthetics\n${s} icons in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(*¯︶¯*) ✨\n\nliving our best lives\nwelcome to *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(☆▽☆) 🥂\n\ncheers to the good times\n*${n}* is popping off\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(✯◡✯) 🌌\n\nstarry skies & late nights\nenter *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ´ ▽ \` ).｡ｏ♡\n\ndreaming out loud\njoin the vibe in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(o^▽^o) 🦋\n\nbutterfly effect\nflutter into *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(≧◡≦) 🤍\n\npure intentions only\nwe are *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(◕ᴗ◕✿) 💫\n\nmanifesting greatness\njoin ${s} souls in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ◡‿◡ ) 🦢\n\nelegant & unbothered\nstep inside *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,

    // --- Y2K & TEXTING ---
    (n, s, o, d, c) => `(¬‿¬) 📱\n\nu up?\nwe're active in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(⌐■_■) 💽\n\ny2k digital dreams\nloading *${n}*...\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(≧ω≦) 🎮\n\nplayer 1 ready\nlevel up in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ˘▽˘)っ♨️\n\nspilling the tea\nexclusive in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(☞ﾟヮﾟ)☞ 💸\n\ngetting this digital bag\n${s} bosses in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(•◡•) / 🧃\n\nsipping juice, taking names\nchill with *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ͡° ͜ʖ ͡°) 📸\n\ncapturing moments\nfront row at *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(>‿◠)✌️ 💖\n\npeace, love, and wifi\nbroadcasting from *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ‾́ ◡ ‾́ ) 💿\n\nnostalgia on repeat\npress play on *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(O_O) 🍿\n\nthe drama is unmatched\nwatching *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,

    // --- DREAMY & ETHEREAL ---
    (n, s, o, d, c) => `( ╥﹏╥) 🌧️\n\npluviophile aesthetics\nfinding shelter in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ᵘ ᵕ ᵘ ⁎) 🎐\n\nwind chimes & gentle breezes\nrelax in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ᴜ ω ᴜ ) 🕸️\n\nsoft grunge diaries\n${s} ghosts in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ´-ω･)︻┻┳══━一 💔\n\ncupid's arrow strikes\nfalling for *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ˶ˆ꒳ˆ˵ ) 🕯️\n\nmidnight confessions\nsecrets of *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ｡ •̀ ᴖ •́ ｡) 🥀\n\nbeautifully chaotic\ngetting lost in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ⊃・ω・)⊃ 🔮\n\npredicting good energy\nyour future is in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( • ̀ω•́ )✧ 🗝️\n\nunlocking the vault\nexclusive entry to *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( > 〰 < ) 🖤\n\ndark academia vibes\nstudying *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ╯°□°)╯ 🍷\n\ncheers to the elite\n${s} icons in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,

    // --- CUTE & PLAYFUL ---
    (n, s, o, d, c) => `૮₍ ˶•⤙•˶ ₎ა 🍰\n\nsnack time & group chats\nfeasting in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ˶°ㅁ°) !! 🎀\n\nomg you haven't joined yet?\nrun to *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(๑>ᴗ<๑) 🎡\n\nlife is a theme park\nenjoy the ride in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( •ᴗ•)🪄 🐇\n\npulling magic out the hat\nwelcome to *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ˘▽˘)っ♨️ 🍜\n\nlate night ramen runs\nchatting in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ˙꒳˙ ) 💌\n\nyou've got a secret invite\nopen *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(„• ֊ •„) 🎈\n\nfloating away with the vibes\njoin ${s} cuties in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(๑•͈ᴗ•͈) 🎨\n\npainting our own world\ncolor outside the lines in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ˶ˆ ᗜ ˆ˵ ) 🌴\n\ndigital vacation mode\nrelaxing in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(つ✧ω✧)つ 🛒\n\nwindow shopping for vibes\nadd *${n}* to cart\n\n🔗 https://chat.whatsapp.com/${c}`,
    
    // --- EXTRA NEW ADDITIONS ---
    (n, s, o, d, c) => `(❁´◡\`❁) 🍑\n\npeachy clean vibes\njoin ${s} others in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ˶ˆ꒳ˆ˵ ) 🧁\n\nsweetest escape\nstep into *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ᵘ ᵕ ᵘ ⁎) 🎀\n\ntied with a bow\nyour invite to *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `(˶˃ ᵕ ˂˶) .ᐟ.ᐟ\n\nbig mood today\nwe are *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ๑ ˃̵ᴗ˂̵)و ♡\n\nwinning at life\ncelebrate in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`,
    (n, s, o, d, c) => `( ´ ∀ \` )ﾉ 🌻\n\nsunshine and good days\nbrighten up in *${n}*\n\n🔗 https://chat.whatsapp.com/${c}`
];

module.exports = {
    category: 'AESTHETIC',
    commands: [
        { cmd: '.invitecard', role: 'public' },
        { cmd: '.gclink', role: 'admin' },
        { cmd: '.jidlink', role: 'admin' },
        { cmd: '.join', role: 'owner' }
    ], 
    
    // 🧠 SaaS Fix: Updated signature to match the object destructuring in our Command Router
    execute: async ({ sock, msg, args, text }) => {
        const jid = msg.key.remoteJid;
        const cmd = String(text || '').trim().split(/\s+/)[0].toLowerCase();

        if (cmd === '.join') {
            const input = String(args[0] || '').trim();
            if (!input) {
                return sock.sendMessage(jid, {
                    text: '❌ *Usage:*\n• `.join https://chat.whatsapp.com/XXXXXX` — join via link\n• `.join XXXXXX` — join via code\n• `.join 120xxxxxxxx@g.us` — join via group JID'
                }, { quoted: msg });
            }

            // Join via group JID directly (add self)
            if (input.endsWith('@g.us')) {
                try {
                    await sock.groupParticipantsUpdate(input, [`${sock.user.id.split(':')[0]}@s.whatsapp.net`], 'add');
                    return sock.sendMessage(jid, { text: `✅ Joined group: ${input}` }, { quoted: msg });
                } catch (e) {
                    return sock.sendMessage(jid, { text: `❌ Failed to join via JID: ${e.message}` }, { quoted: msg });
                }
            }

            // Extract invite code from link or raw code
            const codeMatch = input.match(/chat\.whatsapp\.com\/([A-Za-z0-9]{20,24})/i) || input.match(/^([A-Za-z0-9]{20,24})$/);
            if (!codeMatch) {
                return sock.sendMessage(jid, { text: '❌ Invalid invite link, code, or JID.' }, { quoted: msg });
            }
            const code = codeMatch[1];

            // Try direct join first; if group requires approval, send a join request
            try {
                await sock.groupAcceptInvite(code);
                return sock.sendMessage(jid, { text: `✅ Successfully joined the group!` }, { quoted: msg });
            } catch (e) {
                // If rejected due to approval requirement, attempt request-to-join via V4
                if (/approval|request|admin/i.test(e.message)) {
                    try {
                        const groupInfo = await sock.groupGetInviteInfo(code);
                        if (groupInfo?.id) {
                            await sock.groupAcceptInviteV4(
                                sock.user.id,
                                { groupJid: groupInfo.id, inviteCode: code, inviteExpiration: groupInfo.inviteExpiration || 0 }
                            );
                            return sock.sendMessage(jid, { text: `📨 Join request sent to *${groupInfo.subject || groupInfo.id}*!\nWaiting for admin approval.` }, { quoted: msg });
                        }
                    } catch (e2) {
                        return sock.sendMessage(jid, { text: `❌ Failed to send join request: ${e2.message}` }, { quoted: msg });
                    }
                }
                return sock.sendMessage(jid, { text: `❌ Failed to join: ${e.message}` }, { quoted: msg });
            }
        }

        if (cmd === '.gclink' || cmd === '.jidlink') {
            const targetJid = String(args[0] || '').trim() || (jid.endsWith('@g.us') ? jid : '');
            if (!targetJid || !targetJid.endsWith('@g.us')) {
                return sock.sendMessage(jid, {
                    text: '❌ *Usage:* `.gclink 120xxxxxxxxxxxx@g.us`\nTip: run `.gclink` inside a group to extract that group link.'
                });
            }

            try {
                const code = await sock.groupInviteCode(targetJid);
                const fullLink = `https://chat.whatsapp.com/${code}`;
                const { generateWAMessageFromContent } = require('gifted-baileys');
                // Build as extendedTextMessage so WA renders the full native invite card
                const builtMsg = generateWAMessageFromContent(jid, {
                    extendedTextMessage: {
                        text: `✅ *GC Invite Link*\n\n🆔 ${targetJid}\n🔗 ${fullLink}`,
                        matchedText: fullLink,
                        canonicalUrl: fullLink,
                        previewType: 0,
                    }
                }, { userJid: sock.user.id });
                return sock.relayMessage(jid, builtMsg.message, { messageId: builtMsg.key.id });
            } catch (e) {
                return sock.sendMessage(jid, {
                    text: `❌ Failed to extract link for ${targetJid}.\nReason: ${e.message}`
                });
            }
        }
        
        const quotedText = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
                           msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text || '';
        const input = args.join(' ') || quotedText;

        // Silently delete the user's trigger message to keep the chat clean
        await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});

        const linkMatch = input.match(/chat\.whatsapp\.com\/([A-Za-z0-9]{20,24})/i);
        if (!linkMatch) return sock.sendMessage(jid, { text: '❌ *Invalid Link!*\nUsage: `.invitecard https://chat.whatsapp.com/...` or reply to a link.' });

        const inviteCode = linkMatch[1];
        const fullLink = `https://chat.whatsapp.com/${inviteCode}`;

        // If user REPLIED to a message that has a loaded preview — use its preview data but wrap with aesthetic
        const quotedMsgObj = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quotedMsgObj?.extendedTextMessage?.matchedText || quotedMsgObj?.extendedTextMessage?.contextInfo?.externalAdReply) {
            const ext = quotedMsgObj.extendedTextMessage;
            const groupName = ext.title || 'Group';
            const desc = ext.description || '';
            const memberCount = 'Unknown';
            const creator = 'Hidden';
            const randomStyle = inviteAesthetics[Math.floor(Math.random() * inviteAesthetics.length)];
            const aestheticCaption = randomStyle(groupName, memberCount, creator, desc, inviteCode);
            const { generateWAMessageFromContent } = require('gifted-baileys');
            const builtMsg = generateWAMessageFromContent(jid, {
                extendedTextMessage: {
                    ...ext,
                    text: `${aestheticCaption}`,
                }
            }, { userJid: sock.user.id });
            return sock.relayMessage(jid, builtMsg.message, { messageId: builtMsg.key.id });
        }
        
        // 🧠 SaaS Fix: Capture the "Scanning" message so we can delete it later for a cleaner UI!
        let scanMsg;
        try {
            scanMsg = await sock.sendMessage(jid, { text: '🔍 _Scanning group metadata & generating elite preview..._' });
        } catch(e) {}

        try {
            // 1. Fetch live group info from WhatsApp servers
            const groupInfo = await sock.groupGetInviteInfo(inviteCode).catch(() => null);

            // 2. Generate our ultra-premium Link Preview Card
            const preview = await buildLinkPreview(fullLink);

            const groupName = groupInfo?.subject || preview?.externalAdReply?.title || 'Unknown Sector';
            const memberCount = groupInfo?.size || 'Unknown';
            const creator = groupInfo?.owner ? `+${groupInfo.owner.split('@')[0]}` : 'Hidden';
            const desc = groupInfo?.desc || preview?.externalAdReply?.body || 'No description provided.';

            // 3. Try to grab the group's profile picture URL (not buffer)
            let pfpUrl = null;
            if (groupInfo) {
                try {
                    pfpUrl = await sock.profilePictureUrl(groupInfo.id, 'image');
                } catch (e) {
                    logger.warn(`[InviteCard] Failed to fetch PFP URL for ${groupName}`);
                }
            }

            // 4. Build aesthetic fallback caption (only used when native invite message fails)
            const randomStyle = inviteAesthetics[Math.floor(Math.random() * inviteAesthetics.length)];
            const aestheticCaption = randomStyle(groupName, memberCount, creator, desc, inviteCode);

            // 5. Construct the PERFECT Ad Reply
            let adReply = preview?.externalAdReply ? preview.externalAdReply : {
                title: groupName,
                body: `Join ${memberCount} members`,
                mediaType: 1,
                sourceUrl: fullLink,
                renderLargerThumbnail: true,
                showAdAttribution: true
            };

            // Enforce a complete ad-reply payload so WhatsApp renders a full clickable card.
            adReply.sourceUrl = fullLink;
            adReply.mediaType = 1;
            adReply.renderLargerThumbnail = true;
            adReply.showAdAttribution = true;

            // Prefer both URL + buffer thumbnail for best card reliability across clients.
            if (pfpUrl) {
                adReply.thumbnailUrl = pfpUrl;
                const pfpBuffer = await fetchImageBuffer(pfpUrl).catch(() => null);
                if (pfpBuffer) adReply.jpegThumbnail = pfpBuffer;
            }

            // Hard fallback: always provide a thumbnail URL/Buffer so clients render the card.
            if (!adReply.thumbnailUrl) adReply.thumbnailUrl = FALLBACK_THUMB_URL;
            if (!adReply.jpegThumbnail) {
                const fallbackBuf = await fetchImageBuffer(adReply.thumbnailUrl).catch(() => null);
                if (fallbackBuf) adReply.jpegThumbnail = fallbackBuf;
            }

            // 6. Delete the "Scanning..." message
            if (scanMsg && scanMsg.key) {
                await sock.sendMessage(jid, { delete: scanMsg.key }).catch(() => {});
            }

            // 7. Send as extendedTextMessage like .tag — no externalAdReply to avoid "message via ad"
            const { generateWAMessageFromContent } = require('gifted-baileys');
            const builtMsg = generateWAMessageFromContent(jid, {
                extendedTextMessage: {
                    text: `${aestheticCaption}`,
                    matchedText: fullLink,
                    canonicalUrl: fullLink,
                    title: groupName,
                    description: desc,
                    previewType: 0,
                    ...(adReply.jpegThumbnail ? { jpegThumbnail: adReply.jpegThumbnail } : {}),
                }
            }, { userJid: sock.user.id });
            return sock.relayMessage(jid, builtMsg.message, { messageId: builtMsg.key.id });

        } catch (error) {
            logger.error(`[InviteCard] Error: ${error.message}`);
            if (scanMsg && scanMsg.key) await sock.sendMessage(jid, { delete: scanMsg.key }).catch(() => {});
            return sock.sendMessage(jid, { text: '❌ *Failed to generate card.*\nThe link might be revoked or invalid.' });
        }
    }
};
