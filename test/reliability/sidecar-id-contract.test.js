'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { closeOwnedBrowser } = require('../../scripts/process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '../..');
const defaultPython = process.platform === 'win32' ? path.join(ROOT, '.venv-fork', 'Scripts', 'python.exe') : path.join(ROOT, '.venv-fork', 'bin', 'python');
const PYTHON = path.resolve(process.env.GDS_TEST_PYTHON || process.env.GDS_PYTHON || defaultPython);
const BROWSER = process.env.GDS_TEST_BROWSER || process.env.GDS_BROWSER;

function makeFixtureScript() {
  return String.raw`import json, sys
import klayout.db as kdb

directory, entries = sys.argv[1], json.loads(sys.argv[2])
layout = kdb.Layout(); layout.dbu = 0.001
top = layout.create_cell('TOP'); layer = layout.layer(4, 0)
for index, x in enumerate((0, 2000)):
    shape = top.shapes(layer).insert(kdb.Box(x, 0, x + 1000, 1000))
    shape.set_property(1002, 0 if index == 0 else 7)
gds = directory + '/chip.gds'; layout.write(gds)
with open(directory + '/chip.provenance.json', 'w', encoding='utf-8') as handle:
    json.dump({'version': 1, 'entries': entries, 'ports': {}, 'ref_names': {}}, handle)
print(gds)
`;
}

function writeFixture(directory, entries) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'source.py'), Array.from({ length: 30 }, (_, index) => `# source fixture line ${index + 1}`).join('\n') + '\n', 'utf8');
  return execFileSync(PYTHON, ['-c', makeFixtureScript(), directory, JSON.stringify(entries)], { cwd: ROOT, encoding: 'utf8' }).trim();
}

function entry(id, line, file = 'source.py') {
  return { id, file, line, function: 'build', component: 'TOP' };
}

function comparable(result) {
  return result.features.map((feature) => ({
    geometry: feature.geometry,
    layer: feature.properties.layer,
    data_type: feature.properties.data_type,
    bbox: feature.properties.bbox,
  }));
}

function trackedCount(result) {
  return result.geojson.features.filter((feature) => typeof feature.properties?.provenance?.file === 'string' && Number.isInteger(feature.properties.provenance.line) && feature.properties.provenance.line > 0).length;
}

function bundleParser(bundleDir) {
  require('esbuild').buildSync({
    entryPoints: [path.join(ROOT, 'src', 'parseGdsCore.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    outfile: path.join(bundleDir, 'parseGdsCore.js'),
  });
  return require(path.join(bundleDir, 'parseGdsCore.js')).parseGdsFileCore;
}

async function browserContract(validGds, duplicateGds, temp, python) {
  assert(BROWSER && fs.existsSync(BROWSER), 'required GDS_TEST_BROWSER or GDS_BROWSER headless shell is missing');
  const startServer = require(path.join(ROOT, 'scripts', 'serve-web.cjs')).startServer;
  let host;
  const profile = path.join(temp, 'browser-profile');
  const downloads = path.join(temp, 'downloads'); fs.mkdirSync(downloads, { recursive: true });
  let browser;
  let cleanup;
  let cleanupError;
  let browserSummary;
  try {
    host = await startServer({ root: temp, stateDir: path.join(temp, 'browser-state'), file: path.relative(temp, validGds), python });
    browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, userDataDir: profile, args: ['--no-first-run'] });
    const page = await browser.newPage();
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await page.goto(host.url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__gdsReady && document.getElementById('mode-indicator')?.textContent === 'Provenance: ON');
    const validState = await page.evaluate(() => ({
      indicator: document.getElementById('mode-indicator').textContent,
      features: allFeatures.length,
      provenance: allFeatures[0].get('provenance'),
    }));
    assert.equal(validState.indicator, 'Provenance: ON');
    assert.equal(validState.features, 2);
    assert.equal(validState.provenance.file.endsWith('source.py'), true);
    assert.equal(validState.provenance.line, 10);

    const pixel = await page.evaluate(() => {
      map.renderSync();
      const p = map.getPixelFromCoordinate([0.5, 0.5]);
      const rect = map.getTargetElement().getBoundingClientRect();
      return [p[0] + rect.left, p[1] + rect.top];
    });
    await page.mouse.click(...pixel, { button: 'right' });
    await page.waitForSelector('#canvas-context-menu', { visible: true });
    const menuDiagnostics = await page.evaluate(() => ({
      selected: selectedFeatures.getArray().map((feature) => feature.get('provenance')),
      context: contextMenuFeature && contextMenuFeature.get('provenance'),
      actions: Array.from(document.querySelectorAll('#canvas-context-menu button:not([hidden])')).map((button) => button.dataset.action),
    }));
    assert(menuDiagnostics.actions.includes('review-more'), `Review / work orders was not exposed: ${JSON.stringify(menuDiagnostics)}`);
    await page.click('#canvas-context-menu [data-action="review-more"]');
    await page.waitForFunction(() => !document.querySelector('#canvas-context-menu [data-action="source-navigation"]')?.hidden);
    await page.click('#canvas-context-menu [data-action="source-navigation"]');
    await page.waitForFunction(() => window.__gdsDebug.sent.some((message) => message.type === 'requestSource'));
    const sourceRequest = await page.evaluate(() => window.__gdsDebug.sent.filter((message) => message.type === 'requestSource').at(-1));
    assert.equal(fs.realpathSync(sourceRequest.file), fs.realpathSync(path.join(path.dirname(validGds), 'source.py')), 'source action targeted a different fixture file');
    assert.equal(sourceRequest.line, 10);
    await page.waitForFunction(() => /Source downloaded: source\.py:10/.test(document.getElementById('browser-host-status').textContent));
    const download = path.join(downloads, 'source.py');
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(download) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.readFileSync(download, 'utf8'), fs.readFileSync(path.join(path.dirname(validGds), 'source.py'), 'utf8'), 'source download did not preserve file contents');

    await page.evaluate((file) => window.__gdsDebug.load(file), duplicateGds);
    await page.waitForFunction(() => document.getElementById('mode-indicator')?.textContent.startsWith('Provenance: PARTIAL'));
    const duplicateState = await page.evaluate(() => ({
      indicator: document.getElementById('mode-indicator').textContent,
      status: document.getElementById('workflow-status').textContent,
      received: window.__gdsDebug.received.filter((message) => message.type === 'loadGds').at(-1),
      features: allFeatures.length,
    }));
    assert.match(duplicateState.indicator, /^Provenance: PARTIAL/);
    assert.equal(duplicateState.features, 2);
    assert.equal(duplicateState.received.mode, 'partial');
    assert(duplicateState.received.warnings && duplicateState.received.warnings.length > 0, 'duplicate warning was not delivered to browser host');
    browserSummary = { validIndicator: validState.indicator, duplicateIndicator: duplicateState.indicator, sourceRequest: { file: sourceRequest.file, line: sourceRequest.line }, downloadDir: downloads };
    return browserSummary;
  } finally {
    if (browser) {
      try { cleanup = await closeOwnedBrowser(browser, { profileDir: profile }); } catch (error) { cleanupError = error; }
    }
    if (host) {
      try { await host.close(); } catch (error) { cleanupError ||= error; }
    }
    if (browserSummary) browserSummary.cleanup = cleanupError ? { verified: false, error: String(cleanupError) } : { verified: cleanup?.verified === true, pid: cleanup?.pid, escalated: cleanup?.escalated === true, survivors: cleanup?.survivors || [] };
    if (cleanupError) throw cleanupError;
    if (cleanup && !cleanup.verified) throw new Error('browser process shutdown was not verified; temporary workspace retained');
  }
}

(async () => {
  // Use the same selected interpreter for the focused parser matrix and API/UI gate.
  execFileSync(PYTHON, [path.join(ROOT, 'test', 'reliability', 'sidecar-id-parser.test.py')], { cwd: ROOT, stdio: 'inherit' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-sidecar-id-contract-'));
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-sidecar-id-bundle-'));
  let preserveTemp = false;
  try {
    const integerDir = path.join(temp, 'integer');
    const stringDir = path.join(temp, 'string');
    const duplicateDir = path.join(temp, 'duplicate');
    const integerGds = writeFixture(integerDir, [entry(0, 10), entry(7, 20)]);
    const stringGds = writeFixture(stringDir, [entry(' 000 ', 10), entry('+007', 20)]);
    const duplicateGds = writeFixture(duplicateDir, [entry(0, 10), entry('7', 20), entry(7, 21)]);
    const parseGdsFileCore = bundleParser(bundleDir);
    const integer = await parseGdsFileCore(PYTHON, integerGds, ROOT);
    const strings = await parseGdsFileCore(PYTHON, stringGds, ROOT);
    assert.equal(integer.mode, 'full');
    assert.equal(strings.mode, 'full');
    const geometryParity = JSON.stringify(comparable(strings.geojson)) === JSON.stringify(comparable(integer.geojson));
    assert.equal(geometryParity, true, 'numeric-string IDs must preserve exact geometry/layers/bboxes');
    assert.deepEqual(strings.geojson.features.map((f) => [f.properties.provenance.file, f.properties.provenance.line]), [['source.py', 10], ['source.py', 20]]);
    assert.deepEqual(strings.warnings || [], []);

    const duplicate = await parseGdsFileCore(PYTHON, duplicateGds, ROOT);
    assert.equal(duplicate.mode, 'partial');
    assert(duplicate.warnings.some((warning) => /duplicate/i.test(warning)), 'duplicate canonical ID warning missing');
    assert.equal(duplicate.geojson.features.length, 2, 'duplicate sidecar must retain geometry');
    assert.equal(duplicate.geojson.features[0].properties.provenance.file, 'source.py', 'unrelated valid feature must remain tracked');
    assert.equal(duplicate.geojson.features[0].properties.provenance.line, 10);

    const browser = await browserContract(path.join(stringDir, 'chip.gds'), path.join(duplicateDir, 'chip.gds'), temp, PYTHON);
    const reportDir = process.env.GDS_SIDECAR_REPORT_DIR ? path.resolve(process.env.GDS_SIDECAR_REPORT_DIR) : path.join(ROOT, 'logs', 'reliability', 'sidecar-ids');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({ status: 'passed', mode: { integer: integer.mode, strings: strings.mode, duplicate: duplicate.mode }, tracked: { integer: trackedCount(integer), strings: trackedCount(strings), duplicate: trackedCount(duplicate) }, geometryParity, duplicateWarnings: duplicate.warnings, features: duplicate.geojson.features.length, browser, cleanup: 'closeOwnedBrowser verified no owned browser/helper survivors' }, null, 2));
    console.log(JSON.stringify({ status: 'passed', checks: ['parseGdsCore-real-klayout', 'canonical-string-id-parity', 'duplicate-id-partial-warning', 'browser-provenance-source-request'], python: PYTHON }));
  } catch (error) {
    preserveTemp = true;
    const reportDir = process.env.GDS_SIDECAR_REPORT_DIR ? path.resolve(process.env.GDS_SIDECAR_REPORT_DIR) : path.join(ROOT, 'logs', 'reliability', 'sidecar-ids');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'failure.json'), JSON.stringify({ status: 'failed', error: String(error), temp }, null, 2));
    throw error;
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
    if (!preserveTemp) fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
