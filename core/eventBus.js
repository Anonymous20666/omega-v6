// core/eventBus.js
const EventEmitter = require('events');
class EventBus extends EventEmitter {}
const bus = new EventBus();
bus.setMaxListeners(200);
module.exports = bus;
