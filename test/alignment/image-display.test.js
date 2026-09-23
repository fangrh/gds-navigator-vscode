const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');

function makeCanvas() {
  const canvas = {
    width: 0, height: 0, _data: null,
    getContext() { return {
      drawImage(image) { canvas._source = image._pixels; },
      getImageData() { return { data: new Uint8ClampedArray(canvas._source || []) }; },
      createImageData(_, h) { return { data: new Uint8ClampedArray(canvas.width * h * 4) }; },
      putImageData(data) { canvas._data = data.data; },
    }; },
    toDataURL() { return 'data:image/png;base64,test'; },
  };
  return canvas;
}
// Keep the tiny canvas shim explicit: this test checks pixel policy, not browser codecs.
const source = fs.readFileSync(require('path').join(__dirname, '../../webview/microscope-overlay.js'), 'utf8');
const canvases = [];
const sandbox = {
  NumberedMarkerAlignment: {
    project(h, p) { return [h[0] * p[0] + h[2], h[4] * p[1] + h[5]]; },
    inverse(h) {
      const det = h[0] * h[4] - h[1] * h[3];
      return [h[4] / det, -h[1] / det, (h[1] * h[5] - h[4] * h[2]) / det,
        -h[3] / det, h[0] / det, (h[3] * h[2] - h[0] * h[5]) / det, 0, 0, 1];
    },
  },
  document: { createElement() { const c = makeCanvas(); canvases.push(c); return c; } },
};
vm.runInNewContext(source, sandbox);
const overlay = sandbox.MicroscopeOverlay;
const pixels = new Uint8ClampedArray(5 * 5 * 4);
for (let i = 0; i < 25; i++) { pixels[4 * i] = 255; pixels[4 * i + 1] = 255; pixels[4 * i + 2] = 255; pixels[4 * i + 3] = 255; }
// A dark 3x3 square gives a real Sobel response at its boundary.
for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) pixels[4 * (y * 5 + x)] = pixels[4 * (y * 5 + x) + 1] = pixels[4 * (y * 5 + x) + 2] = 0;
pixels[4 * (0 * 5 + 0) + 3] = 0;
const image = { naturalWidth: 5, naturalHeight: 5, _pixels: pixels };
const base = { img: image, cx: 2.5, cy: 2.5, umPerPx: 1, rotDeg: 0, opacity: 1, visible: true, locked: true, markerTransform: null, markerPose: null,
  quality: { status: 'unverified', boundaryRmsPx: null, markerCount: 0 }, options: { markerAppearance: 'yellow', markerLayers: ['1/0'] } };

assert.equal(JSON.stringify(overlay.defaultDisplay()), JSON.stringify({ mode: 'image', threshold: 40, color: '#00ffff', width: 1, border: false }));
const serialized = overlay.serialize(base);
assert.deepEqual(serialized.display, overlay.defaultDisplay());
const imageResult = overlay.render(image, base);
base.display = { mode: 'contours', threshold: 1, color: '#ff0000', width: 1, border: false };
const contourResult = overlay.render(image, base);
assert.notStrictEqual(contourResult, imageResult, 'display change must invalidate output cache');
assert.deepEqual(contourResult.transform, imageResult.transform, 'display change must preserve pose transform');
const contour = canvases.at(-1)._data;
assert(contour.some((v, i) => i % 4 === 0 && v === 255), 'synthetic square has no contour pixels');
assert.equal(contour[3], 0, 'transparent source pixel became a contour');
base.display = { mode: 'image-contours', threshold: 1, color: '#00ff00', width: 1, border: false };
const composed = overlay.render(image, base);
const composedPixels = canvases.at(-1)._data;
assert.equal(composedPixels[3], 0, 'transparent source alpha was not preserved');
assert.deepEqual(composed.transform, imageResult.transform);

// A border follows the transformed source perimeter and does not promote an
// interior image edge when the selected mode is image+border.
base.display = { mode: 'image', threshold: 1, color: '#ff0000', width: 1, border: true };
base.rotDeg = 27;
const bordered = overlay.render(image, base);
const borderedPixels = canvases.at(-1)._data;
assert(borderedPixels.some((v, i) => i % 4 === 0 && v === 255 && borderedPixels[i + 1] === 0), 'rotated source perimeter was not rendered');
const center = 4 * (Math.floor(bordered.canvas.height / 2) * bordered.canvas.width + Math.floor(bordered.canvas.width / 2));
assert.equal(borderedPixels[center], 0, 'image+border generated an internal contour');
assert.deepEqual(bordered.transform, overlay.transform(base, image.naturalWidth, image.naturalHeight));

// A constant image with a transparent interior must not produce contours at
// the alpha boundary; transparent pixels remain transparent.
const transparentPixels = new Uint8ClampedArray(pixels);
for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) transparentPixels[4 * (y * 5 + x) + 3] = 0;
const transparentImage = { naturalWidth: 5, naturalHeight: 5, _pixels: transparentPixels };
const transparentState = { ...base, img: transparentImage, rotDeg: 0, display: { mode: 'contours', threshold: 1, color: '#00ff00', width: 1, border: false } };
overlay.render(transparentImage, transparentState);
const transparentOutput = canvases.at(-1)._data;
assert.equal(transparentOutput.filter((v, i) => i % 4 === 3 && v !== 0).length, 0, 'alpha boundary created artificial contour');
const pose = JSON.stringify({ cx: base.cx, cy: base.cy, umPerPx: base.umPerPx, rotDeg: base.rotDeg });
for (const bad of [{ ...serialized, display: { ...serialized.display, threshold: 0 } }, { ...serialized, display: { ...serialized.display, color: 'red' } }, { ...serialized, display: { ...serialized.display, width: 5 } }]) {
  assert.throws(() => overlay.restore(base, bad), /Invalid saved image state/);
  assert.equal(JSON.stringify({ cx: base.cx, cy: base.cy, umPerPx: base.umPerPx, rotDeg: base.rotDeg }), pose);
}
const old = { ...serialized }; delete old.display;
overlay.restore(base, old);
assert.equal(JSON.stringify(base.display), JSON.stringify(overlay.defaultDisplay()), 'old saved state was not accepted with default display');
console.log('image-display tests passed');
