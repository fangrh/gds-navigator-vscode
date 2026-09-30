const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../webview/viewer.html'), 'utf8');
const begin = html.indexOf('// ---- manual adjustment (img-move mode) ----');
const end = html.indexOf('function nudgeMicroImage', begin);
assert(begin >= 0 && end > begin);
const handlers = new Map();
const frames = new Map();
let nextFrame = 0;
const renders = [];
const reports = [];
const image = { cx: 0, cy: 0, locked: false };
const sandbox = {
  map: {
    on(type, handler) { handlers.set(type, handler); },
    getView() { return { getResolution: () => 2 }; },
    getViewport() { return { addEventListener() {} }; },
  },
  microImg: image, imgMoveMode: true, imageBusy: false,
  requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
  cancelAnimationFrame(id) { frames.delete(id); },
  renderMicroLayer(updateUi) { renders.push({ x: image.cx, y: image.cy, updateUi }); },
  reportTransform(note) { reports.push({ note, x: image.cx, y: image.cy }); },
};
vm.runInNewContext(html.slice(begin, end), sandbox);
const emit = (type, x, y) => handlers.get(type)({ pixel: [x, y] });
emit('pointerdown', 0, 0);
for (let i = 1; i <= 200; i++) emit('pointermove', i, i / 2);
assert.equal(frames.size, 1);
assert.equal(renders.length, 0);
assert.equal(image.cx, 400);
assert.equal(image.cy, -200);
const frame = [...frames.values()][0]; frames.clear(); frame();
assert.deepEqual(renders, [{ x: 400, y: -200, updateUi: false }]);
emit('pointermove', 201, 101);
assert.equal(frames.size, 1);
emit('pointerup', 201, 101);
assert.equal(frames.size, 0);
assert.deepEqual(renders.at(-1), { x: 402, y: -202, updateUi: true });
assert.deepEqual(reports, [{ note: 'moved', x: 402, y: -202 }]);
console.log(JSON.stringify({ status: 'passed', pointerMoves: 201, intermediateRenders: 1, finalRenders: 1, finalPosition: [402, -202] }));
