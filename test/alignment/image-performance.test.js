// Focused evidence for microscope-overlay image decode and contour reuse.
// A frozen prechange display path is compared with the current implementation
// under the same deterministic canvas shim.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const overlayPath = path.join(__dirname, '../../webview/microscope-overlay.js');
const currentSource = fs.readFileSync(overlayPath, 'utf8');
// Frozen prechange implementation: this is the relevant old display path,
// retained here so the test remains stable after the repository advances.
const legacyDrawDisplay = `function drawDisplay(warped,ow,oh,d,borderMask) {
        if (d.mode==='image' && !d.border) return warped;
        const out=new Uint8ClampedArray(warped), rgb=colorRgb(d.color), radius=d.width-1;
        const lum=(i)=>((warped[i]*299+warped[i+1]*587+warped[i+2]*114)/1000);
        function edgeAt(x,y) { const i=4*(y*ow+x); if (warped[i+3]===0) return false;
            if (d.border && borderMask[y*ow+x]) return true;
            if (d.mode==='image') return false;
            let gx=0,gy=0,hasTransparent=false;
            for(let ky=-1;ky<=1;ky++)for(let kx=-1;kx<=1;kx++) {
                const xx=Math.max(0,Math.min(ow-1,x+kx)), yy=Math.max(0,Math.min(oh-1,y+ky)), ni=4*(yy*ow+xx);
                if(warped[ni+3]===0) { hasTransparent=true; continue; }
                const weight=(kx===0?0:kx)*(ky===0?2:1); gx+=lum(ni)*weight;
                const yweight=(ky===0?0:ky)*(kx===0?2:1); gy+=lum(ni)*yweight;
            }
            if (hasTransparent) return false;
            return Math.hypot(gx,gy)>=d.threshold;
        }
        if (d.mode==='contours') out.fill(0);
        for(let y=0;y<oh;y++)for(let x=0;x<ow;x++)if(edgeAt(x,y)) {
            for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++) {
                const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=ow||yy>=oh)continue; const i=4*(yy*ow+xx);
                if(warped[i+3]===0) continue;
                out[i]=rgb[0];out[i+1]=rgb[1];out[i+2]=rgb[2];out[i+3]=warped[i+3];
            }
        }
        return out;
    }`;
const beforeSource = currentSource
  .replace(/function drawDisplay\([\s\S]*?\n    function contourMaskFor/, `${legacyDrawDisplay}\n    function contourMaskFor`)
  .replace(/if\(\(d\.mode==='contours'\|\|d\.mode==='image-contours'\)[\s\S]*?entry\.contourMaskThreshold=d\.threshold;\}/,
    'if(false) { entry.contourMask=null; entry.contourMaskThreshold=null; }');

function instrument(source, version) {
  const marker = version === 'before' ? 'function edgeAt(x,y) {' : 'function contourMaskFor(warped,ow,oh,threshold) {';
  assert(source.includes(marker), `instrumentation marker missing for ${version}`);
  source = source.replace(marker, `${marker} root.__perf.${version === 'before' ? 'edgeChecks' : 'contourScans'}++;`);
  const loop = 'for(let ky=-1;ky<=1;ky++)for(let kx=-1;kx<=1;kx++) {';
  assert(source.includes(loop), `neighbor loop missing for ${version}`);
  source = source.replace(loop, `${loop} root.__perf.neighborVisits++;`);
  return source;
}

function makeCanvas(perf) {
  const canvas = { width: 0, height: 0, _data: null, _source: null };
  canvas.getContext = () => ({
    drawImage(image) { perf.decodeDraws++; canvas._source = image._pixels; },
    getImageData() { perf.getImageData++; return { data: new Uint8ClampedArray(canvas._source || []) }; },
    createImageData(_, h) { return { data: new Uint8ClampedArray(canvas.width * h * 4) }; },
    putImageData(data) { canvas._data = new Uint8ClampedArray(data.data); },
  });
  canvas.toDataURL = () => 'data:image/png;base64,test';
  return canvas;
}

function load(source) {
  const perf = { decodeDraws: 0, getImageData: 0, edgeChecks: 0, contourScans: 0, neighborVisits: 0 };
  const canvases = [];
  const sandbox = {
    __perf: perf,
    NumberedMarkerAlignment: {
      project(h, p) { return [h[0] * p[0] + h[2], h[4] * p[1] + h[5]]; },
      inverse(h) {
        const det = h[0] * h[4] - h[1] * h[3];
        return [h[4] / det, -h[1] / det, (h[1] * h[5] - h[4] * h[2]) / det,
          -h[3] / det, h[0] / det, (h[3] * h[2] - h[0] * h[5]) / det, 0, 0, 1];
      },
    },
    document: { createElement() { const canvas = makeCanvas(perf); canvases.push(canvas); return canvas; } },
  };
  vm.runInNewContext(instrument(source, source === currentSource ? 'after' : 'before'), sandbox);
  return { overlay: sandbox.MicroscopeOverlay, perf, canvases };
}

const pixels = new Uint8ClampedArray(8 * 8 * 4);
for (let i = 0; i < 64; i++) pixels[4 * i + 3] = 255;
for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) pixels[4 * (y * 8 + x)] = pixels[4 * (y * 8 + x) + 1] = pixels[4 * (y * 8 + x) + 2] = 32;
function image() { return { naturalWidth: 8, naturalHeight: 8, _pixels: pixels }; }
function state(img, display) {
  return { img, cx: 4, cy: 4, umPerPx: 1, rotDeg: 0, opacity: 1, visible: true, locked: true,
    markerTransform: null, markerPose: null, quality: { status: 'unverified', boundaryRmsPx: null, markerCount: 0 },
    options: { markerAppearance: 'yellow', markerLayers: ['1/0'] }, display };
}
function display(color, width, threshold = 1) { return { mode: 'contours', threshold, color, width, border: false }; }
function bytes(result) { return Array.from(result.canvas._data); }

const before = load(beforeSource);
const after = load(currentSource);
const beforeImage = image();
const afterImage = image();
const beforeState = state(beforeImage, display('#ff0000', 1));
const afterState = state(afterImage, display('#ff0000', 1));

const beforeFirst = before.overlay.render(beforeImage, beforeState);
const afterFirst = after.overlay.render(afterImage, afterState);
assert.deepEqual(bytes(afterFirst), bytes(beforeFirst), 'optimized first render changed contour pixels');
const beforeOutputs = [
  beforeFirst,
  before.overlay.render(beforeImage, { ...beforeState, display: display('#00ff00', 1) }),
  before.overlay.render(beforeImage, { ...beforeState, display: display('#00ff00', 3) }),
  before.overlay.render(beforeImage, { ...beforeState, display: display('#00ff00', 3, 2) }),
  before.overlay.render(beforeImage, { ...beforeState, cx: 4.25, display: display('#00ff00', 3, 2) }),
];
assert.equal(after.perf.getImageData, 1, 'optimized path decoded source more than once');
assert.equal(after.perf.decodeDraws, 1, 'optimized path drew source more than once');
const firstNeighbors = after.perf.neighborVisits;
assert(firstNeighbors > 0, 'optimized path did not perform a contour scan');

// Color and width changes should reuse the Sobel mask while producing the same
// bytes as a fresh render of the corresponding state.
for (const nextDisplay of [display('#00ff00', 1), display('#00ff00', 3)]) {
  const fresh = load(currentSource);
  const freshResult = fresh.overlay.render(image(), state(image(), nextDisplay));
  const result = after.overlay.render(afterImage, { ...afterState, display: nextDisplay });
  assert.deepEqual(bytes(result), bytes(freshResult), 'cached contour output differs from fresh output');
  assert.equal(after.perf.neighborVisits, firstNeighbors, 'color/width change reran Sobel neighbor work');
}
const afterOutputs = [
  afterFirst,
  after.overlay.render(afterImage, { ...afterState, display: display('#00ff00', 1) }),
  after.overlay.render(afterImage, { ...afterState, display: display('#00ff00', 3) }),
  after.overlay.render(afterImage, { ...afterState, display: display('#00ff00', 3, 2) }),
  after.overlay.render(afterImage, { ...afterState, cx: 4.25, display: display('#00ff00', 3, 2) }),
];
for (let i = 0; i < beforeOutputs.length; i++) assert.deepEqual(bytes(afterOutputs[i]), bytes(beforeOutputs[i]), `optimized state ${i} changed contour pixels`);

const cached = after.overlay.render(afterImage, { ...afterState, display: display('#00ff00', 3) });
const cachedNeighborVisits = after.perf.neighborVisits;
assert.strictEqual(cached, after.overlay.render(afterImage, { ...afterState, display: display('#00ff00', 3) }), 'identical render missed bounded output cache');
assert.equal(after.perf.neighborVisits, cachedNeighborVisits, 'identical render reran Sobel work');

// Threshold changes invalidate the mask; pose changes invalidate both warp and mask.
after.overlay.render(afterImage, { ...afterState, display: display('#00ff00', 3, 2) });
assert(after.perf.neighborVisits > firstNeighbors, 'threshold change did not invalidate contour mask');
const afterThresholdNeighbors = after.perf.neighborVisits;
after.overlay.render(afterImage, { ...afterState, cx: 4.25, display: display('#00ff00', 3, 2) });
assert(after.perf.neighborVisits > afterThresholdNeighbors, 'pose change did not invalidate contour mask');

// Matched benchmark: fresh engines, one identical five-state sequence each.
// Counters below come only from this sequence, without correctness probes.
function runFiveStates(source) {
  const engine = load(source);
  const img = image();
  const base = state(img, display('#ff0000', 1));
  const specs = [
    { display: display('#ff0000', 1) },
    { display: display('#00ff00', 1) },
    { display: display('#00ff00', 3) },
    { display: display('#00ff00', 3, 2) },
    { cx: 4.25, display: display('#00ff00', 3, 2) },
  ];
  const outputs = specs.map(spec => engine.overlay.render(img, { ...base, ...spec }));
  return { engine, outputs };
}
const matchedBefore = runFiveStates(beforeSource);
const matchedAfter = runFiveStates(currentSource);
for (let i = 0; i < matchedBefore.outputs.length; i++) {
  assert.deepEqual(bytes(matchedAfter.outputs[i]), bytes(matchedBefore.outputs[i]), `matched benchmark state ${i} changed contour pixels`);
}
assert.equal(matchedBefore.engine.perf.getImageData, matchedAfter.engine.perf.getImageData, 'matched decode counts differ');
assert.equal(matchedBefore.engine.perf.decodeDraws, matchedAfter.engine.perf.decodeDraws, 'matched source draw counts differ');
const evidence = {
  source: 'webview/microscope-overlay.js',
  fixture: '8x8 RGBA synthetic image with 4x4 dark square',
  matchedStates: 5,
  before: { edgeChecks: matchedBefore.engine.perf.edgeChecks, neighborVisits: matchedBefore.engine.perf.neighborVisits, getImageData: matchedBefore.engine.perf.getImageData, decodeDraws: matchedBefore.engine.perf.decodeDraws },
  after: { contourScans: matchedAfter.engine.perf.contourScans, neighborVisits: matchedAfter.engine.perf.neighborVisits, getImageData: matchedAfter.engine.perf.getImageData, decodeDraws: matchedAfter.engine.perf.decodeDraws },
  result: 'passed',
};
fs.writeFileSync(path.join(__dirname, '../../logs/performance/images.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence));
console.log('image performance evidence passed');
