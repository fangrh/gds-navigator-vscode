#!/usr/bin/env node
'use strict';

// Browser conditions C21-C35: realistic handoff editing and persistence
// transitions layered on the normal-use viewer contract.
const assert = require('assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
const REPORT = path.join(ROOT, 'logs/reliability/conditions/viewer.json');
const BROWSER = [process.env.GDS_BROWSER, 'C:/Program Files/Microsoft Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(fs.existsSync);
assert(BROWSER, 'Edge/Chrome required; set GDS_BROWSER');

const TINY = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { element_id: 'target-a', layer: 1, data_type: 0, color: '#f38ba8', bbox: [0, 0, 20, 20], provenance: { file: 'layout.py', line: 10 } }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]] } },
  { type: 'Feature', properties: { element_id: 'target-b', layer: 1, data_type: 0, color: '#89b4fa', bbox: [40, 0, 60, 20], provenance: { file: 'layout.py', line: 11 } }, geometry: { type: 'Polygon', coordinates: [[[40, 0], [60, 0], [60, 20], [40, 20], [40, 0]]] } },
  { type: 'Feature', properties: { element_id: 'target-c', layer: 2, data_type: 0, color: '#a6e3a1', bbox: [80, 0, 100, 20], provenance: { file: 'layout.py', line: 12 } }, geometry: { type: 'Polygon', coordinates: [[[80, 0], [100, 0], [100, 20], [80, 20], [80, 0]]] } }
] };

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const file = path.resolve(ROOT, pathname.replace(/^\/+/, ''));
      if (file !== ROOT && !file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
      const type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  childProcess.execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-standalone.js')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  const { server, port } = await startServer();
  const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
  const cases = [];
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error.stack || error.message || error)));
    await page.goto(`http://127.0.0.1:${port}/webview/test-standalone.html?data=/test/fixtures/real_geojson`, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.waitForFunction(() => Array.isArray(window.allFeatures) && window.allFeatures.length > 0, { timeout: 30000 });
    const result = await page.evaluate(async tiny => {
      const checks = [];
      const fail = message => { throw new Error(message); };
      const assert = {
        equal: (actual, expected, message) => { if (actual !== expected) fail(message || `expected ${expected}, got ${actual}`); },
        deepEqual: (actual, expected, message) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(message || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
        match: (actual, expression, message) => { if (!expression.test(actual)) fail(message || `expected ${actual} to match ${expression}`); }
      };
      const poly = (x, y) => new ol.geom.Polygon([[[x, y], [x + 8, y], [x + 8, y + 8], [x, y], [x, y]]]);
      const load = (hash = 'hash-a', annotations = [], doc = 'tiny.gds') => { currentLayoutHash = hash; loadGdsData(tiny, doc, '', annotations, 'full'); };
      const drawing = (id, action = 'mark_region', text = id, targets = ['target-a'], snapshot = 'hash-a', documentPath = 'tiny.gds') => {
        const f = new ol.Feature({ geometry: poly(10 + id.length, 25) });
        f.set('isDrawn', true); f.set('shapeType', 'polygon'); f.set('annotationId', id); f.set('selected', false);
        f.set('intent', { action, text, targetIds: targets, snapshot, documentPath }); drawSource.addFeature(f); return f;
      };
      const selected = (...features) => { clearSelection(); addToSelection(features); onSelectionChanged(); };
      const copied = () => window.__sent.slice().reverse().find(m => m.type === 'exportYaml');
      const save = () => window.__sent.slice().reverse().find(m => m.type === 'saveAnnotations');
      const fresh = () => { load(); window.__sent.length = 0; };
      const run = (id, name, fn) => { try { fn(); checks.push({ id, name, status: 'passed' }); } catch (error) { checks.push({ id, name, status: 'failed', error: String(error.message || error) }); } };
      const a = () => allFeatures.find(f => f.get('elementId') === 'target-a');
      const b = () => allFeatures.find(f => f.get('elementId') === 'target-b');
      const c = () => allFeatures.find(f => f.get('elementId') === 'target-c');

      run('C21', 'keyboard editing keeps drawing mode while typing', () => {
        fresh(); setMode('polygon'); const text = document.getElementById('intent-text'); text.focus(); text.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
        assert.equal(currentMode, 'polygon');
      });
      run('C22', 'keyboard copy is blocked while editing request text', () => {
        fresh(); selected(a()); const text = document.getElementById('intent-text'); text.focus(); const before = window.__sent.length;
        text.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true })); assert.equal(window.__sent.length, before);
      });
      run('C23', 'multiple drawings retain independent actions', () => {
        fresh(); const first = drawing('first', 'move', 'move pad', ['target-a']); const second = drawing('second', 'add', 'add pad', ['target-b']); selected(first, second); const msg = (() => { copyYAML({ stopPropagation() {} }); return copied(); })();
        assert.deepEqual(msg.components.filter(x => x.drawn).map(x => [x.intent.action, x.intent.text]).sort(), [['add', 'add pad'], ['move', 'move pad']]);
      });
      run('C24', 'clear selection clears current request controls', () => {
        fresh(); selected(a()); document.getElementById('intent-action').value = 'delete'; document.getElementById('intent-text').value = 'delete this'; clearSelection();
        assert.equal(document.getElementById('intent-action').value, 'inspect'); assert.equal(document.getElementById('intent-text').value, '');
      });
      run('C25', 'current request copies direct GDS target', () => {
        fresh(); selected(b()); document.getElementById('intent-action').value = 'resize'; document.getElementById('intent-text').value = 'resize target b'; copyYAML({ stopPropagation() {} }); const msg = copied();
        assert.equal(msg.request.action, 'resize'); assert.deepEqual(msg.request.targetIds, ['target-b']); assert.equal(msg.request.text, 'resize target b');
      });
      run('C26', 'wrong-document linked target is excluded from request', () => {
        fresh(); const old = drawing('wrong-doc', 'delete', 'delete old pad', ['target-a'], 'hash-a', 'other.gds'); selected(old); copyYAML({ stopPropagation() {} }); const msg = copied();
        assert.deepEqual(msg.request.targetIds, []); assert.deepEqual(msg.components.find(x => x.drawn).intent.targetIds, ['target-a']);
      });
      run('C27', 'action edit preserves existing drawing linkage', () => {
        fresh(); const item = drawing('edit-action', 'move', 'move linked', ['target-a', 'target-b']); selected(item); document.getElementById('intent-action').value = 'delete'; document.getElementById('intent-text').value = 'delete linked'; document.getElementById('intent-apply').click();
        assert.deepEqual(item.get('intent'), { action: 'delete', text: 'delete linked', targetIds: ['target-a', 'target-b'], snapshot: 'hash-a', documentPath: 'tiny.gds' });
      });
      run('C28', 'copy transition writes edited drawing text back', () => {
        fresh(); const item = drawing('copy-edit', 'move', 'old text', ['target-a']); selected(item); document.getElementById('intent-text').value = 'new text'; copyYAML({ stopPropagation() {} });
        assert.equal(item.get('intent').text, 'new text'); assert.equal(copied().components.find(x => x.drawn).intent.text, 'new text');
      });
      run('C29', 'keyboard deletion removes drawing and persists empty set', () => {
        fresh(); const item = drawing('delete-key', 'mark_region', 'remove me', []); selected(item); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        assert.equal(drawSource.getFeatures().length, 0); assert.equal(selectedFeatures.getLength(), 0); assert.deepEqual(save().annotations, []);
      });
      run('C30', 'deleted drawing restores from saved annotation', () => {
        fresh(); const item = drawing('restore-me', 'move', 'restore this', ['target-a']); const annotation = { id: item.get('annotationId'), shapeType: 'polygon', geometry: { type: 'Polygon', coordinates: item.getGeometry().getCoordinates() }, intent: item.get('intent') }; deleteDrawn();
        load('hash-a', [annotation]); assert.equal(drawSource.getFeatures().length, 1); assert.equal(drawSource.getFeatures()[0].get('intent').text, 'restore this');
      });
      run('C31', 'deleting selected drawings removes only drawings', () => {
        fresh(); const one = drawing('delete-one', 'add', 'one', []); const two = drawing('delete-two', 'add', 'two', []); selected(a(), one, two); deleteDrawn();
        assert.equal(drawSource.getFeatures().length, 0); assert.equal(selectedFeatures.getLength(), 1); assert.equal(selectedFeatures.item(0).get('elementId'), 'target-a');
      });
      run('C32', 'stale annotation announces layout review', () => {
        fresh(); const stale = { id: 'stale', shapeType: 'polygon', geometry: { type: 'Polygon', coordinates: [[[1, 1], [3, 1], [3, 3], [1, 1]]] }, intent: { action: 'move', text: 'old', targetIds: ['target-a'], snapshot: 'old-hash', documentPath: 'tiny.gds' } }; load('new-hash', [stale]);
        assert.match(document.getElementById('workflow-status').textContent, /Layout changed: review annotation targets\./);
      });
      run('C33', 'drawing-only copy retains valid linked targets', () => {
        fresh(); const item = drawing('drawing-only', 'move', 'move linked', ['target-a', 'target-b']); selected(item); copyYAML({ stopPropagation() {} }); const msg = copied();
        assert.deepEqual(msg.request.targetIds.sort(), ['target-a', 'target-b']); assert.equal(msg.components.filter(x => !x.drawn).length, 0);
      });
      run('C34', 'mixed copy merges direct and valid drawing targets', () => {
        fresh(); const valid = drawing('valid-mix', 'move', 'move valid', ['target-a']); const wrong = drawing('wrong-mix', 'delete', 'delete old', ['target-b'], 'hash-a', 'other.gds'); selected(c(), valid, wrong); copyYAML({ stopPropagation() {} }); const msg = copied();
        assert.deepEqual(msg.request.targetIds.sort(), ['target-a', 'target-c']); assert.equal(msg.components.length, 3);
      });
      run('C35', 'escape exits drawing mode and clears selection', () => {
        fresh(); const item = drawing('escape', 'mark_region', 'escape', []); selected(item); setMode('polygon'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(currentMode, 'select'); assert.equal(selectedFeatures.getLength(), 0); assert.equal(document.getElementById('intent-text').value, '');
      });
      return { checks, pageErrors: window.__pageErrors || [] };
    }, TINY);
    for (const item of result.checks) cases.push(item);
    if (result.pageErrors.length || pageErrors.length) cases.push({ id: 'browser', name: 'page error guard', status: 'failed', error: [...result.pageErrors, ...pageErrors].join(' | ') });
  } finally {
    await browser.close(); await new Promise(resolve => server.close(resolve));
  }
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  const status = cases.length === 15 && cases.every(item => item.status === 'passed') ? 'passed' : 'failed';
  fs.writeFileSync(REPORT, JSON.stringify({ status, cases }, null, 2) + '\n');
  if (status !== 'passed') { console.error(JSON.stringify({ status, cases })); process.exitCode = 1; return; }
  console.log(JSON.stringify({ status, cases: cases.map(item => item.id), report: REPORT }));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
