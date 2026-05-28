// core/engine.js
const eventBus = require('./eventBus');
require('./commandRouter'); 
require('./watchdog'); // Will auto-initialize your upgraded watchdog

module.exports = {
    triggerBoot: (sock) => eventBus.emit('system.boot', sock),
    triggerMessage: (payload) => eventBus.emit('message.upsert', payload)
};
