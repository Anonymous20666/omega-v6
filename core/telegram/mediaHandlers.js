'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

function registerTelegramMediaHandlers(bot, deps) {
    const {
        ai,
        logger,
        rbac,
        activeSockets,
        menuSongManager,
        tgAwaitingWelcomeMedia,
        tgAwaitingMoodSticker,
        getSupportDraftView,
        getMenuSongStudioView,
        getNodeControlView,
        isTelegramGroupChat,
        isMusicDlEnabled,
        isTgAiEnabledForUser,
        getGroupProtectConfig,
        setGroupProtectConfig,
        escapeHtml,
        searchSongs,
        rememberMusicSearch,
        editStatus,
        downloadTelegramFileBuffer,
        wantsUrlFromCaption,
        sendTelegramMediaUrl,
        getAutoStickerStateForUser,
        autoStickerFromTelegramMedia,
        getGlobalAiSettings,
        addMoodSticker,
        pickMoodSticker,
        getAutoUrlStateForUser,
        uploadTelegramFileToUrl,
        coreDir,
    } = deps;

    bot.on('audio', async (ctx, next) => {
        const userId = String(ctx.from?.id || '');

        if (ctx.session?.awaitingWelcomeMedia && isTelegramGroupChat(ctx)) {
            const awaiting = ctx.session.awaitingWelcomeMedia;
            if (awaiting?.chatId === String(ctx.chat.id) && awaiting?.type === 'audio') {
                const audio = ctx.message?.audio;
                if (audio?.file_id) {
                    const cfg = getGroupProtectConfig(String(ctx.chat.id));
                    cfg.welcome.media = { type: 'audio', fileId: audio.file_id };
                    setGroupProtectConfig(String(ctx.chat.id), cfg);
                    ctx.session.awaitingWelcomeMedia = null;
                    return ctx.reply('✅ Welcome song saved for this group.', { parse_mode: 'HTML' }).catch(() => {});
                }
            }
        }

        if (isMusicDlEnabled(userId) && !ctx.session?.awaitingMenuSongUploadMode) {
            const audio = ctx.message?.audio;
            const query = String(audio?.title || audio?.file_name || audio?.performer || '').replace(/\.[a-z0-9]+$/i, '').trim();
            const caption = String(ctx.message?.caption || '').trim();
            const groupTrigger = /^(?:\/play|\.play)\s+(.+)/i.exec(caption)?.[1] || /^(?:pappy\s+play)\s+(.+)/i.exec(caption)?.[1] || '';
            const finalQuery = isTelegramGroupChat(ctx) ? String(groupTrigger || '').trim() : query;
            if (finalQuery) {
                const statusMsg = await ctx.reply(`🎵 <b>Searching for:</b> <i>${escapeHtml(finalQuery)}</i>\n\n🔍 <i>Looking up top matches...</i>`, { parse_mode: 'HTML' }).catch(() => null);
                try {
                    const { results, hasMore } = await searchSongs(finalQuery, 0);
                    if (!results.length) {
                        await editStatus(ctx, statusMsg, `❌ No results found for <b>${escapeHtml(finalQuery)}</b>`);
                        return next();
                    }
                    await editStatus(ctx, statusMsg, `🎵 <b>Pick a song:</b>`);
                    const searchToken = rememberMusicSearch(userId, finalQuery);
                    const inline_keyboard = results.map((r, i) => [{
                        text: `${i + 1}. ${r.title.slice(0, 38)} — ${r.uploader.slice(0, 18)} [${r.duration}]`,
                        callback_data: `musicpick:${/\bvideo\b/i.test(finalQuery) ? 'v:' : ''}${r.videoId}`,
                    }]);
                    if (hasMore) inline_keyboard.push([{ text: '➡️ Next', callback_data: `musicmore:${searchToken}:1` }]);
                    await ctx.reply(`🎵 <b>Results for:</b> <i>${escapeHtml(finalQuery)}</i>\n\nTap the song you want — I’ll download it + fetch lyrics:`, {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard },
                    }).catch((err) => {
                        logger.warn('[MusicDL] Failed to send audio-result keyboard', { error: err?.message || String(err) });
                    });
                    if (statusMsg?.message_id) ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
                } catch (err) {
                    logger.warn('[MusicDL] Audio search failed', { query: finalQuery, error: err.message });
                    await editStatus(ctx, statusMsg, `❌ Search failed: <code>${escapeHtml(err.message)}</code>`);
                }
                return next();
            }
        }

        const uploadMode = ctx.session?.awaitingMenuSongUploadMode;
        if (!uploadMode) return next();

        const userRole = ctx.state?.userRole || rbac.getUserRole(userId);
        if (!rbac.hasRolePermission(userRole, 'OWNER')) {
            ctx.session.awaitingMenuSongUploadMode = null;
            return ctx.reply('⚠️ Access denied. Owner only.', { parse_mode: 'HTML' }).catch(() => {});
        }

        try {
            const audio = ctx.message?.audio;
            if (!audio?.file_id) return ctx.reply('❌ No audio payload found.', { parse_mode: 'HTML' }).catch(() => {});

            const buffer = await downloadTelegramFileBuffer(ctx, audio.file_id);
            const nameFromCaption = String(ctx.message?.caption || '').trim();
            const nameFromFile = String(audio?.file_name || '').replace(/\.[a-z0-9]+$/i, '').trim();
            const finalName = nameFromCaption || nameFromFile || `Menu Song ${Date.now()}`;
            const saved = menuSongManager.addSongFromBuffer({
                buffer,
                mimeType: audio.mime_type || 'audio/mpeg',
                name: finalName,
                addedBy: userId,
                replaceActive: uploadMode === 'set',
            });

            if (uploadMode === 'add') menuSongManager.setActiveSong(saved.id);
            ctx.session.awaitingMenuSongUploadMode = null;

            const { text, reply_markup } = getMenuSongStudioView();
            return ctx.reply(`✅ Saved menu song: <b>${escapeHtml(saved.name)}</b>\n\n${text}`, { parse_mode: 'HTML', reply_markup }).catch(() => {});
        } catch (e) {
            ctx.session.awaitingMenuSongUploadMode = null;
            return ctx.reply(`❌ Failed to save song: <code>${escapeHtml(e.message)}</code>`, { parse_mode: 'HTML' }).catch(() => {});
        }
    });

    bot.on('voice', async (ctx, next) => {
        const userId = String(ctx.from?.id || '');

        const captionQuery = String(ctx.message?.caption || '').trim();
        const groupTrigger = /^(?:\/play|\.play)\s+(.+)/i.exec(captionQuery)?.[1] || /^(?:pappy\s+play)\s+(.+)/i.exec(captionQuery)?.[1] || '';
        if (isMusicDlEnabled(userId) && !ctx.session?.awaitingMenuSongUploadMode && captionQuery) {
            const finalCaptionQuery = isTelegramGroupChat(ctx) ? String(groupTrigger || '').trim() : captionQuery;
            if (finalCaptionQuery) {
                const statusMsg = await ctx.reply(`🎵 <b>Searching for:</b> <i>${escapeHtml(finalCaptionQuery)}</i>\n\n🔍 <i>Looking up top matches...</i>`, { parse_mode: 'HTML' }).catch(() => null);
                try {
                    const { results, hasMore } = await searchSongs(finalCaptionQuery, 0);
                    if (!results.length) {
                        await editStatus(ctx, statusMsg, `❌ No results for <b>${escapeHtml(finalCaptionQuery)}</b>`);
                        return next();
                    }
                    await editStatus(ctx, statusMsg, `🎵 <b>Pick a song:</b>`);
                    const searchToken = rememberMusicSearch(userId, finalCaptionQuery);
                    const inline_keyboard = results.map((r, i) => [{
                        text: `${i + 1}. ${r.title.slice(0, 38)} — ${r.uploader.slice(0, 18)} [${r.duration}]`,
                        callback_data: `musicpick:${/\bvideo\b/i.test(finalCaptionQuery) ? 'v:' : ''}${r.videoId}`,
                    }]);
                    if (hasMore) inline_keyboard.push([{ text: '➡️ Next', callback_data: `musicmore:${searchToken}:1` }]);
                    await ctx.reply(`🎵 <b>Results for:</b> <i>${escapeHtml(finalCaptionQuery)}</i>\n\nTap the song you want — I’ll download it + fetch lyrics:`, {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard },
                    }).catch((err) => {
                        logger.warn('[MusicDL] Failed to send voice-result keyboard', { error: err?.message || String(err) });
                    });
                    if (statusMsg?.message_id) ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
                } catch (err) {
                    logger.warn('[MusicDL] Voice search failed', { captionQuery: finalCaptionQuery, error: err.message });
                    await editStatus(ctx, statusMsg, `❌ Search failed: <code>${escapeHtml(err.message)}</code>`);
                }
            }
            return next();
        }

        const uploadMode = ctx.session?.awaitingMenuSongUploadMode;
        if (!uploadMode) return next();

        const userRole = ctx.state?.userRole || rbac.getUserRole(userId);
        if (!rbac.hasRolePermission(userRole, 'OWNER')) {
            ctx.session.awaitingMenuSongUploadMode = null;
            return ctx.reply('⚠️ Access denied. Owner only.', { parse_mode: 'HTML' }).catch(() => {});
        }

        try {
            const voice = ctx.message?.voice;
            if (!voice?.file_id) return ctx.reply('❌ No voice payload found.', { parse_mode: 'HTML' }).catch(() => {});

            const buffer = await downloadTelegramFileBuffer(ctx, voice.file_id);
            const nameFromCaption = String(ctx.message?.caption || '').trim();
            const finalName = nameFromCaption || `Voice Menu Song ${Date.now()}`;
            const saved = menuSongManager.addSongFromBuffer({
                buffer,
                mimeType: voice.mime_type || 'audio/ogg',
                name: finalName,
                addedBy: userId,
                replaceActive: uploadMode === 'set',
            });

            if (uploadMode === 'add') menuSongManager.setActiveSong(saved.id);
            ctx.session.awaitingMenuSongUploadMode = null;

            const { text, reply_markup } = getMenuSongStudioView();
            return ctx.reply(`✅ Saved menu song: <b>${escapeHtml(saved.name)}</b>\n\n${text}`, { parse_mode: 'HTML', reply_markup }).catch(() => {});
        } catch (e) {
            ctx.session.awaitingMenuSongUploadMode = null;
            return ctx.reply(`❌ Failed to save song: <code>${escapeHtml(e.message)}</code>`, { parse_mode: 'HTML' }).catch(() => {});
        }
    });

    bot.on('video', async (ctx, next) => {
        const _senderId = String(ctx.from?.id || '');
        const _awaiting = tgAwaitingWelcomeMedia.get(_senderId) || ctx.session?.awaitingWelcomeMedia;
        if (_awaiting?.type === 'video') {
            const video = ctx.message?.video;
            if (video?.file_id) {
                const cfg = getGroupProtectConfig(_awaiting.chatId);
                cfg.welcome.media = { type: 'video', fileId: video.file_id };
                setGroupProtectConfig(_awaiting.chatId, cfg);
                tgAwaitingWelcomeMedia.delete(_senderId);
                if (ctx.session) ctx.session.awaitingWelcomeMedia = null;
                return ctx.reply('✅ Welcome video saved for this group.', { parse_mode: 'HTML' }).catch(() => {});
            }
        }

        if (ctx.session?.supportCompose) {
            const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
            if (!photo?.file_id) return ctx.reply('❌ No photo found.', { parse_mode: 'HTML' }).catch(() => {});
            ctx.session.supportCompose = false;
            ctx.session.supportDraft = {
                text: '',
                caption: String(ctx.message?.caption || ''),
                mediaType: 'photo',
                fileId: photo.file_id,
                fileName: 'telegram-photo.jpg',
                mimeType: 'image/jpeg',
            };
            const view = getSupportDraftView(ctx.session.supportDraft);
            return ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup }).catch(() => {});
        }
        if (ctx.session?.state === 'AWAITING_WARMUP_CONTENT') return next();
        const caption = String(ctx.message?.caption || '');
        const explicitUrl = wantsUrlFromCaption(caption);
        if (explicitUrl) {
            try {
                await sendTelegramMediaUrl(ctx, 'photo');
            } catch (e) {
                await ctx.reply(`❌ Auto URL failed: ${e.message}`);
            }
            return;
        }

        const autoStickerOn = getAutoStickerStateForUser(ctx.from?.id);
        if (autoStickerOn) {
            try { await autoStickerFromTelegramMedia(ctx, 'video'); } catch (e) { await ctx.reply(`❌ Sticker creation failed: ${e.message}`); }
            return;
        }
        if (ai) {
            try {
                const caption = String(ctx.message?.caption || '');
                const userId = String(ctx.from?.id || '');
                const chatType = String(ctx.chat?.type || '');
                const isGroupChatVid = chatType === 'group' || chatType === 'supergroup';
                const groupCfgVid = isGroupChatVid ? getGroupProtectConfig(String(ctx.chat.id)) : null;
                const groupAiEnabledVid = isGroupChatVid && !!groupCfgVid?.ai?.enabled;
                const tgAiEnabledVid = isTgAiEnabledForUser(userId);
                const botUsernameVid = ctx.botInfo?.username || '';
                const isMentionedVid = botUsernameVid && caption.toLowerCase().includes(`@${botUsernameVid.toLowerCase()}`);
                const isWakePhraseVid = /\bpappy\b/i.test(caption);
                if (!(tgAiEnabledVid || isWakePhraseVid || isMentionedVid || groupAiEnabledVid)) return next();
                await ctx.sendChatAction('typing').catch(() => {});
                const replyText = caption
                    ? await ai.generateText(`The user sent a video with this caption: "${caption}". Reply naturally.`, userId, { platform: 'telegram' }).catch(() => null)
                    : await ai.generateText('The user sent a video with no caption. Acknowledge it casually and ask what it is about.', userId, { platform: 'telegram' }).catch(() => null);
                if (replyText) await ctx.reply(replyText, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
            } catch {}
        }
        return;
    });

    bot.on('sticker', async (ctx, next) => {
        const userId = String(ctx.from?.id || '');
        const sticker = ctx.message?.sticker;
        if (!sticker) return next();

        const awaitingMood = tgAwaitingMoodSticker.get(userId);
        if (awaitingMood) {
            tgAwaitingMoodSticker.delete(userId);
            const fileId = sticker.file_id;
            const count = addMoodSticker(awaitingMood, fileId);
            return ctx.reply(`✅ <b>Sticker added to "${awaitingMood}" mood!</b>\n📦 Pack now has <b>${count}</b> sticker${count !== 1 ? 's' : ''}.`, { parse_mode: 'HTML' }).catch(() => {});
        }

        if (ai) {
            try {
                const chatType = String(ctx.chat?.type || '');
                const isGroupChatStk = chatType === 'group' || chatType === 'supergroup';
                const groupCfgStk = isGroupChatStk ? getGroupProtectConfig(String(ctx.chat.id)) : null;
                const groupAiEnabledStk = isGroupChatStk && !!groupCfgStk?.ai?.enabled;
                const tgAiEnabledStk = isTgAiEnabledForUser(userId);
                if (!tgAiEnabledStk && !groupAiEnabledStk) return next();
                const emoji = sticker.emoji || '😄';
                const setName = sticker.set_name || 'unknown pack';
                const stickerType = sticker.is_animated ? 'animated sticker' : sticker.is_video ? 'video sticker' : 'sticker';
                await ctx.sendChatAction('typing').catch(() => {});
                const prompt = `The user sent a ${stickerType} with the emoji "${emoji}" (from pack: ${setName}). React naturally and casually in 1-2 sentences. You can reply with a matching emoji or brief reaction. If the mood is clearly ${emoji}, match that energy.`;
                const replyText = await ai.generateText(prompt, userId, { platform: 'telegram' }).catch(() => null);
                if (replyText) {
                    if (replyText.startsWith('MOOD_STICKER:')) {
                        const mood = replyText.slice(13).trim().toLowerCase();
                        const fileId = pickMoodSticker(mood);
                        if (fileId) {
                            await ctx.replyWithSticker(fileId, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
                            return;
                        }
                    }
                    await ctx.reply(replyText, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
                }
            } catch {}
        }
        return next();
    });

    bot.on('photo', async (ctx) => {
        const _senderId = String(ctx.from?.id || '');
        const _awaiting = tgAwaitingWelcomeMedia.get(_senderId) || ctx.session?.awaitingWelcomeMedia;
        if (_awaiting?.type === 'photo') {
            const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
            if (photo?.file_id) {
                const cfg = getGroupProtectConfig(_awaiting.chatId);
                cfg.welcome.media = { type: 'photo', fileId: photo.file_id };
                setGroupProtectConfig(_awaiting.chatId, cfg);
                tgAwaitingWelcomeMedia.delete(_senderId);
                if (ctx.session) ctx.session.awaitingWelcomeMedia = null;
                return ctx.reply('✅ Welcome photo saved for this group.', { parse_mode: 'HTML' }).catch(() => {});
            }
        }

        if (ctx.session?.supportCompose) {
            const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
            if (!photo?.file_id) return ctx.reply('❌ No photo found.', { parse_mode: 'HTML' }).catch(() => {});
            ctx.session.supportCompose = false;
            ctx.session.supportDraft = {
                text: '',
                caption: String(ctx.message?.caption || ''),
                mediaType: 'photo',
                fileId: photo.file_id,
                fileName: 'telegram-photo.jpg',
                mimeType: 'image/jpeg',
            };
            const view = getSupportDraftView(ctx.session.supportDraft);
            return ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup }).catch(() => {});
        }
        if (ctx.session?.state === 'AWAITING_WARMUP_CONTENT') return next();
        const caption = String(ctx.message?.caption || '');
        const explicitUrl = wantsUrlFromCaption(caption);
        if (explicitUrl) {
            try {
                await sendTelegramMediaUrl(ctx, 'video');
            } catch (e) {
                await ctx.reply(`❌ Auto URL failed: ${e.message}`);
            }
            return;
        }

        const autoStickerOn = getAutoStickerStateForUser(ctx.from?.id);
        if (autoStickerOn) {
            try { await autoStickerFromTelegramMedia(ctx, 'photo'); } catch (e) { await ctx.reply(`❌ Sticker creation failed: ${e.message}`); }
            return;
        }
        if (ai) {
            try {
                const photoId = ctx.message.photo?.[ctx.message.photo.length - 1]?.file_id;
                const caption = String(ctx.message?.caption || '');
                const userId = String(ctx.from?.id || '');
                const chatType = String(ctx.chat?.type || '');
                const isGroupChat = chatType === 'group' || chatType === 'supergroup';
                const groupCfgPhoto = isGroupChat ? getGroupProtectConfig(String(ctx.chat.id)) : null;
                const groupAiEnabledPhoto = isGroupChat && !!groupCfgPhoto?.ai?.enabled;
                const tgAiEnabledPhoto = isTgAiEnabledForUser(userId);
                const botUsernamePhoto = ctx.botInfo?.username || '';
                const tgBotIdPhoto = ctx.botInfo?.id;
                const isMentionedPhoto = botUsernamePhoto && caption.toLowerCase().includes(`@${botUsernamePhoto.toLowerCase()}`);
                const isReplyToBotPhoto = !!(ctx.message?.reply_to_message?.from?.id && tgBotIdPhoto && String(ctx.message.reply_to_message.from.id) === String(tgBotIdPhoto));
                const isWakePhrasePhoto = /\bpappy\b/i.test(caption);
                if (!photoId || !(tgAiEnabledPhoto || isWakePhrasePhoto || isMentionedPhoto || isReplyToBotPhoto || groupAiEnabledPhoto)) return next();
                await ctx.sendChatAction('typing').catch(() => {});
                const fileUrl = await ctx.telegram.getFileLink(photoId).catch(() => null);
                if (!fileUrl) return next();
                const res = await axios.get(fileUrl.href, { responseType: 'arraybuffer', timeout: 20000 });
                const imgBuffer = Buffer.from(res.data);
                const userRole = ctx.state?.userRole || rbac.getUserRole(userId);
                const aiVibe = getGlobalAiSettings().vibe || 'guy';
                const vibeExtra = aiVibe === 'girl' ? 'Vibe: GIRL — feminine, soft, playful.' : 'Vibe: GUY — masculine, confident, chill.';
                const prompt = caption ? `${caption}\n(respond naturally to this image + message)` : 'Describe this image and reply naturally as a friend would.';
                const description = await ai.analyzeImage(imgBuffer, prompt, userId).catch(() => null);
                if (description) {
                    await ctx.reply(description, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
                }
            } catch {}
        }
        return;
    });

    bot.on('photo', async (ctx, next) => {
        if (ctx.session?.state !== 'AWAITING_WARMUP_CONTENT') {
            const auto = getAutoUrlStateForUser(ctx.from?.id);
            if (!auto?.enabled) return;

            try {
                const fileId = ctx.message.photo?.[ctx.message.photo.length - 1]?.file_id;
                if (!fileId) return;
                const url = await uploadTelegramFileToUrl(ctx, fileId, 'telegram-image.jpg', 'image/jpeg');
                await ctx.reply(`🔗 <b>Image URL</b>\n<code>${url}</code>`, { parse_mode: 'HTML' });
            } catch (e) {
                await ctx.reply(`❌ Auto URL failed: ${e.message}`);
            }
            return;
        }
        const sessionKey = ctx.session.warmupNode;
        ctx.session.state = 'IDLE';
        ctx.session.warmupNode = null;
        const phone = sessionKey?.split('_')[1] || sessionKey;
        try {
            const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            const fileUrl = await ctx.telegram.getFileLink(fileId);
            const res = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
            const mediaPath = path.join(coreDir, `../data/warmup-media-${phone}.jpg`);
            fs.writeFileSync(mediaPath, Buffer.from(res.data));
            const caption = ctx.message.caption || '';
            const cfgPath = path.join(coreDir, `../data/warmup-config-${phone}.json`);
            const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
            cfg.statusPayload = caption;
            cfg.mediaType = 'image';
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
            const confirmMsg = await ctx.reply(`✅ <b>Saved!</b> Image entry drop set for +${phone}.`, { parse_mode: 'HTML' });
            setTimeout(async () => {
                await ctx.telegram.deleteMessage(ctx.chat.id, confirmMsg.message_id).catch(() => {});
                const sock = activeSockets.get(sessionKey);
                const panel = getNodeControlView(sessionKey, String(ctx.from?.id || ''));
                ctx.reply(panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup }).catch(() => {});
            }, 1500);
        } catch (e) { ctx.reply(`❌ Failed: ${e.message}`); }
    });

    bot.on('video', async (ctx) => {
        if (ctx.session?.state !== 'AWAITING_WARMUP_CONTENT') {
            const auto = getAutoUrlStateForUser(ctx.from?.id);
            if (!auto?.enabled) return;

            try {
                const fileId = ctx.message.video?.file_id;
                if (!fileId) return;
                const url = await uploadTelegramFileToUrl(ctx, fileId, 'telegram-video.mp4', 'video/mp4');
                await ctx.reply(`🔗 <b>Video URL</b>\n<code>${url}</code>`, { parse_mode: 'HTML' });
            } catch (e) {
                await ctx.reply(`❌ Auto URL failed: ${e.message}`);
            }
            return;
        }
        const sessionKey = ctx.session.warmupNode;
        ctx.session.state = 'IDLE';
        ctx.session.warmupNode = null;
        const phone = sessionKey?.split('_')[1] || sessionKey;
        try {
            const fileId = ctx.message.video.file_id;
            const fileUrl = await ctx.telegram.getFileLink(fileId);
            const res = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
            const mediaPath = path.join(coreDir, `../data/warmup-media-${phone}.mp4`);
            fs.writeFileSync(mediaPath, Buffer.from(res.data));
            const caption = ctx.message.caption || '';
            const cfgPath = path.join(coreDir, `../data/warmup-config-${phone}.json`);
            const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
            cfg.statusPayload = caption;
            cfg.mediaType = 'video';
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
            const confirmMsg = await ctx.reply(`✅ <b>Saved!</b> Video entry drop set for +${phone}.`, { parse_mode: 'HTML' });
            setTimeout(async () => {
                await ctx.telegram.deleteMessage(ctx.chat.id, confirmMsg.message_id).catch(() => {});
                const sock = activeSockets.get(sessionKey);
                const panel = getNodeControlView(sessionKey, String(ctx.from?.id || ''));
                ctx.reply(panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup }).catch(() => {});
            }, 1500);
        } catch (e) { ctx.reply(`❌ Failed: ${e.message}`); }
    });

    bot.on('document', async (ctx) => {
        const _docSenderId = String(ctx.from?.id || '');
        const _docAwaiting = tgAwaitingWelcomeMedia.get(_docSenderId) || ctx.session?.awaitingWelcomeMedia;
        if (_docAwaiting?.type === 'audio') {
            const doc = ctx.message?.document;
            const mimeType = String(doc?.mime_type || '').toLowerCase();
            if (doc?.file_id && mimeType.startsWith('audio/')) {
                const cfg = getGroupProtectConfig(_docAwaiting.chatId);
                cfg.welcome.media = { type: 'audio', fileId: doc.file_id };
                setGroupProtectConfig(_docAwaiting.chatId, cfg);
                tgAwaitingWelcomeMedia.delete(_docSenderId);
                if (ctx.session) ctx.session.awaitingWelcomeMedia = null;
                return ctx.reply('✅ Welcome song saved from audio file.', { parse_mode: 'HTML' }).catch(() => {});
            }
        }

        const uploadMode = ctx.session?.awaitingMenuSongUploadMode;
        if (uploadMode) {
            const userId = String(ctx.from?.id || '');
            const userRole = ctx.state?.userRole || rbac.getUserRole(userId);
            if (!rbac.hasRolePermission(userRole, 'OWNER')) {
                ctx.session.awaitingMenuSongUploadMode = null;
                return ctx.reply('⚠️ Access denied. Owner only.', { parse_mode: 'HTML' }).catch(() => {});
            }

            const doc = ctx.message?.document;
            const mimeType = String(doc?.mime_type || '').toLowerCase();
            if (!doc?.file_id || !mimeType.startsWith('audio/')) {
                return ctx.reply('❌ Send an audio document (mp3/m4a/ogg/wav) while setting menu song.', { parse_mode: 'HTML' }).catch(() => {});
            }

            try {
                const buffer = await downloadTelegramFileBuffer(ctx, doc.file_id);
                const nameFromCaption = String(ctx.message?.caption || '').trim();
                const nameFromFile = String(doc.file_name || '').replace(/\.[a-z0-9]+$/i, '').trim();
                const finalName = nameFromCaption || nameFromFile || `Menu Song ${Date.now()}`;
                const saved = menuSongManager.addSongFromBuffer({
                    buffer,
                    mimeType: doc.mime_type || 'audio/mpeg',
                    name: finalName,
                    addedBy: userId,
                    replaceActive: uploadMode === 'set',
                });

                if (uploadMode === 'add') menuSongManager.setActiveSong(saved.id);
                ctx.session.awaitingMenuSongUploadMode = null;
                const { text, reply_markup } = getMenuSongStudioView();
                return ctx.reply(`✅ Saved menu song: <b>${escapeHtml(saved.name)}</b>\n\n${text}`, { parse_mode: 'HTML', reply_markup }).catch(() => {});
            } catch (e) {
                ctx.session.awaitingMenuSongUploadMode = null;
                return ctx.reply(`❌ Failed to save song: <code>${escapeHtml(e.message)}</code>`, { parse_mode: 'HTML' }).catch(() => {});
            }
        }

        if (ctx.session?.supportCompose) {
            const doc = ctx.message.document;
            if (!doc?.file_id) return ctx.reply('❌ No file found.', { parse_mode: 'HTML' }).catch(() => {});
            ctx.session.supportCompose = false;
            ctx.session.supportDraft = {
                text: '',
                caption: String(ctx.message?.caption || ''),
                mediaType: 'document',
                fileId: doc.file_id,
                fileName: doc.file_name || 'telegram-file',
                mimeType: doc.mime_type || 'application/octet-stream',
            };
            const view = getSupportDraftView(ctx.session.supportDraft);
            return ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup }).catch(() => {});
        }
        const auto = getAutoUrlStateForUser(ctx.from?.id);
        if (!auto?.enabled) return;
        if (ctx.session?.state === 'AWAITING_WARMUP_CONTENT') return;

        try {
            const doc = ctx.message.document;
            if (!doc?.file_id) return;
            const safeName = doc.file_name || 'telegram-file.bin';
            const mimeType = doc.mime_type || 'application/octet-stream';
            const url = await uploadTelegramFileToUrl(ctx, doc.file_id, safeName, mimeType);
            await ctx.reply(`🔗 <b>File URL</b>\n<code>${url}</code>`, { parse_mode: 'HTML' });
        } catch (e) {
            await ctx.reply(`❌ Auto URL failed: ${e.message}`);
        }
    });
}

module.exports = { registerTelegramMediaHandlers };
