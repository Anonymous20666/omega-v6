// plugins/pappy-nexus.js
// 🎯 NEXUS SNIPER PROTOCOL: Invisible Contextual Targeting

const taskManager = require('../core/taskManager');
const stealth = require('../core/stealthEngine');
const logger = require('../core/logger');

module.exports = {
    category: 'GROWTH_ENGINE',
    commands: [
        { cmd: '.nexus', role: 'owner' } 
        // Usage: .nexus [groupJid] [Spintax Payload using {group} as a placeholder]
        // Example: .nexus 1234@g.us Hey! Saw you in {group}. Quick question...
    ],

    execute: async (sock, msg, args, userProfile, cmd, abortSignal) => {
        const chat = msg.key.remoteJid;
        const botId = sock.user?.id?.split(':')[0];
        
        const targetGroup = args.shift();
        const rawText = args.join(' ') || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation;

        if (!targetGroup || !targetGroup.endsWith('@g.us') || !rawText) {
            return sock.sendMessage(chat, { text: '❌ *SYNTAX:* .nexus [groupJid] [Payload with {group}]\n\n💡 *Tip:* Use `{group}` in your text to magically insert the group name so it looks like a real human from the chat.' });
        }

        await sock.sendMessage(chat, { text: `🔥 *NEXUS SNIPER INITIATED*\nInfiltrating sector: ${targetGroup}...` });

        try {
            // 1. Extract Group Metadata invisibly
            const meta = await require('../core/groupCache').getGroupMeta(sock, targetGroup);
            const groupName = meta.subject || "the group"; 
            
            // 2. Filter out the bot itself and the Group Admins (never DM strict admins!)
            const targetJids = meta.participants
                .filter(p => !p.id.includes(botId) && !p.admin)
                .map(p => p.id);

            if (targetJids.length === 0) return sock.sendMessage(chat, { text: '❌ No safe targets found. (Only admins exist in this sector).' });

            await sock.sendMessage(chat, { text: `🎯 Extracted ${targetJids.length} safe targets.\n🛡️ Admins were automatically excluded to prevent detection.\n\nEngaging Stealth DMs. This will take hours.` });

            let success = 0;
            let failed = 0;

            // 3. Queue the Sniper Shots with extreme jitter
            for (let i = 0; i < targetJids.length; i++) {
                const targetJid = targetJids[i];
                const taskId = `NEXUS_${botId}_${targetJid}`;

                taskManager.submit(taskId, async (jobSignal) => {
                    if (jobSignal.aborted) throw new Error('AbortError');
                    
                    // Inject the localized Group Name into the Spintax
                    const contextualText = rawText.replace(/\{group\}/gi, groupName);
                    
                    // Mutate the final Spintax so no two messages are identical
                    const mutatedText = stealth.mutateMessage(contextualText);

                    // Emulate human typing speed tailored to the mutated message length
                    await stealth.simulateHumanInteraction(sock, targetJid, mutatedText, jobSignal);
                    
                    // Execute the silent strike
                    await sock.sendMessage(targetJid, { text: mutatedText });
                    success++;

                }, { 
                    priority: 1, 
                    timeout: 45000, 
                    retries: 0, 
                    // 🛡️ EXTREME ANTI-BAN JITTER: Wait 25 to 75 seconds between every single DM
                    jitter: [25000, 75000] 
                }).catch(() => { failed++; });
            }

            // Monitor background progress
            const monitor = setInterval(() => {
                if (success + failed >= targetJids.length) {
                    clearInterval(monitor);
                    sock.sendMessage(chat, { text: `🏁 *NEXUS SNIPER COMPLETE*\n\n✅ Delivered: ${success}\n❌ Failed: ${failed}` });
                }
            }, 60000); 

        } catch (err) {
            logger.error('Nexus extraction failed:', err);
            sock.sendMessage(chat, { text: `⚠️ Core failure: ${err.message}` });
        }
    }
};
