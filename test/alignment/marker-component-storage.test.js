#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'webview/numbered-marker-alignment.js'), 'utf8');

function run(source, rgba, w, h, instrument = false) {
  const stats = { pushes: 0 };
  class FakeOffscreenCanvas {
    constructor(width, height, pixels) { this.width = width; this.height = height; this.naturalWidth = width; this.naturalHeight = height; this.pixels = pixels; }
    getContext() { return { getImageData: () => ({ data: this.pixels }) }; }
  }
  let tested = source;
  if (instrument) {
    const matches = tested.match(/pixels\.push\(q\)/g) || [];
    assert.equal(matches.length, 1, 'collector instrumentation anchor must match exactly once');
    tested = tested.replace(/pixels\.push\(q\)/, 'stats.pushes++;pixels.push(q)');
  }
  const context = { OffscreenCanvas: FakeOffscreenCanvas, stats };
  vm.createContext(context);
  vm.runInContext(tested, context);
  const canvas = new FakeOffscreenCanvas(w, h, rgba);
  return { result: context.NumberedMarkerAlignment.photoMarkers(canvas, { markerAppearance: 'dark' }), stats };
}

// Frozen pre-change component collector. Keep this local so the contract does not
// depend on ignored daily logs remaining present.
const LEGACY = SOURCE.replace(
  /const decoded=typeof root\.OffscreenCanvas[\s\S]*?return \{w,h,mask,labelMask,pads\};\n    }/,
  `const c=image,ctx=c.getContext('2d');
        const rgba=ctx.getImageData(0,0,w,h).data,mask=new Uint8Array(w*h),labelMask=new Uint8Array(w*h),seen=new Uint8Array(w*h),pads=[];
        for(let i=0;i<mask.length;i++){if(rgba[4*i+3]===0)continue;const r=rgba[4*i],g=rgba[4*i+1],b=rgba[4*i+2],y=(r+g+b)/3;mask[i]=appearance==='bright'?(y>210?1:0):appearance==='dark'?(y<65?1:0):(Math.min(r,g)-b>65&&r>100&&g>90?1:0);labelMask[i]=appearance==='bright'?(y>190?1:0):appearance==='dark'?(y<100?1:0):(Math.min(r,g)-b>25&&r>100&&g>90?1:0);}
        for(let i=0;i<mask.length;i++){if(!mask[i]||seen[i])continue;const stack=[i],pixels=[];seen[i]=1;let x0=w,y0=h,x1=0,y1=0,sx=0,sy=0;while(stack.length){const q=stack.pop(),x=q%w,y=Math.floor(q/w);pixels.push(q);sx+=x+.5;sy+=y+.5;x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);for(const j of [x>0?q-1:-1,x+1<w?q+1:-1,y>0?q-w:-1,y+1<h?q+w:-1])if(j>=0&&mask[j]&&!seen[j]){seen[j]=1;stack.push(j);}}const bw=x1-x0+1,bh=y1-y0+1;if(pixels.length<100||bw/bh<.65||bw/bh>1.5||pixels.length/(bw*bh)<.65||bw>Math.min(w,h)*.2)continue;if(x0===0||y0===0||x1===w-1||y1===h-1)continue;const boundary=pixels.filter(q=>!mask[q-1]||!mask[q+1]||!mask[q-w]||!mask[q+w]).map(q=>[q%w+.5,Math.floor(q/w)+.5]);pads.push({center:[sx/pixels.length,sy/pixels.length],width:Math.sqrt(pixels.length),boundary});}
        return {w,h,mask,labelMask,pads};
    }`);
assert.notEqual(LEGACY, SOURCE, 'Frozen component collector replacement must match');

function image(w, h, shapes) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (const s of shapes) for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) {
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = 4 * (y * w + x); rgba[i] = rgba[i + 1] = rgba[i + 2] = s.value ?? 0; rgba[i + 3] = s.alpha ?? 255;
  }
  return rgba;
}

function check(name, w, h, shapes, expectedPads, expectedPushes) {
  const rgba = image(w, h, shapes);
  const before = run(LEGACY, rgba, w, h).result;
  const current = run(SOURCE, rgba, w, h, true);
  const plain = value => JSON.parse(JSON.stringify(value, (_, item) => ArrayBuffer.isView(item) ? Array.from(item) : item));
  assert.deepEqual(plain(current.result), plain(before), `${name}: output changed`);
  assert.equal(current.result.pads.length, expectedPads, `${name}: pad count`);
  if (expectedPushes !== undefined) assert.equal(current.stats.pushes, expectedPushes, `${name}: staged pixels`);
  return current;
}

// Put the old red proof first: this component is rejected at its first pixel.
const border = check('solid border foreground storage', 256, 256, [{ x: 0, y: 0, w: 256, h: 256 }], 0, 0);
const valid = { x: 90, y: 90, w: 20, h: 20 };
check('interior valid plus rejected border and oversized blobs', 256, 256, [
  valid, { x: 0, y: 0, w: 20, h: 20 }, { x: 150, y: 20, w: 60, h: 60 },
], 1);
check('right and bottom border components', 128, 128, [
  { x: 108, y: 20, w: 20, h: 20 }, { x: 20, y: 108, w: 20, h: 20 },
], 0);
check('width at cap and cap plus one', 256, 256, [
  { x: 20, y: 100, w: 51, h: 51 }, { x: 120, y: 100, w: 52, h: 52 },
], 1);
check('transparent dark pixels do not connect', 128, 128, [
  { x: 30, y: 30, w: 20, h: 20, alpha: 0 }, { x: 80, y: 80, w: 20, h: 20 },
], 1);
check('disconnected tiny components and valid ordering', 128, 128, [
  { x: 80, y: 80, w: 20, h: 20 }, { x: 5, y: 5, w: 5, h: 5 }, { x: 20, y: 20, w: 9, h: 9 },
], 1);
check('late border discovery preserves following pad', 128, 128, [
  { x: 40, y: 40, w: 20, h: 20 }, { x: 50, y: 60, w: 1, h: 68 }, { x: 90, y: 80, w: 20, h: 20 },
], 1);

const reportDir = path.resolve(process.env.GDS_MARKER_COMPONENT_REPORT_DIR || path.join(ROOT, 'logs', 'numbered-markers', 'component-storage'));
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({ status: 'passed', cases: 7, solidBorderPixels: 65536, optimizedStagedPixels: border.stats.pushes }, null, 2));
console.log(JSON.stringify({ status: 'passed', cases: 7, solidBorderPixels: 65536, optimizedStagedPixels: border.stats.pushes }));
