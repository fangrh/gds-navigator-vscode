'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { closeOwnedBrowser } = require('../../scripts/process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '../..');
const defaultPython = process.platform === 'win32'
  ? path.join(ROOT, '.venv-fork', 'Scripts', 'python.exe')
  : path.join(ROOT, '.venv-fork', 'bin', 'python');
const PYTHON = path.resolve(process.env.GDS_TEST_PYTHON || process.env.GDS_PYTHON || defaultPython);
const BROWSER = process.env.GDS_BROWSER || process.env.GDS_TEST_BROWSER;
const REPORT_DIR = path.resolve(process.env.GDS_SOURCE_CHAIN_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'source-chain'));

function writeFixture(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const source = [
    '# source-chain fixture',
    'def build():',
    '    return "valid source bytes"',
    ...Array.from({ length: 20 }, (_, index) => `# line ${index + 4}`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(directory, 'source.py'), source, 'utf8');
  const provenance = {
    cell: 'TOP',
    file: 'source.py',
    line: 3,
    function: 'build',
    call_chain: [
      { file: 'caller.py', line: 7, function: 'caller' },
      null,
      'string-frame-is-invalid',
      { file: 42, line: 7, function: 'nonstring-file' },
      { file: 'nested.py', line: '11', function: 'nested' },
      { file: '', line: 0, function: '' },
    ],
    source_text: 'return "valid source bytes"',
    instance_name: 'mixed_optional_chain',
  };
  const makeGds = String.raw`import json, sys
import klayout.db as kdb
directory = sys.argv[1]
layout = kdb.Layout(); layout.dbu = 0.001
top = layout.create_cell('TOP')
shape_layer = layout.layer(1, 0)
provenance_layer = layout.layer(255, 255)
top.shapes(shape_layer).insert(kdb.Box(0, 0, 10000, 10000))
provenance = json.loads(sys.argv[2])
top.shapes(provenance_layer).insert(kdb.Text(json.dumps(provenance), kdb.Trans(0, 0)))
layout.write(directory + '/mixed.gds')
print(directory + '/mixed.gds')
`;
  const layout = execFileSync(PYTHON, ['-c', makeGds, directory, JSON.stringify(provenance)], { cwd: ROOT, encoding: 'utf8' }).trim();
  return { layout, source: path.join(directory, 'source.py'), provenance, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]] } };
}

async function run() {
  assert(BROWSER && fs.existsSync(BROWSER), 'required GDS_BROWSER or GDS_TEST_BROWSER headless shell is missing');
  const { startServer } = require(path.join(ROOT, 'scripts', 'serve-web.cjs'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-source-chain-viewer-'));
  const fixture = writeFixture(temp);
  const profile = path.join(temp, 'browser-profile');
  const downloads = path.join(temp, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  let host;
  let browser;
  let cleanup;
  let cleanupError;
  let result;
  let operationError;
  const pageErrors = [];
  try {
    host = await startServer({ root: temp, stateDir: path.join(temp, 'browser-state'), file: path.basename(fixture.layout), python: PYTHON });
    browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, userDataDir: profile, args: ['--no-first-run'] });
    const page = await browser.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await page.goto(host.url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__gdsReady && allFeatures.length === 1);
    const before = await page.evaluate(() => ({
      geometry: allFeatures[0].getGeometry().getCoordinates(),
      provenance: allFeatures[0].get('provenance'),
    }));
    assert.deepEqual(before.geometry, fixture.geometry.coordinates, 'geometry changed while loading malformed optional frames');
    const observedChain = before.provenance.call_chain.map(frame => frame && typeof frame === 'object'
      ? Object.fromEntries(Object.entries(frame).filter(([key]) => key !== 'resolved_file' && key !== 'source_resolution'))
      : frame);
    assert.deepEqual(observedChain, fixture.provenance.call_chain, 'raw optional call_chain metadata changed');

    const fallbackRefs = await page.evaluate(() => {
      const feature = allFeatures[0];
      const original = feature.get('provenance');
      feature.set('provenance', { ...original, file: '', line: 0, call_chain: [{ file: 42, line: 7 }, { file: 'caller.py', line: 7 }] });
      const caller = contextSourceRef(feature);
      feature.set('provenance', { ...original, file: '', line: 0, call_chain: [{ file: 42, line: 7 }, 'string-caller.py:13 in caller'] });
      const stringFrame = contextSourceRef(feature);
      feature.set('provenance', original);
      return { caller, stringFrame, restored: feature.get('provenance') === original };
    });
    assert.deepEqual(fallbackRefs.caller, { file: 'caller.py', line: 7 });
    assert.deepEqual(fallbackRefs.stringFrame, { file: 'string-caller.py', line: 13 });
    assert.equal(fallbackRefs.restored, true, 'fallback control did not restore original provenance');

    const primaryFile = before.provenance.resolved_file || before.provenance.file;
    await page.evaluate(file => window.postMessage({ type: 'selectBySource', file, line: 3 }, '*'), primaryFile);
    await page.waitForFunction(() => selectedFeatures.getArray().length === 1, { timeout: 5000 });
    assert.equal(await page.evaluate(() => selectedFeatures.item(0).get('provenance').file), 'source.py');
    const callerFile = before.provenance.call_chain[0].resolved_file || before.provenance.call_chain[0].file;
    const nestedFile = before.provenance.call_chain[4].resolved_file || before.provenance.call_chain[4].file;
    for (const [file, line] of [[callerFile, 7], [nestedFile, 11]]) {
      await page.evaluate(() => clearSelection());
      await page.evaluate(([targetFile, targetLine]) => window.postMessage({ type: 'selectBySource', file: targetFile, line: targetLine }, '*'), [file, line]);
      await page.waitForFunction(() => selectedFeatures.getArray().length === 1, { timeout: 5000 });
    }
    await page.evaluate(() => clearSelection());
    await page.evaluate(() => window.postMessage({ type: 'selectBySource', file: '42', line: 7 }, '*'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await page.evaluate(() => selectedFeatures.getArray().length), 0, 'malformed numeric frame must not be source-selectable');

    // Source selection animates the view. Wait for the resulting viewport
    // before opening a menu that deliberately closes when the map moves.
    await page.waitForFunction(() => !map.getView().getAnimating() && !map.getView().getInteracting());
    const pixel = await page.evaluate(() => {
      map.renderSync();
      const point = map.getPixelFromCoordinate([5, 5]);
      const rect = map.getTargetElement().getBoundingClientRect();
      return [point[0] + rect.left, point[1] + rect.top];
    });
    await page.mouse.click(...pixel, { button: 'right' });
    await page.waitForSelector('#canvas-context-menu [data-action="review-more"]', { visible: true });
    await page.click('#canvas-context-menu [data-action="review-more"]');
    await page.waitForFunction(() => !document.querySelector('#canvas-context-menu [data-action="source-navigation"]')?.hidden);
    await page.click('#canvas-context-menu [data-action="source-navigation"]');
    await page.waitForFunction(() => window.__gdsDebug.sent.some(message => message.type === 'requestSource'));
    const sourceRequest = await page.evaluate(() => window.__gdsDebug.sent.filter(message => message.type === 'requestSource').at(-1));
    assert.equal(fs.realpathSync(sourceRequest.file), fs.realpathSync(fixture.source));
    assert.equal(sourceRequest.line, 3);
    await page.waitForFunction(() => /Source downloaded: source\.py:3/.test(document.getElementById('browser-host-status')?.textContent || ''));
    const downloadedSource = path.join(downloads, 'source.py');
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(downloadedSource) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert(fs.existsSync(downloadedSource), 'source action did not produce a configured browser download');
    assert.deepEqual(fs.readFileSync(downloadedSource), fs.readFileSync(fixture.source), 'downloaded source bytes changed');
    assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('; ')}`);
    result = { sourceRequest, geometryPreserved: true, rawCallChainPreserved: true, pageErrors };
  } catch (error) {
    operationError = error;
  } finally {
    if (browser) {
      try { cleanup = await closeOwnedBrowser(browser, { profileDir: profile }); } catch (error) { cleanupError = error; }
    }
    if (host) {
      try { await host.close(); } catch (error) { cleanupError ||= error; }
    }
    const cleanupEvidence = { browser: cleanup || null, error: cleanupError ? String(cleanupError) : null };
    if (result) result.cleanup = cleanupEvidence;
    if (operationError) {
      operationError.cleanupEvidence = cleanupEvidence;
      operationError.pageErrors = pageErrors;
      operationError.temp = temp;
    }
    if (cleanupError) {
      cleanupError.cleanupEvidence = cleanupEvidence;
      throw cleanupError;
    }
    if (cleanup && !cleanup.verified) {
      const error = new Error('browser process shutdown was not verified; temporary workspace retained');
      error.cleanupEvidence = cleanupEvidence;
      throw error;
    }
  }
  if (operationError) throw operationError;
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify({ status: 'passed', ...result }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: ['mixed-optional-call-chain', 'context-menu-source-navigation', 'source-download-bytes', 'geometry-preserved', 'no-page-errors'] }));
}

run().catch(error => {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'failure.json'), JSON.stringify({ status: 'failed', error: String(error), pageErrors: error.pageErrors || [], cleanup: error.cleanupEvidence || null, temp: error.temp || null }, null, 2));
  console.error(error.stack || error);
  process.exitCode = 1;
});
