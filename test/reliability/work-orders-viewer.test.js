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
  [1, 0, 0, 0, 18, 18, 'target-a'], [2, 0, 24, 0, 12, 10, 'target-b'], [3, 1, -20, 0, 8, 14, 'target-c']
].map(([layer, data_type, x, y, w, h, element_id], i) => ({ type: 'Feature', properties: { element_id, layer, data_type, color: ['#f38ba8', '#89b4fa', '#a6e3a1'][i] }, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]] } })) };

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      let body, type;
      if (pathname === '/tiny.json') { body = JSON.stringify(TINY); type = 'application/json'; }
      else {
        const file = path.resolve(ROOT, pathname.replace(/^\/+/, ''));
        if ((file !== ROOT && !file.startsWith(ROOT + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
        body = fs.readFileSync(file); type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file).toLowerCase()] || 'application/octet-stream');
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  cp.execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-standalone.js')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  const out = path.join(ROOT, 'logs/reliability/work-orders-viewer'); fs.mkdirSync(out, { recursive: true });
  const { server, port } = await startServer();
  const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e.stack || e.message || e)));
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/webview/test-standalone.html?data=/tiny`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => Array.isArray(window.allFeatures) && window.allFeatures.length === 3);
    await page.waitForSelector('#work-order-heading');
    assert.match(await page.$eval('#work-order-heading', el => el.textContent.trim()), /work order/i);
    assert(await page.$('#work-order-targets'), 'work-order target summary missing');
    assert(await page.$('.work-order-context') && await page.$('.work-order-input'), 'composer context/input wrappers missing');
    assert(await page.$('.work-order-actions') && await page.$('.work-order-secondary'), 'composer action rows missing');
    assert(await page.$('#composer-hint'), 'composer shortcut hint missing');
    assert.deepEqual(await page.$eval('#intent-text', el => (el.getAttribute('aria-describedby') || '').split(/\s+/).sort()), ['composer-hint', 'work-order-targets']);
    assert.equal(await page.$eval('#queue-instruction', el => el.textContent.trim()), 'Add work order');
    assert(await page.$('#instruction-list #instruction-records'), 'stable instruction records container missing');

    // Select by an actual map click, then queue the draft through the UI.
    await page.evaluate(() => { map.updateSize(); map.getView().fit([0, 0, 42, 20], { size: map.getSize(), padding: [80, 80, 80, 80], duration: 0 }); map.renderSync(); });
    const click = await page.evaluate(() => { const p = map.getPixelFromCoordinate([9, 9]); const r = map.getTargetElement().getBoundingClientRect(); return [p[0] + r.left, p[1] + r.top]; });
    await page.mouse.click(...click);
    await page.waitForFunction(() => selectedFeatures.getLength() === 1 && selectedFeatures.item(0).get('elementId') === 'target-a');
    await page.type('#intent-text', 'Add a work-order test marker');
    await page.keyboard.press('Enter'); await page.type('#intent-text', 'with a second line');
    const before = await page.evaluate(() => ({ selected: selectedFeatures.getArray().map(f => f.get('elementId')), text: document.querySelector('#intent-text').value }));
    assert(before.text.includes('\n'), 'Enter should insert a newline in the requirement');
    const beforeComposing = await page.evaluate(() => window.__sent.filter(m => m.type === 'instructionAction' && m.action === 'add').length);
    await page.evaluate(() => document.querySelector('#intent-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })));
    assert.equal(await page.evaluate(() => window.__sent.filter(m => m.type === 'instructionAction' && m.action === 'add').length), beforeComposing, 'composing shortcut submitted the work order');
    await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
    const queued = await page.evaluate(() => window.__sent.filter(m => m.type === 'instructionAction' && m.action === 'add').at(-1));
    assert(queued, 'queue click did not send instructionAction');
    assert.equal(queued.workOrder, true); assert.equal(queued.type, 'instructionAction'); assert.equal(queued.action, 'add');
    assert.match(queued.requestId, /^work-order-[a-z0-9-]{10,}$/i); assert.equal(queued.request.text, before.text); assert.deepEqual(queued.request.targetIds, before.selected);
    assert.equal(queued.request.documentPath, 'standalone.gds'); assert.equal(queued.request.snapshot, null);
    assert(queued.components.length >= 1 && queued.components[0].geometry, 'queued component geometry missing');
    const frozen = JSON.parse(JSON.stringify(queued));

    // A pending request blocks duplicates and owns a frozen selection snapshot.
    await page.evaluate(() => replaceSelection([allFeatures[1] ]));
    await page.click('#queue-instruction');
    assert.equal(await page.evaluate(() => window.__sent.filter(m => m.type === 'instructionAction' && m.action === 'add').length), 1, 'duplicate click sent a second pending request');
    assert.deepEqual(await page.evaluate(() => window.__sent.find(m => m.type === 'instructionAction' && m.action === 'add')), frozen, 'request changed after selection changed');
    assert.deepEqual(await page.evaluate(() => selectedFeatures.getArray().map(f => f.get('elementId'))), ['target-b'], 'selection changed across queued request');

    // Matching acknowledgement clears only the untouched draft and opens Changes / Work orders.
    await page.evaluate(requestId => window.dispatchEvent(new MessageEvent('message', { data: { type: 'instructionAdded', requestId, id: 'INS-000001-abcd1234', gdsPath: 'standalone.gds' } })), queued.requestId);
    await page.waitForFunction(() => document.querySelector('#instruction-list').hidden === false);
    assert.equal(await page.$eval('#intent-text', el => el.value), '', 'ack did not clear untouched draft');
    assert.equal(await page.$eval('#eda-tab-changes', el => el.textContent.trim()), 'Work orders');
    assert.equal(await page.$eval('#eda-tab-changes', el => el.id), 'eda-tab-changes');

    // A changed draft survives failure and the composer is enabled again.
    await page.click('#instructions-close'); await page.click('#intent-text'); await page.type('#intent-text', 'Keep this draft');
    await page.evaluate(() => replaceSelection([allFeatures[2]])); await page.click('#queue-instruction');
    const failed = await page.evaluate(() => window.__sent.filter(m => m.type === 'instructionAction' && m.action === 'add').at(-1));
    await page.evaluate(requestId => window.dispatchEvent(new MessageEvent('message', { data: { type: 'instructionError', requestId: requestId + '-stale', error: 'stale host error' } })), failed.requestId);
    assert.equal(await page.$eval('#queue-instruction', el => el.disabled), true, 'stale error re-enabled a different pending order');
    await page.evaluate(requestId => window.dispatchEvent(new MessageEvent('message', { data: { type: 'instructionError', requestId, error: 'host rejected work order' } })), failed.requestId);
    assert.equal(await page.$eval('#intent-text', el => el.value), 'Keep this draft'); assert.equal(await page.$eval('#queue-instruction', el => el.disabled), false);

    // Render lifecycle, source capability, next-open, and action labels from host records.
    const records = [
      { id: 'open-1', sequence: 1, status: 'open', gdsPath: 'standalone.gds', request: { text: 'open proposal' }, context: { schema: 'gds-navigator.selection' }, history: [{ event: 'created', status: 'open', timestamp: '2026-09-22T00:00:00Z' }] },
      { id: 'done-1', sequence: 2, status: 'done', gdsPath: 'standalone.gds', request: { text: 'completed source edit' }, context: { schema: 'gds-navigator.selection' }, sourceReceipts: [{ path: 'scripts/mzi_example.py', beforeHash: 'x', beforeText: 'x', afterHash: 'y' }], history: [{ event: 'created', status: 'open', timestamp: '2026-09-22T00:00:00Z' }, { event: 'done', status: 'done', timestamp: '2026-09-22T00:01:00Z' }] },
      { id: 'done-2', sequence: 3, status: 'done', gdsPath: 'other.gds', request: { text: 'done without receipt' }, context: { schema: 'gds-navigator.selection' }, history: [{ event: 'done', status: 'done', timestamp: '2026-09-22T00:02:00Z' }] }
    ];
    await page.evaluate(records => window.dispatchEvent(new MessageEvent('message', { data: { type: 'instructions', location: '.gds-navigator/instructions.json', nextOpen: 'open-1', records } })), records);
    await page.click('#eda-tab-changes');
    await page.waitForFunction(() => !document.querySelector('#instruction-list').hidden);
    await page.evaluate(() => { document.querySelector('#instruction-feedback').textContent = ''; document.querySelector('#workflow-status').textContent = 'Work orders loaded.'; });
    assert(await page.$('#work-order-search') && await page.$('#work-order-filter'), 'work-order search/filter controls missing');
    const cards = await page.$$eval('#instruction-records article.work-order-card', els => els.map(el => ({ id: el.dataset.workOrderId, status: el.dataset.status, text: el.textContent, actions: [...el.querySelectorAll('button')].map(b => b.textContent.trim()), details: [...el.querySelectorAll('details')].map(d => d.textContent) })));
    assert.equal(cards.length, 3, 'work-order cards do not expose stable card class');
    assert(await page.$$eval('#instruction-records article.work-order-card', els => els.every(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })), 'work-order cards are not visibly rendered');
    await page.$eval('#work-order-search', el => { el.value = 'completed source'; });
    await page.evaluate(() => renderInstructions(lastWorkOrderMessage));
    await page.waitForFunction(() => document.querySelectorAll('#instruction-records article.work-order-card').length === 1);
    assert.deepEqual(await page.$$eval('#instruction-records article.work-order-card', els => els.map(el => el.dataset.workOrderId)), ['done-1'], 'work-order search did not filter requirement text');
    await page.$eval('#work-order-search', el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.select('#work-order-filter', 'done'); await page.evaluate(() => renderInstructions(lastWorkOrderMessage));
    await page.waitForFunction(() => document.querySelectorAll('#instruction-records article.work-order-card').length === 2);
    assert.deepEqual(await page.$$eval('#instruction-records article.work-order-card', els => els.map(el => el.dataset.workOrderId)), ['done-1', 'done-2'], 'work-order status filter failed');
    assert.equal(await page.$eval('#instruction-location', el => el.textContent.includes('Next: open-1')), true);
    assert(cards.every(c => c.actions.includes('Copy ref') && c.actions.includes('Copy details')));
    assert(cards[0].actions.includes('Mark done') && !cards[0].actions.includes('Undo changes'));
    assert(cards[1].actions.includes('Undo changes'), 'completed receipt card lacks Undo changes');
    assert(cards[2].actions.includes('Withdraw proposal'), 'done proposal without receipts lacks Withdraw proposal');
    assert(cards.every(c => c.details.some(text => /created|done|lifecycle|history/i.test(text))), 'lifecycle history details are not shown');
    assert(/Source unavailable|source unavailable|Proposal withdrawal only/i.test(cards[2].text), 'source unavailable capability not communicated');
    await page.screenshot({ path: path.join(out, 'work-orders.png') });
    await (await page.$('#instruction-bar')).screenshot({ path: path.join(out, 'composer-detail.png') });
    await page.evaluate(() => { const s = document.documentElement.style; s.setProperty('--vscode-editor-background', '#ffffff'); s.setProperty('--vscode-sideBar-background', '#f3f3f3'); s.setProperty('--vscode-foreground', '#222222'); s.setProperty('--vscode-input-background', '#ffffff'); s.setProperty('--vscode-editorWidget-background', '#ececec'); s.setProperty('--vscode-descriptionForeground', '#555555'); });
    await page.screenshot({ path: path.join(out, 'light-composer.png') });
    await page.setViewport({ width: 500, height: 700 });
    const compactComposer = await page.evaluate(() => { const b = document.querySelector('#queue-instruction').getBoundingClientRect(); return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, visible: b.width > 0 && b.height > 0 && b.right <= window.innerWidth + 1 }; });
    assert.equal(compactComposer.overflow, false, '500px composer overflows horizontally');
    assert.equal(compactComposer.visible, true, 'primary Add work order action is not visible at 500px');
    await page.screenshot({ path: path.join(out, 'compact-500-composer.png') });
    await page.setViewport({ width: 1400, height: 900 });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ status: 'passed', requestSnapshotFrozen: true, duplicateBlocked: true, ackAndFailure: true, lifecycleCards: true, keyboard: ['enter-newline', 'ctrl-enter-submit', 'composing-ignored'], screenshots: ['work-orders.png', 'composer-detail.png', 'light-composer.png', 'compact-500-composer.png'] }, null, 2));
    console.log('Work orders viewer browser reliability passed');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
