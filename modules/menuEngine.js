// modules/menuEngine.js


const fs = require('fs');
const path = require('path');

// 20+ GenZ/ASCII menu templates, all with placeholders for user/status/commands
const MENU_TEMPLATES = [
    // 1
    `┊ ┊ ┊ ┊ ✦\n┊ ┊ ┊ 🍥  𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏\n┊ ┊ ☁️  your daily assistant\n┊ 🌸\n🍓\n\n╭─〔 🎧 status 〕\n│ ◦ user : %name\n│ ◦ exp  : %level\n│ ◦ mode : %mode\n╰─────────────\n\n╭─〔 💌 commands 〕\n%commands\n╰─────────────\n\n╭─〔 🌈 vibes 〕\n│ “stay pretty, stay coding 💻✨”\n│ “lowkey a genius fr”\n╰─────────────`,
    // 2
    `╭━━━〔 ✦ 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 ✦ 〕━━━╮\n┃  (｡•̀ᴗ-)✧  hey there, bestie!\n┃  welcome to the future ✨\n┃\n┃  👤 user  : %name\n┃  🌍 mode  : %mode\n┃  ⚡ speed : %ping ms\n┃  🧠 ai    : online\n┃\n┣━━━〔 🍓 main cmds 〕━━━┫\n%commands\n╰━━━〔 ☁️ stay soft 〕━━━╯\n      ✧ *don’t stress, just vibe* ✧\n            ⌗ powered by pappy.exe`,
    // 3
    `╔═✦═╗\n║ 🍥 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 ║\n╚═✦═╝\n✧ user: %name\n✧ mode: %mode\n✧ exp : %level\n\n✦ Commands ✦\n%commands\n\n✦ “code, chill, repeat” ✦`,
    // 4
    `🌸 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 🌸\n───────────────\nuser: %name\nmode: %mode\nlevel: %level\n───────────────\n%commands\n───────────────\n“vibe check: passed”`,
    // 5
    `╭─〔 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 〕─╮\n│ user : %name\n│ mode : %mode\n│ exp  : %level\n╰──────────────╯\n\n〔 Commands 〕\n%commands\n\n〔 Vibes 〕\n“genz energy only”`,
    // 6
    `✦ 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 ✦\n┏━━━━━━━━━━━━┓\n┃ user : %name\n┃ mode : %mode\n┃ exp  : %level\n┗━━━━━━━━━━━━┛\n\n〔 Commands 〕\n%commands\n\n〔 Stay soft 〕\n“don’t stress, just vibe”`,
    // 7
    `╭━━✦ 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 ✦━━╮\n┃ user : %name\n┃ mode : %mode\n┃ exp  : %level\n┣━━━━ Commands ━━━━┫\n%commands\n╰━━━━━━━━━━━━━━━━━╯\n“keep it cute, keep it smart”`,
    // 8
    `🍓 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 🍓\n╭──────────────╮\n│ user : %name\n│ mode : %mode\n│ exp  : %level\n╰──────────────╯\n〔 Commands 〕\n%commands\n〔 Vibes 〕\n“slay the day”`,
    // 9
    `╔═══✦═══╗\n║ 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 ║\n╚═══✦═══╝\nuser : %name\nmode : %mode\nexp  : %level\n\n〔 Commands 〕\n%commands\n\n“main character energy”`,
    // 10
    `✧･ﾟ: *✧･ﾟ:*\n𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏\n*:･ﾟ✧*:･ﾟ✧\nuser : %name\nmode : %mode\nexp  : %level\n\n〔 Commands 〕\n%commands\n\n“just code things”`,
    // 11
    `╭─〔 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 〕─╮\n│ user : %name\n│ mode : %mode\n│ exp  : %level\n╰──────────────╯\n〔 Commands 〕\n%commands\n〔 Vibes 〕\n“eat, sleep, code, repeat”`,
    // 12
    `╭━━━✦━━━╮\n┃ 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 ┃\n╰━━━✦━━━╯\nuser : %name\nmode : %mode\nexp  : %level\n\n〔 Commands 〕\n%commands\n\n“genz powered”`,
    // 13
    `✦ 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 ✦\nuser : %name\nmode : %mode\nexp  : %level\n\n〔 Commands 〕\n%commands\n\n“vibe with the best”`,
    // 14
    `🍥 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 🍥\nuser : %name\nmode : %mode\nexp  : %level\n\n〔 Commands 〕\n%commands\n\n“soft on the outside, pro on the inside”`,
    // 15
    `╭─〔 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 〕─╮\n│ user : %name\n│ mode : %mode\n│ exp  : %level\n╰──────────────╯\n〔 Commands 〕\n%commands\n〔 Vibes 〕\n“no bugs, just features”`,
    // 16
    `╭━━━〔 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 〕━━━╮\n┃ user : %name\n┃ mode : %mode\n┃ exp  : %level\n┣━━━ Commands ━━━┫\n%commands\n╰━━━━━━━━━━━━━━━╯\n“future is now”`,
    // 17
    `✦ 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 ✦\nuser : %name\nmode : %mode\nexp  : %level\n\n〔 Commands 〕\n%commands\n\n“mainframe: chill”`,
    // 18
    `╭─〔 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 〕─╮\n│ user : %name\n│ mode : %mode\n│ exp  : %level\n╰──────────────╯\n〔 Commands 〕\n%commands\n〔 Vibes 〕\n“404: stress not found”`,
    // 19
    `🍓 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 🍓\nuser : %name\nmode : %mode\nexp  : %level\n\n〔 Commands 〕\n%commands\n\n“slay, code, repeat”`,
    // 20
    `╭━━━〔 ✦ 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 ✦ 〕━━━╮\n┃ user : %name\n┃ mode : %mode\n┃ exp  : %level\n┣━━━〔 🍓 main cmds 〕━━━┫\n%commands\n╰━━━〔 ☁️ stay soft 〕━━━╯\n✧ *don’t stress, just vibe* ✧\n⌗ powered by pappy.exe`,
    // 21
    `✧ 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 ✧\nuser : %name\nmode : %mode\nexp  : %level\n\n〔 Commands 〕\n%commands\n\n“genz, but make it pro”`,
    // 22
    `╭─〔 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 〕─╮\n│ user : %name\n│ mode : %mode\n│ exp  : %level\n╰──────────────╯\n〔 Commands 〕\n%commands\n〔 Vibes 〕\n“ai, but make it cute”`,
    // 23
    `╔═〔 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 〕═╗\n║ user : %name\n║ mode : %mode\n║ exp  : %level\n╚═══════════════╝\n〔 Commands 〕\n%commands\n“vibe mode: on”`,
    // 24
    `✦ 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 ✦\nuser : %name\nmode : %mode\nexp  : %level\n\n〔 Commands 〕\n%commands\n\n“just keep coding”`,
    // 25
    `╭━━━〔 𝙋𝘼𝙋𝙋𝙔 𝘽𝙊𝙏 〕━━━╮\n┃ user : %name\n┃ mode : %mode\n┃ exp  : %level\n┣━━━ Commands ━━━┫\n%commands\n╰━━━━━━━━━━━━━━━╯\n“pappy.exe online”`,
];

function generateMenu(user, opts = {}) {
    // user: { name, level, mode, ping }
    // opts: { style: index or 'random', userRole }
    const userRole = opts.userRole || 'public';
    const style = typeof opts.style === 'number' && opts.style >= 0 && opts.style < MENU_TEMPLATES.length
        ? opts.style
        : Math.floor(Math.random() * MENU_TEMPLATES.length);

    const pluginsDir = path.join(__dirname, '../plugins');
    const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'));
    let menuMap = {};

    files.forEach(file => {
        try {
            const plugin = require(path.join(pluginsDir, file));
            if (!plugin.commands) return;
            const category = plugin.category ? plugin.category.toUpperCase() : 'GENERAL';
            if (!menuMap[category]) menuMap[category] = [];
            plugin.commands.forEach(command => {
                if (hasPermission(userRole, command.role)) {
                    menuMap[category].push(command.cmd);
                }
            });
        } catch (e) {
            console.log("Menu plugin load error:", file, e.message);
        }
    });

    // Flatten commands for pretty printing
    let commandsText = '';
    Object.keys(menuMap).forEach(category => {
        if (menuMap[category].length === 0) return;
        commandsText += `〔 ${category} 〕\n`;
        menuMap[category].forEach(cmd => {
            commandsText += `│ ⌬ ${cmd}\n`;
        });
    });
    commandsText = commandsText.trim();

    // Fill template
    let menu = MENU_TEMPLATES[style]
        .replace(/%name/g, user.name || '-')
        .replace(/%level/g, user.level != null ? user.level : '-')
        .replace(/%mode/g, user.mode || '-')
        .replace(/%ping/g, user.ping != null ? user.ping : '-')
        .replace(/%commands/g, commandsText);

    return menu;
}

function hasPermission(userRole, requiredRole = 'owner') {
    if (userRole === "owner") return true;
    if (userRole === "admin" && (requiredRole === "admin" || requiredRole === "public")) return true;
    if (userRole === "public" && requiredRole === "public") return true;
    return false;
}

// formatMenu is now obsolete

module.exports = { generateMenu, MENU_TEMPLATES };
