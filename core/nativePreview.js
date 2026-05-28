// core/nativePreview.js
// 👑 TRUE NATIVE INJECTION (SMART ROUTING ENGINE)

const axios = require('axios');
const { getLinkPreview } = require('link-preview-js');
const logger = require('./logger');

async function fetchThumb(url) {
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
        return Buffer.from(res.data);
    } catch (e) { return null; }
}

async function sendNativePreview(sock, jid, text, options = {}, isStatus = false, statusConfig = {}) {
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return false;
    
    const url = urlMatch[0];
    const isWALink = url.includes('chat.whatsapp.com');

    // ────────────────────────────────────────────────────────
    // 👑 1. WHATSAPP GROUP INVITE (For Chats & Groups Only)
    // ────────────────────────────────────────────────────────
    // WhatsApp restricts 'groupInviteMessage' from the Status Tab.
    if (isWALink && !isStatus) {
        const inviteCodeMatch = url.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
        if (inviteCodeMatch) {
            try {
                const groupInfo = await sock.groupGetInviteInfo(inviteCodeMatch[1]);
                let thumbBuffer = null;
                try {
                    const ppUrl = await sock.profilePictureUrl(groupInfo.id, 'image');
                    if (ppUrl) thumbBuffer = await fetchThumb(ppUrl);
                } catch (e) {}
                
                if (!thumbBuffer) thumbBuffer = await fetchThumb("https://i.imgur.com/4ZQZ4ZQ.jpeg");

                // Direct Protobuf Object Delivery
                await sock.sendMessage(jid, {
                    groupInvite: {
                        groupJid: groupInfo.id,
                        inviteCode: inviteCodeMatch[1],
                        inviteExpiration: 0,
                        groupName: groupInfo.subject || "WhatsApp Group",
                        jpegThumbnail: thumbBuffer,
                        caption: text
                    }
                }, options);
                
                return true; 
            } catch (e) {
                logger.warn(`[NativePreview] Group Invite failed: ${e.message}`);
                // If it fails (e.g., link revoked), gracefully fall down to Standard Preview
            }
        }
    }

    // ────────────────────────────────────────────────────────
    // 🚀 2. STANDARD NATIVE PREVIEW (For Statuses & Other Links)
    // ────────────────────────────────────────────────────────
    let preview;
    try {
        preview = await getLinkPreview(url, { timeout: 5000, followRedirects: 'follow' });
    } catch {
        if (isWALink) {
            // Failsafe metadata for WA links
            preview = { 
                title: "WhatsApp Group Invite", 
                description: "Tap to view the group", 
                images: ["https://i.imgur.com/4ZQZ4ZQ.jpeg"] 
            };
        } else {
            return false;
        }
    }

    const thumbUrl = preview.images?.[0] || preview.favicons?.[0];
    const jpegThumbnail = thumbUrl ? await fetchThumb(thumbUrl) : null;

    // We spread the exact Protobuf keys into standard text payload.
    // Baileys is smart enough to map these directly into the extendedTextMessage!
    let payload = {
        text: text,
        matchedText: url,
        canonicalUrl: url,
        title: preview.title || '',
        description: preview.description || '',
        jpegThumbnail: jpegThumbnail || undefined,
        previewType: 0
    };

    // 🎨 INJECT STATUS STYLING
    if (isStatus) {
        const hexColor = (statusConfig.backgroundColor || '#FFB7C5').replace('#', '');
        // Baileys maps 'backgroundArgb' to the protobuf for extendedTextMessage backgrounds
        payload.backgroundArgb = parseInt('FF' + hexColor, 16) | 0; 
        payload.font = statusConfig.font !== undefined ? statusConfig.font : 3;
    }

    try {
        // Guaranteed Delivery: Keeps Encryption & Applies statusJidList
        await sock.sendMessage(jid, payload, options);
        return true;
    } catch (err) {
        logger.error(`[NativePreview] Send failed: ${err.message}`);
        return false;
    }
}

module.exports = { sendNativePreview };
