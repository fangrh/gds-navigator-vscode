/*
 * Optional worker host for numbered-marker-alignment.js.
 * Protocol:
 *   -> {type:'align', requestId, imageBitmap, features, options}
 *   <- {type:'started'|'result'|'error'|'canceled', requestId, result?, message?}
 * Transfer an ImageBitmap in the postMessage transfer list.  A running solve
 * is canceled by terminating this worker; the cancel message only cancels a
 * queued request before the solver starts (the solver is synchronous).
 */
(function () {
    'use strict';
    if (!self.NumberedMarkerAlignment) importScripts('numbered-marker-alignment.js');
    var active = null, canceled = new Set();

    function solverImage(bitmap) {
        if (!bitmap || !Number.isFinite(bitmap.width) || !Number.isFinite(bitmap.height)) throw new Error('imageBitmap is required');
        if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas is unavailable');
        var canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('worker canvas context unavailable');
        ctx.drawImage(bitmap, 0, 0);
        Object.defineProperties(canvas, { naturalWidth: { value: bitmap.width }, naturalHeight: { value: bitmap.height } });
        return canvas;
    }

    self.onmessage = async function (event) {
        var message = event.data || {}, id = message.requestId;
        if (message.type === 'cancel') {
            if (id !== undefined) canceled.add(id);
            if (active === id) self.postMessage({ type: 'canceled', requestId: id, message: 'Cancel requested; terminate the worker to interrupt an active solve.' });
            return;
        }
        if (message.type === 'ping') { self.postMessage({ type: 'pong' }); return; }
        if (message.type !== 'align') return;
        if (active !== null) { self.postMessage({ type: 'error', requestId: id, message: 'worker is busy' }); return; }
        if (canceled.has(id)) { canceled.delete(id); self.postMessage({ type: 'canceled', requestId: id }); return; }
        active = id;
        self.postMessage({ type: 'started', requestId: id });
        try {
            var image = solverImage(message.imageBitmap);
            if (canceled.has(id)) { canceled.delete(id); self.postMessage({ type: 'canceled', requestId: id }); return; }
            var result = await self.NumberedMarkerAlignment.align({ image: image, features: message.features, options: message.options });
            if (canceled.has(id)) { canceled.delete(id); self.postMessage({ type: 'canceled', requestId: id }); return; }
            self.postMessage({ type: 'result', requestId: id, result: result });
        } catch (error) {
            self.postMessage({ type: 'error', requestId: id, message: String(error && error.message || error) });
        } finally { active = null; }
    };
}());
