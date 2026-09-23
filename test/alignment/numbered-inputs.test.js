#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { parseArgs } = require('./align-markers-direct');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'webview/numbered-marker-alignment.js');
const browserPath = process.env.GDS_BROWSER || ['C:/Program Files/Microsoft Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(fs.existsSync);
assert(browserPath, 'Edge/Chrome required; set GDS_BROWSER');

async function main() {
  assert.equal(parseArgs(['--gds', 'a', '--image', 'b', '--out', 'c', '--marker-appearance', 'dark', '--marker-layers', '1/0,8/0']).markerAppearance, 'dark');
  assert.throws(() => parseArgs(['--gds', 'a', '--image', 'b', '--out', 'c', '--marker-layers', '4/0']), /cannot include 4\/0/);
  const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ path: SCRIPT });
    const cases = await page.evaluate(async () => {
      const bad = await NumberedMarkerAlignment.align({ image: null, features: [] });
      const malformed = await NumberedMarkerAlignment.align({ image: {}, features: [{ properties: { layer: '1/0' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, NaN], [1, 1], [0, 0]]] } }] });
      const forbidden = await NumberedMarkerAlignment.align({ image: {}, features: [], options: { markerLayers: ['4/0'] } });
      const oversized = await NumberedMarkerAlignment.align({ image: { naturalWidth: 100000, naturalHeight: 100000 }, features: [] });
      let singular = false; try { NumberedMarkerAlignment.inverse([1, 2, 3, 2, 4, 6, 1, 2, 3]); } catch (_) { singular = true; }
      const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100; const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#888'; ctx.fillRect(0, 0, 200, 100); for (const x of [20, 90, 160]) { ctx.fillStyle = '#eee'; ctx.fillRect(x, 35, 20, 20); }
      const brightImage = new Image(); brightImage.src = canvas.toDataURL(); await brightImage.decode();
      const brightPads = NumberedMarkerAlignment.photoMarkers(brightImage, { markerAppearance: 'bright' }).pads.length;
      ctx.fillStyle = '#888'; ctx.fillRect(0, 0, 200, 100); for (const x of [20, 90, 160]) { ctx.fillStyle = '#222'; ctx.fillRect(x, 35, 20, 20); }
      const darkImage = new Image(); darkImage.src = canvas.toDataURL(); await darkImage.decode();
      const darkPads = NumberedMarkerAlignment.photoMarkers(darkImage, { markerAppearance: 'dark' }).pads.length;
      return { bad, malformed, forbidden, oversized, singular, brightPads, darkPads };
    });
    assert.equal(cases.bad.status, 'failed');
    assert.match(cases.bad.reason, /invalid dimensions|Image/);
    assert.equal(cases.malformed.reason, 'Non-finite polygon coordinate');
    assert.match(cases.forbidden.reason, /cannot include 4\/0/);
    assert.match(cases.oversized.reason, /pixel resource limit/);
    assert.equal(cases.singular, true);
    assert.equal(cases.brightPads, 3);
    assert.equal(cases.darkPads, 3);

    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/jj_pad_center_50_geo.json'), 'utf8'));
    const centers = [[-200, -200], [0, -200], [-200, -400], [0, -400]];
    const samples = fixture.features.filter(f => [1, 8, 9].includes(Number(f.properties.layer))).map(f => {
      const ring = f.geometry.coordinates[0], xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
      const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      return { f, group: centers.findIndex(p => b[0] >= p[0] - 11 && b[2] <= p[0] + 65 && b[1] >= p[1] - 60 && b[3] <= p[1] + 11) };
    }).filter(s => s.group >= 0);
    const ids = ['0,0', '0,-1', '1,0', '1,-1'].sort();
    const h = [0.5, 0, -280, 0, -0.5, -120, 0, 0, 1];
    function inverse(a) { const b = [a[4]*a[8]-a[5]*a[7], a[2]*a[7]-a[1]*a[8], a[1]*a[5]-a[2]*a[4], a[5]*a[6]-a[3]*a[8], a[0]*a[8]-a[2]*a[6], a[2]*a[3]-a[0]*a[5], a[3]*a[7]-a[4]*a[6], a[1]*a[6]-a[0]*a[7], a[0]*a[4]-a[1]*a[3]], d = a[0]*b[0] + a[1]*b[3] + a[2]*b[6]; return b.map(x => x / d); }
    // Render the actual vector marker geometry for each threshold mode and layer selection.
    for (const [mode, color, layers] of [['bright', '#eee', ['1/0', '8/0', '9/0']], ['dark', '#222', ['1/0', '8/0', '9/0']], ['yellow', '#e7ee30', ['1/0', '8/0', '9/0']]]) {
      const result = await page.evaluate(async ({ ss, features, inverseH, mode, color, layers }) => {
        const c = document.createElement('canvas'); c.width = 720; c.height = 720; const ctx = c.getContext('2d'); ctx.fillStyle = '#aaa'; ctx.fillRect(0, 0, 720, 720);
        for (const sample of ss) { ctx.beginPath(); sample.f.geometry.coordinates[0].forEach((p, i) => { const z = inverseH[6]*p[0] + inverseH[7]*p[1] + inverseH[8], x = (inverseH[0]*p[0] + inverseH[1]*p[1] + inverseH[2]) / z, y = (inverseH[3]*p[0] + inverseH[4]*p[1] + inverseH[5]) / z; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath(); ctx.fillStyle = color; ctx.fill(); }
        const image = new Image(); image.src = c.toDataURL(); await image.decode(); return NumberedMarkerAlignment.align({ image, features, options: { markerAppearance: mode, markerLayers: layers } });
      }, { ss: samples, features: fixture.features.filter(f => [1, 8, 9].includes(Number(f.properties.layer))), inverseH: inverse(h), mode, color, layers });
      assert.equal(result.status, 'aligned', `${mode}: ${result.reason}`); assert.deepEqual(result.markers.map(m => m.label).sort(), ids); assert(result.boundaryRmsPx <= 2); assert.deepEqual(result.selectedOptions.markerAppearance, mode);
    }
    const remapped = fixture.features.filter(f => [1, 8, 9].includes(Number(f.properties.layer))).map(f => ({ ...f, properties: { ...f.properties, layer: '12/0' } }));
    const custom = await page.evaluate(async ({ ss, features, inverseH }) => {
      const c = document.createElement('canvas'); c.width = 720; c.height = 720; const ctx = c.getContext('2d'); ctx.fillStyle = '#aaa'; ctx.fillRect(0, 0, 720, 720);
      for (const sample of ss) { ctx.beginPath(); sample.f.geometry.coordinates[0].forEach((p, i) => { const z = inverseH[6]*p[0] + inverseH[7]*p[1] + inverseH[8], x = (inverseH[0]*p[0] + inverseH[1]*p[1] + inverseH[2]) / z, y = (inverseH[3]*p[0] + inverseH[4]*p[1] + inverseH[5]) / z; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath(); ctx.fillStyle = '#e7ee30'; ctx.fill(); }
      const image = new Image(); image.src = c.toDataURL(); await image.decode(); return NumberedMarkerAlignment.align({ image, features, options: { markerLayers: ['12/0'] } });
    }, { ss: samples, features: remapped, inverseH: inverse(h) });
    assert.equal(custom.status, 'aligned', custom.reason); assert.deepEqual(custom.markers.map(m => m.label).sort(), ids); assert.equal(custom.selectedOptions.markerLayers[0], '12/0');
    console.log(JSON.stringify({ status: 'passed', cases: 5 }));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
