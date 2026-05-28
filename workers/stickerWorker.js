'use strict';

class StickerWorker {
    constructor({ mediaQueue }) {
        this.mediaQueue = mediaQueue;
    }

    submit(fn) {
        this.mediaQueue.enqueue(fn, 4);
    }
}

module.exports = { StickerWorker };
