#!/usr/bin/env node
'use strict';
// Deterministic robustness corpus: contamination is seeded and never changes
// the marker geometry or expected transform.
const assert = require('assert/strict');
const fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '../..');
const FIXTURE = path.join(ROOT, 'test/fixtures/jj_pad_center_50_geo.json');
const SCRIPT = path.join(ROOT, 'webview/numbered-marker-alignment.js');
const browserPath = process.env.GDS_BROWSER || ['C:/Program Files/Microsoft Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(fs.existsSync);
assert(browserPath, 'Edge/Chrome required; set GDS_BROWSER');

function inverse(a) { const b=[a[4]*a[8]-a[5]*a[7],a[2]*a[7]-a[1]*a[8],a[1]*a[5]-a[2]*a[4],a[5]*a[6]-a[3]*a[8],a[0]*a[8]-a[2]*a[6],a[2]*a[3]-a[0]*a[5],a[3]*a[7]-a[4]*a[6],a[1]*a[6]-a[0]*a[7],a[0]*a[4]-a[1]*a[3]],d=a[0]*b[0]+a[1]*b[3]+a[2]*b[6]; return b.map(x=>x/d); }
function project(h,p) { const z=h[6]*p[0]+h[7]*p[1]+h[8]; return [(h[0]*p[0]+h[1]*p[1]+h[2])/z,(h[3]*p[0]+h[4]*p[1]+h[5])/z]; }

async function main() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const features = fixture.features.filter(f => [1, 8, 9].includes(Number(f.properties.layer)));
  const H = [0.5, 0, -280, 0, -0.5, -120, 0, 0, 1], IH = inverse(H);
  const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage(); await page.addScriptTag({ path: SCRIPT });
    const cases = await page.evaluate(async ({ features, IH }) => {
      function rng(seed) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }
      async function make(spec) {
        const c = document.createElement('canvas'); c.width = 720; c.height = 720; const ctx = c.getContext('2d'), r = rng(spec.seed);
        const px = ctx.createImageData(c.width, c.height);
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const n = spec.noise ? (r() - .5) * 22 : 0, illum = spec.illumination ? 20 * (x / c.width) : 0; const i = 4 * (y * c.width + x); px.data[i] = px.data[i + 1] = px.data[i + 2] = Math.max(0, Math.min(255, 150 + n + illum)); px.data[i + 3] = 255; }
        ctx.putImageData(px, 0, 0);
        for (const f of features) { const ring = f.geometry.coordinates[0]; ctx.beginPath(); ring.forEach((p, i) => { const q = NumberedMarkerAlignment.project(IH, p); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.fillStyle = '#e7ee30'; ctx.fill(); }
        if (spec.flake) { ctx.fillStyle = 'rgba(30,95,140,.65)'; ctx.beginPath(); ctx.moveTo(305, 245); ctx.lineTo(560, 265); ctx.lineTo(510, 455); ctx.lineTo(340, 430); ctx.closePath(); ctx.fill(); }
        if (spec.clutter) { ctx.fillStyle = '#303030'; ctx.fillRect(30, 30, 70, 45); ctx.fillStyle = '#00aa88'; ctx.fillRect(600, 520, 80, 90); }
        const centers = [[-200,-200],[0,-200],[-200,-400],[0,-400]].map(p => NumberedMarkerAlignment.project(IH, p));
        if (spec.occlude >= 1) { ctx.fillStyle = '#969696'; ctx.fillRect(centers[0][0]-45, centers[0][1]-45, 90, 90); }
        if (spec.occlude >= 2) { ctx.fillStyle = '#969696'; ctx.fillRect(centers[1][0]-45, centers[1][1]-45, 90, 90); }
        const image = new Image(); image.src = c.toDataURL(); await image.decode();
        const result = await NumberedMarkerAlignment.align({ image, features });
        return { status: result.status, result };
      }
      return { clean: await make({ seed: 11 }), contaminated: await make({ seed: 22, noise: true, illumination: true, flake: true, clutter: true }), oneOccluded: await make({ seed: 33, noise: true, flake: true, occlude: 1 }), twoOccluded: await make({ seed: 44, noise: true, occlude: 2 }) };
    }, { features, IH });
    for (const key of ['clean', 'contaminated', 'oneOccluded']) { const r = cases[key].result; assert.equal(r.status, 'aligned', `${key}: ${r.reason}`); assert(r.boundaryRmsPx <= 2, `${key}: RMS ${r.boundaryRmsPx}`); }
    assert.equal(cases.twoOccluded.result.status, 'failed', 'two-marker occlusion must fail closed');
    console.log(JSON.stringify({ status: 'passed', cases: { clean: 'aligned', contaminated: 'aligned', oneOccluded: 'aligned', twoOccluded: 'failed' } }));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
