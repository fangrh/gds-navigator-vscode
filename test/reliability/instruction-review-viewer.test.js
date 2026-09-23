#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
const BROWSER = [process.env.GDS_BROWSER, 'C:/Program Files/Microsoft Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(fs.existsSync);
assert(BROWSER, 'Edge/Chrome required; set GDS_BROWSER');
const TINY = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { element_id: 'target-a', layer: 1, data_type: 0, color: '#f38ba8', bbox: [0, 0, 20, 20] }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]] } },
  { type: 'Feature', properties: { element_id: 'target-b', layer: 2, data_type: 1, color: '#89b4fa', bbox: [40, 0, 60, 20] }, geometry: { type: 'Polygon', coordinates: [[[40, 0], [60, 0], [60, 20], [40, 20], [40, 0]]] } }
] };
function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      let body, type;
      if (pathname === '/tiny.json') { body = JSON.stringify(TINY); type = 'application/json'; }
      else {
        const file = path.resolve(ROOT, pathname.replace(/^\/+/, ''));
        if ((file !== ROOT && !file.startsWith(ROOT + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
        body = fs.readFileSync(file); type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file).toLowerCase()] || 'application/octet-stream');
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
async function main() {
  cp.execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-standalone.js')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  const out = path.join(ROOT, 'logs/reliability/instruction-review'); fs.mkdirSync(out, { recursive: true });
  const { server, port } = await startServer(); const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 950 }); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/webview/test-standalone.html?data=/tiny`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => allFeatures.length === 2);
    await page.evaluate(() => { currentLayoutHash = 'hash-a'; });
    const layout = await page.evaluate(() => ({ map: document.getElementById('map').getBoundingClientRect().toJSON(), bar: document.getElementById('instruction-bar').getBoundingClientRect().toJSON(), controls: document.getElementById('primitive-controls').getBoundingClientRect().toJSON() }));
    assert(layout.bar.bottom >= layout.map.bottom - 2, 'composer is not below the map');

    await page.evaluate(() => { replaceSelection([allFeatures[0]]); document.getElementById('intent-action').value = 'move'; document.getElementById('intent-text').value = 'Move selected target'; });
    await page.click('#queue-instruction'); const queued = await page.evaluate(() => window.__sent.filter(m => m.type === 'instructionAction' && m.action === 'add').at(-1));
    assert.equal(queued.layoutHash, 'hash-a'); assert.equal(queued.request.text, 'Move selected target'); assert.deepEqual(queued.request.targetIds, ['target-a']); assert.equal(queued.components[0].geometry.coordinates[0].length, 5);

    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'instructions', location: 'workspace', records: [
      { id: 'req-2', sequence: 2, status: 'open', request: { text: 'second' }, context: { geometry: { n: 2 } } },
      { id: 'req-1', sequence: 1, status: 'done', request: { text: 'first' }, context: { geometry: { n: 1 } } }
    ] } })));
    await page.click('#instruction-list-btn'); const review = await page.evaluate(() => [...document.querySelectorAll('#instruction-records article')].map(x => ({ text: x.textContent, ids: [...x.querySelectorAll('button')].map(b => [b.dataset.id, b.dataset.action]) })));
    assert.deepEqual(review.map(x => x.ids[0][0]), ['req-1', 'req-2']); assert(review.every(x => x.ids.some(b => b[1] === 'copyRef') && x.ids.some(b => b[1] === 'revert')));
    await page.click('#instruction-records article:nth-child(2) button[data-action="copyRef"]');
    assert.equal((await page.evaluate(() => window.__sent.filter(m => m.type === 'instructionAction').at(-1))).id, 'req-2');

    const saved = { id: 'draw-1', shapeType: 'polygon', geometry: { type: 'Polygon', coordinates: [[[1, 1], [5, 1], [5, 4], [1, 1]]] }, layer: '7/3', factory: { name: 'straight', settings: { length: 12 } }, intent: { action: 'add', text: 'saved', targetIds: ['target-a'], snapshot: 'hash-a', documentPath: 'standalone.gds' } };
    await page.evaluate(annotation => window.dispatchEvent(new MessageEvent('message', { data: { type: 'restoreAnnotations', layoutHash: 'hash-a', annotations: [annotation] } })), saved);
    assert.equal(await page.evaluate(() => drawSource.getFeatures().length), 1); assert.equal(await page.evaluate(() => drawSource.getFeatures()[0].get('factory').name), 'straight');
    await page.evaluate(() => { replaceSelection([drawSource.getFeatures()[0]]); document.getElementById('intent-text').value = 'edited saved request'; copyYAML(); });
    const edited = await page.evaluate(() => window.__sent.filter(m => m.type === 'exportYaml').at(-1)); assert.equal(edited.components[0].factory.name, 'straight'); assert.equal(edited.components[0].layer, '7/3'); assert.deepEqual(edited.components[0].geometry, saved.geometry);

    await page.click('#instructions-close'); await page.click('#shape-menu-btn');
    const visibleControls = await page.$eval('#primitive-controls', el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
    assert(visibleControls.top >= layout.map.top - 2 && visibleControls.bottom <= layout.map.bottom + 2, 'shape chooser is outside the map area');
    const catalogReq = await page.evaluate(() => window.__sent.filter(m => m.type === 'requestComponentCatalog').at(-1));
    await page.evaluate(id => window.dispatchEvent(new MessageEvent('message', { data: { type: 'componentCatalog', requestId: id, result: { components: [{ name: 'straight', description: 'Straight factory', parameters: [{ name: 'length', required: false, default: 10 }] }] } } })), catalogReq.requestId);
    await page.type('#component-catalog input[type=search]', 'straight'); await page.click('#component-catalog [role=option]'); const settings = await page.$eval('#component-catalog textarea', el => { el.value = '{"length":12}'; return el.value; }); assert.equal(settings, '{"length":12}'); await page.$$eval('#component-catalog button', buttons => buttons.find(button => button.textContent === 'Preview component').click());
    const previewReq = await page.evaluate(() => window.__sent.filter(m => m.type === 'previewComponent').at(-1)); assert.equal(previewReq.name, 'straight'); assert.deepEqual(previewReq.settings, { length: 12 });
    const previewResult = { name: 'straight', settings: { length: 12 }, geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { layer: 9, data_type: 2 }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [8, 0], [8, 2], [0, 2], [0, 0]]] } }] } };
    await page.evaluate(({ id, result }) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'componentPreview', requestId: id, result } })), { id: previewReq.requestId, result: previewResult });
    const beforeStale = await page.evaluate(() => drawSource.getFeatures().length); await page.evaluate(() => { currentLayoutHash = 'hash-b'; }); await page.$$eval('#component-catalog button', buttons => buttons.find(button => button.textContent === 'Insert at view center').click());
    assert.equal(await page.evaluate(() => drawSource.getFeatures().length), beforeStale); assert.match(await page.$eval('#workflow-status', el => el.textContent), /Layout changed/);
    await page.screenshot({ path: path.join(out, 'viewer.png') }); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ status: 'passed', queueSnapshot: true, orderedReview: true, restore: true, metadataPreserved: true, catalogPreview: true, stalePreviewRejected: true }, null, 2));
    console.log('Instruction review, annotation restore, and catalog preview browser tests passed');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
