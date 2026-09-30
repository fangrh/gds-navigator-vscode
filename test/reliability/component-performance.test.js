#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
const BROWSER = [process.env.GDS_BROWSER, 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(fs.existsSync);
assert(BROWSER, 'Edge/Chrome required; set GDS_BROWSER');
const chooser = fs.readFileSync(path.join(ROOT, 'webview/component-chooser.js'), 'utf8');
const baselineCandidates = [path.join(ROOT, 'logs/performance/component-chooser-before.js'), 'C:/Users/fangr/.vscode/extensions/fangrh.gds-navigator-0.1.0/webview/component-chooser.js'];
const baselinePath = baselineCandidates.find(fs.existsSync);
assert(baselinePath, 'pre-change chooser baseline is required');
const baselineChooser = fs.readFileSync(baselinePath, 'utf8');
const baselineSha256 = crypto.createHash('sha256').update(baselineChooser).digest('hex');
const fixture = Array.from({ length: 344 }, (_, i) => ({ name: `factory_${String(i).padStart(3, '0')}`, category: i % 4 ? 'Basic' : 'Other', parameters: [] }));

async function measureChooser(browser, source) {
  const page = await browser.newPage(); await page.setContent('<div id="catalog"></div>'); await page.addScriptTag({ content: source });
  await page.evaluate(() => { window.IntersectionObserver = undefined; window.__sent = []; window.__created = 0; const ce = document.createElement.bind(document), cne = document.createElementNS.bind(document); document.createElement = (...args) => { window.__created++; return ce(...args); }; document.createElementNS = (...args) => { window.__created++; return cne(...args); }; });
  const catalogId = await page.evaluate(() => { const c = ComponentChooser.mount({ container: document.querySelector('#catalog'), postMessage: message => window.__sent.push(message) }); window.__chooser = c; c.open(); return window.__sent.at(-1).requestId; });
  await page.evaluate(({ id, components }) => window.__chooser.handleMessage({ type: 'componentCatalog', requestId: id, result: { components } }), { id: catalogId, components: fixture }); await page.waitForFunction(() => document.querySelectorAll('.component-card').length === 344); await page.waitForFunction(() => window.__sent.some(m => m.type === 'requestComponentThumbnails'));
  await page.evaluate(() => { window.__created = 0; }); const thumb = await page.evaluate(() => window.__sent.find(m => m.type === 'requestComponentThumbnails'));
  const thumbnail = await page.evaluate(({ id, names }) => { const start = performance.now(), before = window.__created, geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 1], [0, 0]]] } }] }; window.__chooser.handleMessage({ type: 'componentThumbnails', requestId: id, result: { items: names.map(name => ({ name, geojson })) } }); return { durationMs: performance.now() - start, createElementCalls: window.__created - before }; }, { id: thumb.requestId, names: thumb.names });
  await page.evaluate(() => document.querySelector('.component-card').click()); const previewReq = await page.evaluate(() => window.__sent.find(m => m.type === 'previewComponent')); const preview = { name: fixture[0].name, settings: {}, geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 1], [0, 0]]] } }] } }; await page.evaluate(({ id, result }) => window.__chooser.handleMessage({ type: 'componentPreview', requestId: id, result }), { id: previewReq.requestId, result: preview });
  await page.evaluate(() => { window.__created = 0; }); const selectionCached = await page.evaluate(() => { const start = performance.now(), before = window.__created; document.querySelector('.component-card').click(); return { durationMs: performance.now() - start, createElementCalls: window.__created - before }; }); await page.close(); return { thumbnail, selectionCached };
}

async function main() {
  const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
  try {
    const legacy = await measureChooser(browser, baselineChooser);
    const page = await browser.newPage();
    await page.setContent('<div id="catalog"></div>');
    await page.addScriptTag({ content: chooser });
    await page.evaluate(() => {
      window.IntersectionObserver = undefined;
      window.__sent = [];
      window.__created = 0;
      const ce = document.createElement.bind(document), cne = document.createElementNS.bind(document);
      document.createElement = (...args) => { window.__created++; return ce(...args); };
      document.createElementNS = (...args) => { window.__created++; return cne(...args); };
    });
    const setup = await page.evaluate(() => {
      const container = document.querySelector('#catalog');
      window.__chooser = ComponentChooser.mount({ container, postMessage: message => window.__sent.push(message) });
      window.__chooser.open();
      return window.__sent.at(-1).requestId;
    });
    await page.evaluate(({ id, components }) => window.__chooser.handleMessage({ type: 'componentCatalog', requestId: id, result: { components } }), { id: setup, components: fixture });
    await page.waitForFunction(() => document.querySelectorAll('.component-card').length === 344);
    await page.waitForFunction(() => window.__sent.some(message => message.type === 'requestComponentThumbnails'));
    await page.evaluate(() => { window.__created = 0; });
    await page.evaluate(() => { window.__card = document.querySelector('.component-card'); });
    const thumbRequest = await page.evaluate(() => window.__sent.find(message => message.type === 'requestComponentThumbnails'));
    assert(thumbRequest, 'thumbnail request missing');
    const afterThumbnail = await page.evaluate(({ id, names }) => {
      const start = performance.now(), before = window.__created;
      const geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 1], [0, 0]]] } }] };
      window.__chooser.handleMessage({ type: 'componentThumbnails', requestId: id, result: { items: names.map(name => ({ name, geojson })) } });
      return { durationMs: performance.now() - start, createElementCalls: window.__created - before };
    }, { id: thumbRequest.requestId, names: thumbRequest.names });
    assert.equal(await page.evaluate(() => document.querySelectorAll('.component-card').length), 344);
    assert.equal(await page.evaluate(() => document.querySelector('.component-card') === window.__card), true, 'thumbnail response replaced card DOM');
    await page.evaluate(() => window.__chooser.open());
    const previewRequest = await page.evaluate(() => { document.querySelector('.component-card').click(); return window.__sent.find(message => message.type === 'previewComponent'); });
    assert(previewRequest, 'preview request missing');
    const preview = { name: fixture[0].name, settings: {}, geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 1], [0, 0]]] } }] } };
    await page.evaluate(({ id, result }) => window.__chooser.handleMessage({ type: 'componentPreview', requestId: id, result }), { id: previewRequest.requestId, result: preview });
    await page.evaluate(() => { window.__created = 0; });
    const afterCached = await page.evaluate(() => {
      const start = performance.now(), before = window.__created;
      document.querySelector('#catalog .component-card').click();
      return { durationMs: performance.now() - start, createElementCalls: window.__created - before };
    });
    const report = { status: 'passed', fixtureCount: fixture.length, protocol: 'fake component catalog/thumbnails/preview messages', baselineSource: baselinePath, baselineSha256, legacyFullRebuild: legacy, incremental: { thumbnail: afterThumbnail, selectionCached: afterCached, cardCount: await page.evaluate(() => document.querySelectorAll('.component-card').length) }, notes: ['Baseline figures use the exact pre-change chooser source in a separate real browser page.', 'Node counters count createElement/createElementNS calls; incremental response handling preserves card nodes and updates only affected thumbnails.'] };
    const out = path.join(ROOT, 'logs/performance'); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'components.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
