#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { closeOwnedBrowser } = require('../../scripts/process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '../..');
const BROWSER = [process.env.GDS_TEST_BROWSER, process.env.GDS_BROWSER].filter(Boolean).find(fs.existsSync);
assert(BROWSER, 'required GDS_TEST_BROWSER/GDS_BROWSER headless shell is missing');

async function main() {
  const startServer = require(path.join(ROOT, 'scripts', 'serve-web.cjs')).startServer;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-status-layout-'));
  const source = path.join(temp, 'status_source.py');
  const layout = path.join(temp, 'status.geojson');
  fs.writeFileSync(source, '# status layout source\n' .repeat(40));
  fs.writeFileSync(layout, JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {
        element_id: 'status-target', layer: 1, data_type: 0, color: '#89b4fa',
        provenance: { file: 'status_source.py', line: 27, function: 'status_fixture' },
      },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]] },
    }],
  }));
  const stateDir = path.join(temp, 'state'); fs.mkdirSync(stateDir);
  const host = await startServer({ port: 0, root: temp, stateDir, file: 'status.geojson', python: process.env.GDS_TEST_PYTHON || process.env.GDS_PYTHON || 'python' });
  let browser;
  const diagnostics = path.join(ROOT, 'logs/testing-20261009/status-layout'); fs.mkdirSync(diagnostics, { recursive: true });
  try {
    browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 786, height: 776 });
    await page.goto(host.url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__gdsDebug);
    await page.evaluate(() => window.__gdsReady);
    await page.waitForFunction(() => Array.isArray(window.allFeatures) && window.allFeatures.length === 1);
    await page.click('#eda-dock-toggle');
    await page.waitForFunction(() => !document.body.classList.contains('dock-collapsed'));
    await new Promise(resolve => setTimeout(resolve, 80));

    const measure = () => page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top, bottom: r.bottom }; };
      return { status: rect('#eda-status'), map: rect('#map'), dock: rect('#eda-dock'), text: document.querySelector('#eda-coordinates').textContent };
    });
    const short = await page.evaluate(async () => { edaWorkbench.coordinates([0, 0]); await new Promise(requestAnimationFrame); return document.querySelector('#eda-coordinates').textContent; });
    const shortGeometry = await measure();
    const long = await page.evaluate(async () => { edaWorkbench.coordinates([123456789.123, -987654321.987]); await new Promise(requestAnimationFrame); return document.querySelector('#eda-coordinates').textContent; });
    const longGeometry = await measure();
    assert.equal(short, 'X 0.000   Y 0.000 µm');
    assert.equal(long, 'X 123456789.123   Y -987654321.987 µm');
    assert(Math.abs(shortGeometry.status.height - longGeometry.status.height) <= 1, `status footer changed: ${JSON.stringify({ short: shortGeometry.status, long: longGeometry.status })}`);
    assert(Math.abs(shortGeometry.map.height - longGeometry.map.height) <= 1, `map height changed: ${JSON.stringify({ short: shortGeometry.map, long: longGeometry.map })}`);
    assert(shortGeometry.map.width >= 240 && longGeometry.map.width >= 240, `narrow map collapsed: ${JSON.stringify({ short: shortGeometry.map, long: longGeometry.map })}`);

    const point = await page.evaluate(() => { const p = map.getPixelFromCoordinate([10, 10]); const r = map.getTargetElement().getBoundingClientRect(); return [p[0] + r.left, p[1] + r.top]; });
    await page.mouse.click(point[0], point[1], { button: 'right' });
    await page.waitForSelector('#canvas-context-menu:not([hidden])');
    await page.evaluate(async () => { edaWorkbench.coordinates([123456789.123, -987654321.987]); await new Promise(requestAnimationFrame); });
    assert.equal(await page.$eval('#canvas-context-menu', el => el.hidden), false, 'context menu closed after coordinate/footer update');

    await page.click('#canvas-context-menu [data-action="review-more"]');
    const sourceButton = await page.$('#canvas-context-menu [data-action="source-navigation"]');
    assert(sourceButton, 'Review/work orders submenu did not expose Open source');
    const sourceBox = await sourceButton.boundingBox();
    assert(sourceBox, 'Open source submenu item has no hit target');
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.$eval('#canvas-context-menu', el => el.hidden), false, 'Review/work orders submenu closed during mouse movement');
    await page.click('#canvas-context-menu [data-action="source-navigation"]');
    await page.waitForFunction(() => window.__gdsDebug.sent.some(m => m.type === 'requestSource'));
    const request = await page.evaluate(() => window.__gdsDebug.sent.filter(m => m.type === 'requestSource').at(-1));
    assert.deepEqual({ file: path.basename(request.file), line: request.line }, { file: 'status_source.py', line: 27 });
    await page.waitForFunction(() => window.__gdsDebug.received.some(m => m.type === 'requestSource') || document.querySelector('#browser-host-status')?.textContent.includes('status_source.py:27'));

    // A genuine view change remains a dismissal boundary for the context menu.
    await page.mouse.click(point[0], point[1], { button: 'right' });
    await page.waitForSelector('#canvas-context-menu:not([hidden])');
    await page.evaluate(() => map.getView().setCenter([40, 40]));
    await page.waitForFunction(() => document.querySelector('#canvas-context-menu').hidden);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'passed', viewport: [786, 776], short, long, shortGeometry, longGeometry, requestSource: { file: path.basename(request.file), line: request.line } }));
  } finally {
    let cleanupError = null, hostError = null;
    try { if (browser) await closeOwnedBrowser(browser); } catch (error) { cleanupError = error; }
    try { await host.close(); } catch (error) { hostError = error; }
    if (cleanupError || hostError) {
      fs.writeFileSync(path.join(diagnostics, 'cleanup-failure.json'), JSON.stringify({ cleanupError: cleanupError?.stack || null, hostError: hostError?.stack || null, temp }, null, 2));
    } else {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    if (cleanupError) throw cleanupError;
    if (hostError) throw hostError;
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
