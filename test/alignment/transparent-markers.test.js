#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { closeOwnedBrowser } = require('../../scripts/process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '../..');
const ALIGNMENT = fs.readFileSync(path.join(ROOT, 'webview/numbered-marker-alignment.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(ROOT, 'webview/numbered-marker-worker.js'), 'utf8');
const browserPath = process.env.GDS_BROWSER || [
  path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
  'C:/Program Files/Microsoft Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'
].find(fs.existsSync);
assert(browserPath && fs.existsSync(browserPath), 'Set GDS_BROWSER or install the pinned Playwright browser');

async function main() {
  const reportDir = path.resolve(process.env.GDS_TRANSPARENT_MARKERS_REPORT_DIR || path.join(ROOT, 'logs', 'numbered-markers', 'transparent'));
  fs.mkdirSync(reportDir, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(reportDir, 'profile-'));
  let browser, shutdown, details, shutdownError = null, status = 'failed', error = null;
  try {
    browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: profileDir });
    const page = await browser.newPage();
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    await page.addScriptTag({ content: ALIGNMENT });
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/jj_pad_center_50_geo.json'), 'utf8'));
    const selectedFeatures = fixture.features.filter(f => [1, 8, 9].includes(Number(f.properties.layer)));
    const cases = await page.evaluate(async ({ selectedFeatures, alignment, worker }) => {
      const source = color => {
        const c = document.createElement('canvas'); c.width = 200; c.height = 100;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (color === 'gray') { ctx.fillStyle = '#888'; ctx.fillRect(0, 0, 200, 100); }
        ctx.fillStyle = '#222'; for (const x of [20, 90, 160]) ctx.fillRect(x, 35, 20, 20);
        const bg = Array.from(ctx.getImageData(0, 0, 1, 1).data);
        const square = Array.from(ctx.getImageData(20, 35, 1, 1).data);
        if (ctx.isContextLost() || String(bg) !== (color === 'gray' ? '136,136,136,255' : '0,0,0,0') || String(square) !== '34,34,34,255')
          throw Error('Invalid source raster: ' + JSON.stringify({ color, contextLost: ctx.isContextLost(), bg, square }));
        const image = new Image(); image.src = c.toDataURL(); return { image, source: { bg, square } };
      };
      const blankCanvas = document.createElement('canvas'); blankCanvas.width = 200; blankCanvas.height = 100;
      const blankCtx = blankCanvas.getContext('2d', { willReadFrequently: true });
      if (String(Array.from(blankCtx.getImageData(0, 0, 1, 1).data)) !== '0,0,0,0') throw Error('Invalid blank raster');
      const blank = new Image(); blank.src = blankCanvas.toDataURL(); await blank.decode();
      const transparent = source('transparent'), gray = source('gray');
      await transparent.image.decode(); await gray.image.decode();
      const transparentPads = NumberedMarkerAlignment.photoMarkers(transparent.image, { markerAppearance: 'dark' });
      const grayPads = NumberedMarkerAlignment.photoMarkers(gray.image, { markerAppearance: 'dark' });
      const semiCanvas = document.createElement('canvas'); semiCanvas.width = 200; semiCanvas.height = 100;
      const semiCtx = semiCanvas.getContext('2d', { willReadFrequently: true }); semiCtx.fillStyle = 'rgba(34,34,34,.5)'; for (const x of [20, 90, 160]) semiCtx.fillRect(x, 35, 20, 20);
      if (semiCtx.isContextLost() || String(Array.from(semiCtx.getImageData(20, 35, 1, 1).data)) !== '34,34,34,128') throw Error('Invalid semitransparent raster');
      const semi = new Image(); semi.src = semiCanvas.toDataURL(); await semi.decode();
      const summary = value => ({ w: value.w, h: value.h, pads: value.pads.map(p => ({ center: p.center, width: p.width, boundary: p.boundary })) });
      const semiPads = summary(NumberedMarkerAlignment.photoMarkers(semi, { markerAppearance: 'dark' }));
      const blankPads = summary(NumberedMarkerAlignment.photoMarkers(blank, { markerAppearance: 'dark' }));
      const h = [0.5, 0, -280, 0, -0.5, -120, 0, 0, 1];
      const inv = a => { const b = [a[4]*a[8]-a[5]*a[7], a[2]*a[7]-a[1]*a[8], a[1]*a[5]-a[2]*a[4], a[5]*a[6]-a[3]*a[8], a[0]*a[8]-a[2]*a[6], a[2]*a[3]-a[0]*a[5], a[3]*a[7]-a[4]*a[6], a[1]*a[6]-a[0]*a[7], a[0]*a[4]-a[1]*a[3]]; const d = a[0]*b[0] + a[1]*b[3] + a[2]*b[6]; return b.map(x => x / d); };
      const inverseH = inv(h);
      const renderImage = async color => {
        const c = document.createElement('canvas'); c.width = 720; c.height = 720; const ctx = c.getContext('2d', { willReadFrequently: true });
        if (color === 'gray') { ctx.fillStyle = '#aaa'; ctx.fillRect(0, 0, 720, 720); }
        for (const f of selectedFeatures) { const ring = f.geometry.coordinates[0]; ctx.beginPath(); ring.forEach((p, i) => { const z = inverseH[6]*p[0] + inverseH[7]*p[1] + inverseH[8], x = (inverseH[0]*p[0] + inverseH[1]*p[1] + inverseH[2]) / z, y = (inverseH[3]*p[0] + inverseH[4]*p[1] + inverseH[5]) / z; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); ctx.fillStyle = '#222'; ctx.fill(); }
        const pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data);
        if (ctx.isContextLost() || String(pixel) !== (color === 'gray' ? '170,170,170,255' : '0,0,0,0')) throw Error('Invalid vector raster: ' + JSON.stringify({ color, contextLost: ctx.isContextLost(), pixel }));
        const image = new Image(); image.src = c.toDataURL(); await image.decode(); return image;
      };
      const alignImage = image => NumberedMarkerAlignment.align({ image, features: selectedFeatures, options: { markerAppearance: 'dark', markerLayers: ['1/0', '8/0', '9/0'] } });
      const grayImage = await renderImage('gray'), transparentImage = await renderImage('transparent');
      const grayResult = await alignImage(grayImage), transparentResult = await alignImage(transparentImage);
      const workerUrl = URL.createObjectURL(new Blob([alignment, worker], { type: 'text/javascript' }));
      const task = new Worker(workerUrl); URL.revokeObjectURL(workerUrl);
      let workerResult;
      try {
        const bitmap = await createImageBitmap(transparentImage);
        workerResult = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Transparent-marker worker timed out')), 30000);
          task.onerror = e => { clearTimeout(timer); reject(Error(e.message)); };
          task.onmessage = e => e.data.type === 'result' ? (clearTimeout(timer), resolve(e.data.result)) : e.data.type === 'error' ? (clearTimeout(timer), reject(Error(e.data.message))) : null;
          task.postMessage({ type: 'align', requestId: 1, imageBitmap: bitmap, features: selectedFeatures, options: { markerAppearance: 'dark', markerLayers: ['1/0', '8/0', '9/0'] } }, [bitmap]);
        });
      } finally { task.terminate(); }
      const blankResult = await NumberedMarkerAlignment.align({ image: blank, features: selectedFeatures, options: { markerAppearance: 'dark', markerLayers: ['1/0', '8/0', '9/0'] } });
      return { transparentPads: summary(transparentPads), grayPads: summary(grayPads), semiPads, blankPads, blankResult, grayResult, transparentResult, workerResult, source: { transparent: transparent.source, gray: gray.source } };
    }, { selectedFeatures, alignment: ALIGNMENT, worker: WORKER });
    details = { source: cases.source, padCounts: { transparent: cases.transparentPads.pads.length, gray: cases.grayPads.pads.length, semi: cases.semiPads.pads.length, blank: cases.blankPads.pads.length }, transparentResult: cases.transparentResult, grayResult: cases.grayResult, workerResult: cases.workerResult, blankResult: cases.blankResult, pageErrors };
    assert.equal(cases.transparentPads.pads.length, 3);
    assert.deepEqual(cases.transparentPads.pads.map(p => p.center), cases.grayPads.pads.map(p => p.center));
    assert.deepEqual(cases.transparentPads.pads.map(p => p.width), cases.grayPads.pads.map(p => p.width));
    assert.deepEqual(cases.transparentPads.pads.map(p => p.boundary), cases.grayPads.pads.map(p => p.boundary));
    assert.equal(cases.blankPads.pads.length, 0);
    assert.equal(cases.blankResult.status, 'failed');
    assert.equal(cases.blankResult.transform, undefined);
    assert.equal(cases.semiPads.pads.length, 3);
    assert.equal(cases.transparentResult.status, 'aligned', cases.transparentResult.reason);
    assert.equal(cases.grayResult.status, 'aligned', cases.grayResult.reason);
    const geometry = result => ({ model: result.model, transform: result.transform, markers: result.markers.map(m => ({ label: m.label, imageCenter: m.imageCenter, layoutCenter: m.layoutCenter, boundaryRmsPx: m.boundaryRmsPx })) });
    assert.deepEqual(geometry(cases.transparentResult), geometry(cases.grayResult));
    assert.deepEqual(cases.transparentResult.markers.map(m => m.label).sort(), ['0,-1', '0,0', '1,-1', '1,0']);
    assert(cases.transparentResult.boundaryRmsPx <= 2);
    assert(cases.transparentResult.labelScore >= .65 && cases.transparentResult.labelMargin >= .025);
    assert.deepEqual(cases.workerResult, cases.transparentResult);
    assert.deepEqual(cases.source.transparent.bg, [0, 0, 0, 0]);
    assert.deepEqual(cases.source.gray.bg, [136, 136, 136, 255]);
    assert.deepEqual(pageErrors, []);
    status = 'passed';
  } catch (e) { error = { name: e.name, message: e.message, stack: e.stack }; throw e;
  } finally {
    try { if (browser) { shutdown = await closeOwnedBrowser(browser, { profileDir }); assert.equal(shutdown.verified, true, 'Owned browser shutdown must be verified'); } }
    catch (e) { shutdownError = String(e.stack || e); throw e; }
    finally { const finalStatus = status === 'passed' && shutdown?.verified && !shutdownError ? 'passed' : 'failed'; fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({ status: finalStatus, error, shutdownError, details, shutdown, shutdownVerified: shutdown?.verified ?? false, survivors: shutdown?.survivors ?? [], reportDir }, null, 2)); if (finalStatus === 'passed') fs.rmSync(profileDir, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify({ status: 'passed', pads: 3, vectorMarkers: 4, workerParity: true }));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
