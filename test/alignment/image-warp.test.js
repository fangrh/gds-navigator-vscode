'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');

function engine() {
    const counters = { projections: 0, decodes: 0 };
    const context = { document: { createElement() {
        const canvas = { width: 0, height: 0 };
        canvas.getContext = () => ({
            drawImage(image) { canvas.source = image.pixels; counters.decodes++; },
            getImageData() { return { data: new Uint8ClampedArray(canvas.source) }; },
            createImageData() { return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }; },
            putImageData(data) { canvas.pixels = new Uint8ClampedArray(data.data); },
        });
        canvas.toDataURL = () => 'data:image/png;base64,test';
        return canvas;
    } } };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'webview/numbered-marker-alignment.js'), 'utf8'), context);
    const project = context.NumberedMarkerAlignment.project;
    context.NumberedMarkerAlignment.project = (h, p) => { counters.projections++; return project(h, p); };
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'webview/microscope-overlay.js'), 'utf8'), context);
    return { overlay: context.MicroscopeOverlay, api: context.NumberedMarkerAlignment, counters };
}

// Frozen scalar reference: call project() with a fresh point for each pixel,
// then let the actual Uint8ClampedArray assignment perform IEEE rounding.
function reference(source, width, height, output, inverse, project) {
    const ow = output.canvas.width, oh = output.canvas.height, extent = output.extent;
    const result = new Uint8ClampedArray(ow * oh * 4);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        const p = project(inverse, [extent[0] + (x + .5) * (extent[2] - extent[0]) / ow, extent[3] - (y + .5) * (extent[3] - extent[1]) / oh]);
        const sx = p[0] - .5, sy = p[1] - .5, x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
        if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) continue;
        for (let ch = 0; ch < 4; ch++) result[4 * (y * ow + x) + ch] = (1 - fy) * ((1 - fx) * source[4 * (y0 * width + x0) + ch] + fx * source[4 * (y0 * width + x0 + 1) + ch]) + fy * ((1 - fx) * source[4 * ((y0 + 1) * width + x0) + ch] + fx * source[4 * ((y0 + 1) * width + x0 + 1) + ch]);
    }
    return result;
}

let seed = 0x12345678;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
let pixelsChecked = 0;
for (let i = 0; i < 28; i++) {
    const width = i === 27 ? 2501 : 3 + Math.floor(random() * 130), height = i === 27 ? 1 : 3 + Math.floor(random() * 100);
    const image = { naturalWidth: width, naturalHeight: height, pixels: Uint8ClampedArray.from({ length: width * height * 4 }, () => Math.floor(random() * 256)) };
    const current = engine(), state = { img: image, cx: random() * 10 - 5, cy: random() * 10 - 5, umPerPx: .3 + random(), rotDeg: i === 27 ? 0 : random() * 360,
        opacity: 1, visible: true, locked: true, markerTransform: null, markerPose: null, display: current.overlay.defaultDisplay() };
    if (i % 3 === 0) {
        state.markerTransform = [1, .04, 0, -.03, -1, height, .0002, .0001, 1];
        state.markerPose = { cx: state.cx, cy: state.cy, umPerPx: state.umPerPx, rotDeg: state.rotDeg };
    }
    const output = current.overlay.render(image, state);
    assert.equal(current.counters.projections, 4, 'warp still created per-pixel projection calls/points');
    const expected = reference(image.pixels, width, height, output, current.api.inverse(output.transform), current.api.project);
    assert.equal(Buffer.compare(Buffer.from(output.canvas.pixels), Buffer.from(expected)), 0, `RGBA mismatch at pose ${i}`);
    pixelsChecked += expected.length / 4;
    assert.strictEqual(current.overlay.render(image, state), output, 'identical render missed the existing image cache');
    assert.equal(current.counters.decodes, 1);
}
console.log(JSON.stringify({ status: 'passed', cases: 28, pixelsChecked, projectionCallsPerWarp: 4, alphaAndProjectiveParity: true }));
