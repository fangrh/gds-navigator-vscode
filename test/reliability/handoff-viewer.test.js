#!/usr/bin/env node
'use strict';

// Normal-use handoff contract: a user selects layout targets, attaches or
// edits a drawing instruction, and copies the combined request to an agent.
const assert = require('assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
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
      const files = { '/tiny.json': null };
      let body, type;
      if (pathname === '/tiny.json') { body = JSON.stringify(TINY); type = 'application/json'; }
      else {
        const file = path.resolve(ROOT, pathname.replace(/^\/+/, ''));
        if (file !== ROOT && !file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
        body = fs.readFileSync(file); type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file).toLowerCase()] || 'application/octet-stream');
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  childProcess.execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-standalone.js')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  const { server, port } = await startServer();
  const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
    await page.goto(`http://127.0.0.1:${port}/webview/test-standalone.html?data=/tiny`, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.waitForFunction(() => Array.isArray(window.allFeatures) && window.allFeatures.length === 3, { timeout: 30000 });
    const result = await page.evaluate(() => {
      const fail = message => { throw new Error(message); };
      currentLayoutHash = 'hash-a';
      const a = allFeatures.find(f => f.get('elementId') === 'target-a');
      const b = allFeatures.find(f => f.get('elementId') === 'target-b');
      const c = allFeatures.find(f => f.get('elementId') === 'target-c');
      const linked = new ol.Feature({ geometry: new ol.geom.Polygon([[[10, 25], [30, 25], [30, 45], [10, 25]]]) });
      linked.set('isDrawn', true); linked.set('shapeType', 'polygon'); linked.set('annotationId', 'linked'); linked.set('selected', false);
      linked.set('intent', { action: 'move', text: 'move the linked pads', targetIds: ['target-a', 'target-b'], snapshot: 'hash-a' }); drawSource.addFeature(linked);

      // Mixed selection: two GDS targets and a drawing with an explicit action.
      addToSelection([a, b, linked]);
      document.getElementById('intent-action').value = 'move'; document.getElementById('intent-text').value = 'move the linked pads';
      const beforeMixed = window.__sent.length; copyYAML({ stopPropagation() {} });
      const mixed = window.__sent.slice(beforeMixed).find(m => m.type === 'exportYaml');
      if (!mixed) fail('mixed selection did not emit exportYaml');

      // Drawing-only selection must retain its target linkage while text is edited.
      clearSelection(); addToSelection([linked]);
      onSelectionChanged();
      document.getElementById('intent-action').value = 'move'; document.getElementById('intent-text').value = 'keep linked targets';
      document.getElementById('intent-apply').click();
      const appliedIntent = { action: linked.get('intent').action, text: linked.get('intent').text, targetIds: linked.get('intent').targetIds.slice(), snapshot: linked.get('intent').snapshot };
      document.getElementById('intent-text').value = 'inspect edge clearance';
      const beforeDrawing = window.__sent.length; copyYAML({ stopPropagation() {} });
      const drawingOnly = window.__sent.slice(beforeDrawing).find(m => m.type === 'exportYaml');
      if (!drawingOnly) fail('drawing-only selection did not emit exportYaml');

      const other = new ol.Feature({ geometry: new ol.geom.Circle([70, 35], 5) });
      other.set('isDrawn', true); other.set('shapeType', 'circle'); other.set('annotationId', 'other'); other.set('selected', false);
      other.set('intent', { action: 'add', text: 'add this circle', targetIds: ['target-c'], snapshot: 'hash-a' }); drawSource.addFeature(other);
      clearSelection(); addToSelection([linked, other]); onSelectionChanged();
      const beforeMultiple = window.__sent.length; copyYAML({ stopPropagation() {} });
      const multipleDrawings = window.__sent.slice(beforeMultiple).find(m => m.type === 'exportYaml');
      if (!multipleDrawings) fail('multiple drawings did not emit exportYaml');

      // A direct target combined with the drawing should preserve both target sets.
      clearSelection(); addToSelection([c, linked]);
      const beforeCombined = window.__sent.length; copyYAML({ stopPropagation() {} });
      const combined = window.__sent.slice(beforeCombined).find(m => m.type === 'exportYaml');
      if (!combined) fail('combined selection did not emit exportYaml');

      clearSelection(); addToSelection([c]); onSelectionChanged();
      document.getElementById('intent-action').value = 'inspect'; document.getElementById('intent-text').value = 'explain target C';
      const beforeGdsOnly = window.__sent.length; copyYAML({ stopPropagation() {} });
      const gdsOnly = window.__sent.slice(beforeGdsOnly).find(m => m.type === 'exportYaml');
      if (!gdsOnly) fail('GDS-only selection did not emit exportYaml');

      // Text focus must remain an editing operation, not a viewer shortcut.
      setMode('polygon'); const text = document.getElementById('intent-text'); text.focus();
      text.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
      const textMode = currentMode;

      // A layout reload with an old snapshot must make the target reviewable.
      const staleAnnotation = { id: 'stale', shapeType: 'polygon', geometry: { type: 'Polygon', coordinates: [[[10, 25], [30, 25], [30, 45], [10, 25]]] }, intent: { action: 'move', text: 'old request', targetIds: ['target-a'], snapshot: 'hash-a' } };
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'loadGds', geojson: { type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { element_id: 'target-a', layer: 1, data_type: 0, color: '#f38ba8' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]] } }
      ] }, gdsPath: 'tiny.gds', layoutHash: 'hash-b', annotations: [staleAnnotation], mode: 'full' } }));
      return { mixed, drawingOnly, multipleDrawings, combined, gdsOnly, appliedIntent, textMode, staleStatus: document.getElementById('workflow-status').textContent };
    });
    assert.equal(result.textMode, 'polygon', 'text focus triggered a viewer shortcut');
    assert.match(result.staleStatus, /Layout changed: review annotation targets\./, 'stale target warning missing after reload');
    assert.deepEqual(result.appliedIntent, { action: 'move', text: 'keep linked targets', targetIds: ['target-a', 'target-b'], snapshot: 'hash-a' }, 'Apply with drawing-only selection lost original target links');
    for (const [name, message] of Object.entries({ mixed: result.mixed, drawingOnly: result.drawingOnly, multipleDrawings: result.multipleDrawings, combined: result.combined, gdsOnly: result.gdsOnly })) {
      assert(message.components && message.components.length > 0, `${name} copy omitted selected components`);
      assert(message.request, `${name} copy omitted request payload`);
      assert.equal(message.request.snapshot, 'hash-a', `${name} snapshot mismatch`);
    }
    assert.equal(result.mixed.request.action, 'move', 'mixed action mismatch');
    assert.deepEqual(result.drawingOnly.request.targetIds.sort(), ['target-a', 'target-b'], 'drawing-only linkage was lost');
    assert.deepEqual(result.combined.request.targetIds.sort(), ['target-a', 'target-b', 'target-c'], 'mixed target linkage was not merged');
    assert.deepEqual(result.multipleDrawings.request.targetIds.sort(), ['target-a', 'target-b', 'target-c'], 'multiple drawing target linkage was not merged');
    assert.equal(result.multipleDrawings.request.action, 'inspect', 'multiple drawing toolbar state was unexpectedly copied into each drawing');
    assert.equal(result.drawingOnly.request.text, 'inspect edge clearance', 'edited drawing instruction was not copied');
    const copiedLinked = result.drawingOnly.components.find(c => c.drawn);
    assert.equal(copiedLinked.intent.text, 'inspect edge clearance', 'edited text was not written back to the drawing component');
    const copiedIntents = result.multipleDrawings.components.filter(c => c.drawn).map(c => c.intent).sort((a, b) => a.action.localeCompare(b.action));
    assert.deepEqual(copiedIntents.map(i => [i.action, i.text]), [['add', 'add this circle'], ['move', 'inspect edge clearance']], 'multiple drawing intents were overwritten');
    assert.equal(result.gdsOnly.request.action, 'inspect', 'GDS-only request action mismatch');
    assert.equal(result.gdsOnly.request.text, 'explain target C', 'GDS-only typed request text mismatch');
    assert.deepEqual(result.gdsOnly.request.targetIds, ['target-c'], 'GDS-only target linkage mismatch');
    assert.equal(errors.length, 0, `viewer page errors: ${errors.join(' | ')}`);
    console.log(JSON.stringify({ status: 'passed', checks: ['mixed-copy', 'drawing-linkage', 'instruction-edit', 'target-merge', 'stale-reload', 'text-shortcut-guard'] }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
