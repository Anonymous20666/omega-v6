'use strict';
// plugins/pappy-sticker.js

const logger = require('../core/logger');
const { generateAnimatedSticker, generateAnimatedStickerFromVideo } = require('../core/stickerEngine');

module.exports = {
    category: 'MEDIA',
    commands: [
        { cmd: '.sticker', role: 'public' },
        { cmd: '.s', role: 'public' }
    ],

    execute: async ({ sock, msg, args, text }) => {
        const jid = msg.key.remoteJid;
        
        // Check for quoted image/video
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const imageMsg = msg.message?.imageMessage || quotedMsg?.imageMessage;
        const videoMsg = msg.message?.videoMessage || quotedMsg?.videoMessage;
        
        if (!imageMsg && !videoMsg) {
            return sock.sendMessage(jid, { 
                text: '❌ Reply to an image or video with .sticker or .s' 
            }, { quoted: msg });
        }
        
        try {
            const { downloadMediaMessage } = require('gifted-baileys');
            
            const processing = await sock.sendMessage(jid, { 
                text: '⏳ Creating sticker...' 
            }, { quoted: msg });
            
            let mediaBuffer;
            let stickerResult;
            if (imageMsg) {
                const imgMsg = msg.message?.imageMessage 
                    ? msg 
                    : { key: msg.key, message: quotedMsg };
                mediaBuffer = await downloadMediaMessage(imgMsg, 'buffer', {}, { 
                    logger: null, 
                    reuploadRequest: sock.updateMediaMessage 
                });
                stickerResult = await generateAnimatedSticker(mediaBuffer);
            } else {
                // For video, generate a true animated sticker from video frames.
                const vidMsg = msg.message?.videoMessage 
                    ? msg 
                    : { key: msg.key, message: quotedMsg };
                const videoBuffer = await downloadMediaMessage(vidMsg, 'buffer', {}, { 
                    logger: null, 
                    reuploadRequest: sock.updateMediaMessage 
                });
                stickerResult = await generateAnimatedStickerFromVideo(videoBuffer);
            }

            const { buffer: stickerBuffer, metadata } = stickerResult;
            const mode = metadata?.fallback === 'static' ? 'static-fallback' : 'animated';
            logger.info(`[Sticker] Sticker generated mode=${mode} size=${metadata.fileSize} bytes frames=${metadata.frameCount} duration=${metadata.duration}s`);
            
            await sock.sendMessage(jid, { 
                sticker: stickerBuffer,
                stickerMetadata: {
                    packName: 'Ω Pappy Ultimate',
                    packPublish: 'pappylung',
                    packId: 'pappy-ultimate-v5',
                    categories: ['🔥'],
                    isAvatar: false,
                    isAiSticker: true,
                }
            }, { quoted: msg });
            
            // Delete processing message
            await sock.sendMessage(jid, { delete: processing.key }).catch(() => {});
            
        } catch (err) {
            logger.error(`[Sticker] Error: ${err.message}`);
            return sock.sendMessage(jid, { 
                text: `❌ Failed to create sticker: ${err.message}` 
            }, { quoted: msg });
        }
    }
};
