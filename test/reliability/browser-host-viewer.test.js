'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
const BROWSER = [process.env.GDS_BROWSER, 'C:/Users/fangr/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(fs.existsSync);
assert(BROWSER, 'required GDS_BROWSER headless shell is missing');

async function main() {
  const startServer = require(path.join(ROOT, 'scripts', 'serve-web.cjs')).startServer;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-browser-viewer-'));
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/jj_pad_center_50_test.gds'), path.join(temp, 'chip.gds'));
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/jj_pad_center_50_test.gds'), path.join(temp, 'other.gds'));
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/electrode100-reduced.png'), path.join(temp, 'sample.png'));
  const python = process.env.GDS_PYTHON || (fs.existsSync(path.join(ROOT, '.venv-fork/Scripts/python.exe')) ? path.join(ROOT, '.venv-fork/Scripts/python.exe') : 'python');
  const { url, close } = await startServer({ port: 0, root: temp, stateDir: path.join(temp, 'state'), file: 'chip.gds', python });
  const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
  const page = await browser.newPage(); const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  const out = path.join(ROOT, 'logs/reliability/browser-host'); fs.mkdirSync(out, { recursive: true });
  try {
    for (const width of [1400, 390, 320]) {
      await page.setViewport({ width, height: 900 });
      await page.goto(url, { waitUntil: 'networkidle0' });
      await page.evaluate(() => window.__gdsReady);
      await page.waitForFunction(() => typeof allFeatures !== 'undefined' && allFeatures.length > 0);
      await page.waitForFunction(() => document.querySelector('#map canvas') && document.querySelector('#map canvas').width > 0);
      assert.equal(await page.evaluate(() => Array.isArray(window.__pageErrors) ? window.__pageErrors.length : 0), 0);
      const bounds = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, canvas: document.getElementById('map').getBoundingClientRect().toJSON() }));
      assert(bounds.scroll <= bounds.width + 1, 'horizontal page overflow');
      assert(bounds.canvas.width >= 150 && bounds.canvas.height >= 100, 'canvas unusable at ' + width);
      await page.screenshot({ path: path.join(out, `viewer-${width}.png`), fullPage: true });
    }

    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluate(() => window.__gdsDebug.load('chip.gds'));
    await page.waitForFunction(() => allFeatures.length > 0 && currentGdsPath.endsWith('chip.gds'));
    const canvas = await page.$('#map canvas'); assert(canvas, 'viewer canvas missing');
    const box = await canvas.boundingBox(); assert(box && box.width > 10 && box.height > 10);
    await page.click('[data-mode="rectangle"]');
    await page.mouse.click(box.x + box.width * .35, box.y + box.height * .35);
    await page.mouse.move(box.x + box.width * .55, box.y + box.height * .55, { steps: 4 });
    await page.mouse.click(box.x + box.width * .55, box.y + box.height * .55);
    await page.waitForFunction(() => drawSource.getFeatures().length === 1);
    await page.waitForFunction(() => window.__gdsDebug.received.some(m => m.type === 'annotationsSaved'));
    const saved = await page.evaluate(() => ({ id: drawSource.getFeatures()[0].get('annotationId'), coordinates: drawSource.getFeatures()[0].getGeometry().getCoordinates() }));
    assert(saved.coordinates.length, 'drawn annotation geometry missing');
    await page.evaluate(() => window.__gdsDebug.load('chip.gds'));
    await page.waitForFunction(() => drawSource.getFeatures().length === 1);

    // Queue a write and immediately switch files: the queued write must retain its old path.
    await page.evaluate(async () => {
      // Read canonical saved data via the same host API.
      const response = await fetch('/api/load', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: currentGdsPath }) });
      const data = await response.json(); const saved = data.messages.find(m => m.type === 'loadGds');
      saved.annotations[0].intent = { action: 'add', text: 'Queued before switching', targetIds: [] };
      acquireVsCodeApi().postMessage({ type: 'saveAnnotations', layoutHash: currentLayoutHash, annotations: saved.annotations, recordInstruction: false });
      await window.__gdsDebug.load('other.gds');
    });
    assert.equal(await page.evaluate(() => drawSource.getFeatures().length), 0, 'queued save leaked into other layout');
    await page.evaluate(() => window.__gdsDebug.load('chip.gds'));
    assert.equal(await page.evaluate(() => drawSource.getFeatures()[0].get('intent').text), 'Queued before switching');
    assert.deepEqual(await page.evaluate(() => drawSource.getFeatures()[0].getGeometry().getCoordinates()), saved.coordinates);
    await page.evaluate(() => window.__gdsDebug.load('other.gds'));
    await page.waitForFunction(() => window.__gdsDebug.received.findLast(m => m.type === 'loadGds')?.gdsPath.endsWith('other.gds'));
    assert.equal(await page.evaluate(() => drawSource.getFeatures().length), 0);
    await page.evaluate(() => window.__gdsDebug.load('chip.gds'));
    await page.waitForFunction(() => drawSource.getFeatures().length === 1);

    const fileInput = await page.$('#browser-host-image');
    assert(fileInput, 'image file input missing from browser viewer');
    await fileInput.uploadFile(path.join(temp, 'sample.png'));
    await page.waitForFunction(() => microImages.length === 1 && window.__gdsDebug.received.some(m => m.type === 'imageStateSaved'));
    await page.evaluate(() => window.__gdsDebug.flush());
    await page.reload({ waitUntil: 'networkidle0' });
    await page.evaluate(() => window.__gdsReady);
    await page.waitForFunction(() => microImages.length === 1 && drawSource.getFeatures().length === 1);
    assert.equal(await page.evaluate(() => microImages[0].name), 'sample.png');
    await page.screenshot({ path: path.join(out, 'viewer-image.png'), fullPage: true });
    assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('; ')}`);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ status: 'passed', widths: [1400, 390, 320], drawingPersisted: true, fileSwitching: true, imageImport: true, pageErrors }, null, 2));
    console.log(JSON.stringify({ status: 'passed', checks: ['desktop-compact-320-layouts', 'actual-canvas-drawing', 'annotation-reload', 'file-switching', 'image-file-input', 'no-page-errors'] }));
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ status: 'failed', error: String(error), pageErrors }, null, 2));
    throw error;
  } finally { await browser.close(); await close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
