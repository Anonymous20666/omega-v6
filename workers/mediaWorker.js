'use strict';

class MediaWorker {
    constructor({ mediaQueue }) {
        this.mediaQueue = mediaQueue;
    }

    submit(fn, priority = 5) {
        this.mediaQueue.enqueue(fn, priority);
    }
}

module.exports = { MediaWorker };
