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
const REPORT_DIR = path.resolve(process.env.GDS_COVERAGE_REPORT_DIR || path.join(ROOT, 'logs', 'daily-source-coverage'));

function makeFixtureScript() {
  return String.raw`import json, sys
import klayout.db as kdb

directory, entries = sys.argv[1], json.loads(sys.argv[2])
layout = kdb.Layout(); layout.dbu = 0.001
top = layout.create_cell('TOP'); layer = layout.layer(4, 0)
for index, x in enumerate(range(0, len(entries) * 2000, 2000)):
    shape = top.shapes(layer).insert(kdb.Box(x, 0, x + 1000, 1000))
    shape.set_property(1002, index)
gds = directory + '/chip.gds'; layout.write(gds)
with open(directory + '/chip.provenance.json', 'w', encoding='utf-8') as handle:
    json.dump({'version': 1, 'entries': entries, 'ports': {}, 'ref_names': {}}, handle)
print(gds)
`;
}

function writeFixture(directory, entries) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'source.py'), Array.from({ length: 80 }, (_, index) => `# source fixture line ${index + 1}`).join('\n') + '\n', 'utf8');
  return execFileSync(PYTHON, ['-c', makeFixtureScript(), directory, JSON.stringify(entries)], { cwd: ROOT, encoding: 'utf8' }).trim();
}

function entry(id, fields = {}) {
  return { id, file: 'source.py', line: 10, function: 'build', component: 'TOP', ...fields };
}

function comparable(result) {
  return result.geojson.features.map((feature) => ({
    geometry: feature.geometry,
    layer: feature.properties.layer,
    data_type: feature.properties.data_type,
    bbox: feature.properties.bbox,
  }));
}

function trackedCount(result) {
  return result.geojson.features.filter((feature) => {
    const provenance = feature.properties?.provenance;
    return typeof provenance?.file === 'string' && provenance.file.trim() !== ''
      && Number.isInteger(provenance.line) && provenance.line > 0;
  }).length;
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

async function browserContract(validGds, mixedGds, offGds, blankGds, temp, python) {
  assert(BROWSER && fs.existsSync(BROWSER), 'required GDS_BROWSER or GDS_TEST_BROWSER headless shell is missing');
  const { startServer } = require(path.join(ROOT, 'scripts', 'serve-web.cjs'));
  const profile = path.join(temp, 'browser-profile');
  const downloads = path.join(temp, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  let host;
  let browser;
  let cleanup;
  let cleanupError;
  let browserSummary;
  let sourceRequest;
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
    assert.equal(validState.provenance.file, 'source.py');
    assert.equal(validState.provenance.line, 10);
    const pixel = await page.evaluate(() => {
      map.renderSync();
      const point = map.getPixelFromCoordinate([0.5, 0.5]);
      const rect = map.getTargetElement().getBoundingClientRect();
      return [point[0] + rect.left, point[1] + rect.top];
    });
    await page.mouse.click(...pixel, { button: 'right' });
    await page.waitForSelector('#canvas-context-menu', { visible: true });
    await page.click('#canvas-context-menu [data-action="review-more"]');
    await page.waitForFunction(() => !document.querySelector('#canvas-context-menu [data-action="source-navigation"]')?.hidden);
    await page.click('#canvas-context-menu [data-action="source-navigation"]');
    await page.waitForFunction(() => window.__gdsDebug.sent.some((message) => message.type === 'requestSource'));
    sourceRequest = await page.evaluate(() => window.__gdsDebug.sent.filter((message) => message.type === 'requestSource').at(-1));
    assert.equal(fs.realpathSync(sourceRequest.file), fs.realpathSync(path.join(path.dirname(validGds), 'source.py')));
    assert.equal(sourceRequest.line, 10);
    await page.waitForFunction(() => /Source downloaded: source\.py:10/.test(document.getElementById('browser-host-status')?.textContent || ''));
    const downloadedSource = path.join(downloads, 'source.py');
    const downloadDeadline = Date.now() + 3000;
    while (!fs.existsSync(downloadedSource) && Date.now() < downloadDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert(fs.existsSync(downloadedSource), 'valid source action did not produce a configured browser download');
    assert.deepEqual(fs.readFileSync(downloadedSource), fs.readFileSync(path.join(path.dirname(validGds), 'source.py')), 'downloaded source bytes changed');

    await page.evaluate((file) => window.__gdsDebug.load(file), mixedGds);
    await page.waitForFunction(() => document.getElementById('mode-indicator')?.textContent.startsWith('Provenance: PARTIAL'));
    const mixedState = await page.evaluate(() => ({
      indicator: document.getElementById('mode-indicator').textContent,
      received: window.__gdsDebug.received.filter((message) => message.type === 'loadGds').at(-1),
      features: allFeatures.length,
      raw: allFeatures.map((feature) => feature.get('provenance')),
    }));
    assert.equal(mixedState.indicator, 'Provenance: PARTIAL (2/10)');
    assert.equal(mixedState.received.mode, 'partial');
    assert.match(JSON.stringify(mixedState.received), /covers 2\/10/, 'browser load message must report precise mixed coverage');
    assert.equal(mixedState.features, 10);

    await page.evaluate((file) => window.__gdsDebug.load(file), offGds);
    await page.waitForFunction(() => document.getElementById('mode-indicator')?.textContent === 'Provenance: OFF — click to associate .py');
    const offState = await page.evaluate(() => ({
      indicator: document.getElementById('mode-indicator').textContent,
      received: window.__gdsDebug.received.filter((message) => message.type === 'loadGds').at(-1),
      features: allFeatures.length,
    }));
    assert.equal(offState.indicator, 'Provenance: OFF — click to associate .py');
    assert.equal(offState.received.mode, 'partial');
    assert.match(JSON.stringify(offState.received), /covers 0\/8/, 'browser load message must report zero valid coverage');
    assert.equal(offState.features, 8);
    await page.evaluate((file) => window.__gdsDebug.load(file), blankGds);
    await page.waitForFunction(() => document.getElementById('mode-indicator')?.textContent === 'Provenance: OFF — click to associate .py');
    const blankState = await page.evaluate(() => ({
      indicator: document.getElementById('mode-indicator').textContent,
      received: window.__gdsDebug.received.filter((message) => message.type === 'loadGds').at(-1),
      features: allFeatures.length,
    }));
    assert.equal(blankState.indicator, 'Provenance: OFF — click to associate .py');
    assert.equal(blankState.received.mode, 'partial');
    assert.match(JSON.stringify(blankState.received), /covers 0\/4/, 'browser load message must report all-blank zero coverage');
    assert.equal(blankState.features, 4);
    browserSummary = { valid: validState.indicator, mixed: mixedState.indicator, off: offState.indicator, blank: blankState.indicator, sourceRequest, downloads };
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-provenance-coverage-'));
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-provenance-coverage-bundle-'));
  let preserveTemp = false;
  try {
    assert(fs.existsSync(PYTHON), `selected GDS Python does not exist: ${PYTHON}`);
    const validEntries = [entry(0, { line: 10 }), entry(1, { line: 20 })];
    const mixedEntries = [
      entry(0, { line: 10 }),
      entry(1, { file: undefined, line: 20 }),
      entry(2, { file: '', line: 30 }),
      entry(3, { file: '   ', line: 40 }),
      entry(4, { line: true }),
      entry(5, { line: 10.5 }),
      entry(6, { line: 0 }),
      entry(7, { line: -1 }),
      entry(8, { line: '50' }),
      entry(9, { line: 60 }),
    ];
    const offEntries = [
      entry(0, { file: undefined, line: true }),
      entry(1, { file: '', line: 10.5 }),
      entry(2, { file: '   ', line: 20 }),
      entry(3, { file: '   ', line: '30' }),
      entry(4, { file: 'source.py', line: 0 }),
      entry(5, { file: 'source.py', line: -1 }),
      entry(6, { file: 'source.py', line: '40' }),
      entry(7, { file: 'source.py', line: false }),
    ];
    const blankEntries = [
      entry(0, { file: '', line: 10 }),
      entry(1, { file: '', line: 20 }),
      entry(2, { file: '', line: 30 }),
      entry(3, { file: '', line: 40 }),
    ];
    const validGds = writeFixture(path.join(temp, 'valid'), validEntries);
    const mixedGds = writeFixture(path.join(temp, 'mixed'), mixedEntries);
    const offGds = writeFixture(path.join(temp, 'off'), offEntries);
    const blankGds = writeFixture(path.join(temp, 'blank'), blankEntries);
    const mixedGeometryOnlyGds = path.join(temp, 'mixed-geometry-only.gds');
    fs.copyFileSync(mixedGds, mixedGeometryOnlyGds);
    const parseGdsFileCore = bundleParser(bundleDir);
    const results = await Promise.all([
      parseGdsFileCore(PYTHON, validGds, ROOT),
      parseGdsFileCore(PYTHON, mixedGds, ROOT),
      parseGdsFileCore(PYTHON, offGds, ROOT),
      parseGdsFileCore(PYTHON, blankGds, ROOT),
    ]);
    const [valid, mixed, off, blank] = results;
    const mixedSidecar = path.join(temp, 'mixed', 'chip.provenance.json');
    const mixedSidecarText = fs.readFileSync(mixedSidecar, 'utf8');
    fs.rmSync(mixedSidecar);
    const mixedGeometryOnly = await parseGdsFileCore(PYTHON, mixedGeometryOnlyGds, ROOT);
    fs.writeFileSync(mixedSidecar, mixedSidecarText, 'utf8');
    assert.deepEqual(comparable(mixed), comparable(mixedGeometryOnly), 'provenance metadata must not alter physical geometry');
    assert.equal(valid.mode, 'full');
    assert.equal(mixed.mode, 'partial');
    assert.equal(off.mode, 'partial');
    assert.equal(blank.mode, 'partial');
    assert.equal(trackedCount(valid), 2);
    assert.equal(trackedCount(mixed), 2, 'API coverage must count only nonblank file + positive integer line');
    assert.equal(trackedCount(off), 0, 'invalid primary references must produce zero valid coverage');
    assert.equal(trackedCount(blank), 0, 'blank filenames with positive lines must produce zero valid coverage');
    assert(mixed.warnings.some((warning) => /covers 2\/10/.test(warning)), 'API warning must report precise mixed coverage');
    assert(off.warnings.some((warning) => /covers 0\/8/.test(warning)), 'API warning must report zero valid coverage');
    assert(blank.warnings.some((warning) => /covers 0\/4/.test(warning)), 'API warning must report all-blank zero coverage');
    assert.equal(mixed.geojson.features.length, 10);
    assert.equal(off.geojson.features.length, 8);
    assert.equal(mixed.geojson.features[1].properties.provenance.file, '', 'missing file metadata must be preserved as an empty string');
    assert.equal(mixed.geojson.features[3].properties.provenance.file, '   ', 'whitespace file metadata must be preserved');
    assert.equal(mixed.geojson.features[4].properties.provenance.line, true, 'boolean line metadata must be preserved');
    assert.equal(mixed.geojson.features[5].properties.provenance.line, 10.5, 'fractional line metadata must be preserved');
    assert.equal(mixed.geojson.features[8].properties.provenance.line, '50', 'string line metadata must be preserved');
    const browser = await browserContract(validGds, mixedGds, offGds, blankGds, temp, PYTHON);
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify({ status: 'passed', api: { mode: { valid: valid.mode, mixed: mixed.mode, off: off.mode, blank: blank.mode }, tracked: { valid: trackedCount(valid), mixed: trackedCount(mixed), off: trackedCount(off), blank: trackedCount(blank) }, warnings: { mixed: mixed.warnings, off: off.warnings, blank: blank.warnings } }, browser, python: PYTHON }, null, 2));
    console.log(JSON.stringify({ status: 'passed', checks: ['real-klayout-invalid-primary-matrix', 'precise-api-coverage', 'browser-on-partial-off', 'raw-metadata-geometry-preserved'], python: PYTHON }));
  } catch (error) {
    preserveTemp = true;
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'failure.json'), JSON.stringify({ status: 'failed', error: String(error), temp, python: PYTHON }, null, 2));
    throw error;
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
    if (!preserveTemp) fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
