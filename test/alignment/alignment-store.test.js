/* Focused regression tests for the extension-side persisted alignment schema. */
const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const out = path.join(os.tmpdir(), `gds-alignment-store-${process.pid}.cjs`);
esbuild.buildSync({ entryPoints: [path.join(__dirname, '../../src/alignmentStore.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out });
const { validateAlignmentState, alignmentStoreKey } = require(out);

function state(overrides = {}) {
  return {
    version: 1, imageSizePx: [100, 80], cx: 1, cy: 2, umPerPx: 0.5, rotDeg: 0,
    opacity: 0.55, visible: true, locked: false, markerTransform: null, markerPose: null,
    quality: { status: 'unverified', boundaryRmsPx: null, markerCount: 0 },
    options: { markerAppearance: 'yellow', markerLayers: ['1/0'] }, ...overrides
  };
}

assert(validateAlignmentState(state()), 'valid unverified state rejected');
assert(validateAlignmentState(state({ markerTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1], markerPose: { cx: 1, cy: 2, umPerPx: .5, rotDeg: 0 }, quality: { status: 'aligned', boundaryRmsPx: 1, markerCount: 3 } })), 'valid aligned state rejected');
assert(!validateAlignmentState(state({ umPerPx: NaN })), 'NaN scale accepted');
assert(!validateAlignmentState(state({ imageSizePx: [4096, 4096] })), 'oversized image accepted');
assert(!validateAlignmentState(state({ markerTransform: [1, 0, 0, 0, 1, 0, 0, 0, -1], markerPose: { cx: 1, cy: 2, umPerPx: .5, rotDeg: 0 } })), 'negative projective domain accepted');
assert(!validateAlignmentState(state({ options: { markerAppearance: 'yellow', markerLayers: ['4/0'] } })), 'forbidden marker layer accepted');
assert(!validateAlignmentState(state({ quality: { status: 'aligned', boundaryRmsPx: null, markerCount: 3 } })), 'aligned state without fit evidence accepted');
assert.strictEqual(alignmentStoreKey('C:\\Chip\\A.GDS'), 'gdsNavigator.alignment:c:\\chip\\a.gds');
fs.unlinkSync(out);
console.log('alignment-store tests passed');
