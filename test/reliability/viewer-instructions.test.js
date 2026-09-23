#!/usr/bin/env node
'use strict';

// Viewer contract checks.  This deliberately drives the standalone harness
// instead of importing viewer internals into Node.
const assert = require('assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
const DATA = path.join(ROOT, 'test/fixtures/real_geojson.json');
const browserCandidates = [process.env.GDS_BROWSER, 'C:/Program Files/Microsoft Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
const browserPath = browserCandidates.find(fs.existsSync);
assert(browserPath, 'Edge/Chrome required; set GDS_BROWSER');

function contentType(file) {
  return { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
}
function inside(file) { return file === ROOT || file.startsWith(ROOT + path.sep); }
function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const relative = url.pathname === '/data.json' ? 'test/fixtures/real_geojson.json' : url.pathname.replace(/^\/+/, '');
        const file = path.resolve(ROOT, relative);
        if (!inside(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': 'no-store' }); fs.createReadStream(file).pipe(res);
      } catch (e) { res.writeHead(400); res.end(String(e.message || e)); }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  childProcess.execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-standalone.js')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  const { server, port } = await startServer();
  const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--no-first-run'] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error.stack || error.message || error)));
    await page.goto(`http://127.0.0.1:${port}/webview/test-standalone.html?data=/data`, { waitUntil: 'networkidle0', timeout: 120000 });
    try { await page.waitForFunction(() => Array.isArray(window.allFeatures) && window.allFeatures.length > 0, { timeout: 15000 }); }
    catch (error) { throw new Error(`${error.message}; page errors: ${pageErrors.join(' | ')}`); }
    const result = await page.evaluate(async () => {
      const fail = (message) => { throw new Error(message); };
      currentLayoutHash = 'hash-a';
      const corpusFeatures = allFeatures.slice();
      const target = allFeatures[0];
      addToSelection([target]);
      document.getElementById('intent-action').value = 'move';
      document.getElementById('intent-text').value = 'move selected target by 5 um';

      const original = [[0, 0], [10, 0], [10, 20], [0, 20], [0, 0]];
      const drawing = new ol.Feature({ geometry: new ol.geom.Polygon([original]) });
      drawing.set('isDrawn', true); drawing.set('shapeType', 'polygon'); drawing.set('annotationId', 'test-shape'); drawing.set('selected', false);
      drawSource.addFeature(drawing); addToSelection([drawing]);
      document.getElementById('intent-apply').click();
      persistAnnotations();
      const saved1 = window.__sent.filter(m => m.type === 'saveAnnotations').pop();
      if (!saved1 || JSON.stringify(saved1.annotations[0].geometry.coordinates) !== JSON.stringify([original])) fail('initial exact polygon geometry was not serialized');
      if (saved1.annotations[0].intent.action !== 'move' || saved1.annotations[0].intent.snapshot !== 'hash-a' || saved1.annotations[0].intent.targetIds.length !== 1) fail('explicit drawing intent was not attached');

      const modified = [[0, 0], [12, 0], [12, 20], [0, 20], [0, 0]];
      drawing.getGeometry().setCoordinates([modified]); modifyInteraction.dispatchEvent({ type: 'modifyend' });
      const saved2 = window.__sent.filter(m => m.type === 'saveAnnotations').pop();
      if (JSON.stringify(saved2.annotations[0].geometry.coordinates) !== JSON.stringify([modified])) fail('modified geometry was not serialized exactly');
      drawing.getGeometry().translate(3, -4); translateInteraction.dispatchEvent({ type: 'translateend' });
      const moved = modified.map(([x, y]) => [x + 3, y - 4]);
      const saved3 = window.__sent.filter(m => m.type === 'saveAnnotations').pop();
      if (JSON.stringify(saved3.annotations[0].geometry.coordinates) !== JSON.stringify([moved])) fail('translated geometry was not serialized exactly');

      const malformed = { id: 'bad', shapeType: 'polygon', geometry: null, intent: null };
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'loadGds', geojson: { type: 'FeatureCollection', features: [] }, gdsPath: 'standalone.gds', layoutHash: 'hash-b', annotations: [malformed], mode: 'full' } }));
      const malformedStatus = document.getElementById('workflow-status').textContent;
      const malformedSkipped = drawSource.getFeatures().length === 0;
      const stale = { id: 'stale', shapeType: 'polygon', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, intent: { action: 'move', text: 'old target', targetIds: ['missing'], snapshot: 'hash-old' } };
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'loadGds', geojson: { type: 'FeatureCollection', features: [] }, gdsPath: 'standalone.gds', layoutHash: 'hash-new', annotations: [stale], mode: 'full' } }));
      const staleStatus = document.getElementById('workflow-status').textContent;

      setMode('polygon');
      const text = document.getElementById('intent-text'); text.focus(); text.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
      const inputMode = currentMode;
      const beforeCopy = window.__sent.length; text.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true }));
      const inputMessages = window.__sent.length - beforeCopy;
      const small = document.createElement('canvas'); small.width = 8; small.height = 8;
      const workerResponse = await solveInWorker(small, [], MicroscopeOverlay.defaultOptions());
      const previousWorkerSource = window.numberedMarkerWorkerSource;
      window.numberedMarkerWorkerSource = 'self.onmessage=function(){while(true){}};';
      const canceledPromise = solveInWorker(small, [], MicroscopeOverlay.defaultOptions()).then(() => 'resolved').catch(e => String(e.message || e));
      await new Promise(resolve => setTimeout(resolve, 30)); cancelAlignment();
      const canceledResult = await canceledPromise; window.numberedMarkerWorkerSource = previousWorkerSource;
      window.numberedMarkerWorkerSource = 'self.onmessage=function(){while(true){}};';
      const savedImage = microImg, savedFeatures = corpusFeatures.slice();
      const retained = { img: small, cx: 123, cy: 456, umPerPx: .5, rotDeg: 7, opacity: .5, visible: true, locked: true, imageId: null, options: MicroscopeOverlay.defaultOptions(), quality: { status: 'unverified', boundaryRmsPx: null, markerCount: 0 }, markerTransform: null, markerPose: null };
      microImg = retained; allFeatures = savedFeatures.length ? savedFeatures : [{ get: () => '1/0', getGeometry: () => ({ getType: () => 'Polygon', getCoordinates: () => [] }) }];
      const beforePlacement = { cx: retained.cx, cy: retained.cy, umPerPx: retained.umPerPx, rotDeg: retained.rotDeg };
      const autoCanceled = autoAlignMicroImage(); await new Promise(resolve => setTimeout(resolve, 30)); cancelAlignment(); await autoCanceled;
      const placementPreserved = JSON.stringify(beforePlacement) === JSON.stringify({ cx: retained.cx, cy: retained.cy, umPerPx: retained.umPerPx, rotDeg: retained.rotDeg });
      microImg = savedImage; allFeatures = savedFeatures; window.numberedMarkerWorkerSource = previousWorkerSource;
      const large = document.createElement('canvas'); large.width = 4000; large.height = 4000;
      const geometry = savedFeatures.map(f => ({ type: 'Feature', properties: { layer: f.get('layer') }, geometry: { type: f.getGeometry().getType(), coordinates: f.getGeometry().getCoordinates() } }));
      let heartbeat = 0; const heartbeatTimer = setInterval(() => { heartbeat++; }, 25); const started = performance.now();
      const boundedResult = await solveInWorker(large, geometry, MicroscopeOverlay.defaultOptions());
      const elapsedMs = performance.now() - started; clearInterval(heartbeatTimer);
      const heap = performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : null;
      return { initialExact: true, modifiedExact: true, translatedExact: true, malformedStatus, malformedSkipped, staleStatus, inputMode, inputMessages, workerResponse: workerResponse.status, canceledResult, placementPreserved, boundedStatus: boundedResult.status, boundedReason: boundedResult.reason, elapsedMs, heartbeat, heap };
    });
    assert.equal(result.inputMode, 'polygon', 'keyboard shortcut changed drawing mode while editing text');
    assert.equal(result.inputMessages, 0, 'copy hotkey fired while editing text');
    assert.equal(result.workerResponse, 'failed', 'worker did not return a bounded solver result');
    assert.match(result.canceledResult, /canceled/i, 'worker cancellation did not reject the active solve');
    assert.equal(result.placementPreserved, true, 'canceled alignment changed the prior placement');
    assert.equal(result.boundedStatus, 'failed', `near-16MP blank image did not fail closed: ${result.boundedReason || 'unknown reason'}`);
    assert(result.elapsedMs < 60000, `near-16MP blank worker exceeded bounded runtime: ${result.elapsedMs} ms`);
    assert(result.heartbeat > 0, 'near-16MP worker solve blocked the viewer event loop');
    assert.equal(result.malformedSkipped, true, 'malformed annotation was restored into the drawing source');
    assert.match(result.staleStatus, /Layout changed: review annotation targets\./, 'stale target warning missing');
    assert.match(result.malformedStatus,/invalid annotation/i,'malformed annotation warning was hidden');
    assert.equal(pageErrors.length, 0, `viewer page errors: ${pageErrors.join(' | ')}`);
    console.log(JSON.stringify({ status: 'passed', checks: ['explicit-intent', 'exact-geometry', 'modify-translate-cache', 'malformed-annotation', 'stale-target-warning', 'input-hotkeys', 'worker-response', 'worker-cancel', 'near-16MP-bound'], bounded: { status: result.boundedStatus, reason: result.boundedReason, elapsedMs: Math.round(result.elapsedMs), heartbeat: result.heartbeat, heap: result.heap } }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
