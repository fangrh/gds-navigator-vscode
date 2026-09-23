// Atomic browser-state restore checks without opening a browser.
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(require('path').join(__dirname, '../../webview/microscope-overlay.js'), 'utf8');
const sandbox = { NumberedMarkerAlignment: { inverse(h) { if (!Array.isArray(h) || h.length !== 9) throw new Error('bad H'); return h; } } };
vm.runInNewContext(source, sandbox);
const overlay = sandbox.MicroscopeOverlay;
const state = {
  img: { naturalWidth: 100, naturalHeight: 80 }, cx: 1, cy: 2, umPerPx: .5, rotDeg: 3, opacity: .6,
  visible: true, locked: true, markerTransform: null, markerPose: null,
  quality: { status: 'unverified', boundaryRmsPx: null, markerCount: 0 },
  options: { markerAppearance: 'yellow', markerLayers: ['1/0'] }
};
const saved = { version: 1, imageSizePx: [100, 80], cx: 7, cy: 8, umPerPx: .4, rotDeg: 2, opacity: .5,
  visible: false, locked: false, markerTransform: null, markerPose: null,
  quality: { status: 'unverified', boundaryRmsPx: null, markerCount: 0 }, options: { markerAppearance: 'yellow', markerLayers: ['1/0'] } };
overlay.restore(state, saved);
assert.equal(state.cx, 7);
const before = JSON.stringify(state);
for (const bad of [
  { ...saved, imageSizePx: [101, 80] },
  { ...saved, markerTransform: [1, 0, 0, 0, 1, 0, 0, 0, 0], markerPose: { cx: 1, cy: 2, umPerPx: .5, rotDeg: 0 } },
  { ...saved, markerTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1], markerPose: null },
  { ...saved, quality: { status: 'aligned', boundaryRmsPx: null, markerCount: 0 } },
  { ...saved, options: { markerAppearance: 'yellow', markerLayers: ['4/0'] } },
]) {
  assert.throws(() => overlay.restore(state, bad), /Invalid saved image state/);
  assert.equal(JSON.stringify(state), before, 'rejected restore mutated active state');
}
console.log('microscope overlay restore tests passed');
