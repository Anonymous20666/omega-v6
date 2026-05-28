// core/ai.agents.js
const AGENTS = {
    engineer: `Senior engineer. Focus on scalability, performance, clean architecture.`,
    hacker: `Cybersecurity expert. Find vulnerabilities and risks.`,
    pm: `Product strategist. Focus on growth, retention, monetization.`,
    debugger: `Debugging expert. Find root cause fast.`
};

function detectIntent(prompt) {
    const p = prompt.toLowerCase();

    if (p.includes('error') || p.includes('bug')) return ['debugger'];
    if (p.includes('exploit') || p.includes('hack')) return ['hacker'];
    if (p.includes('scale') || p.includes('users') || p.includes('growth')) return ['pm', 'engineer'];
    if (p.includes('optimize') || p.includes('refactor')) return ['engineer'];

    return ['engineer']; // Default persona
}

module.exports = { AGENTS, detectIntent };
