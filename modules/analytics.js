const startTime = Date.now();

function getRuntime() {
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);
    const seconds = Math.floor((uptimeMs % 60000) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
}

module.exports = { getRuntime };
