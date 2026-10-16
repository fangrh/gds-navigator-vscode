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
const REPORT_DIR = path.resolve(process.env.GDS_STACK_BROWSER_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'placement-call-stack'));

function makeFixtureScript() {
  return String.raw`import json, sys
import klayout.db as kdb

directory, sidecar = sys.argv[1], json.loads(sys.argv[2])
layout = kdb.Layout(); layout.dbu = 0.001
top = layout.create_cell('TOP'); child = layout.create_cell('CHILD'); layer = layout.layer(4, 0)
creation = child.shapes(layer).insert(kdb.Box(0, 0, 1000, 1000)); creation.set_property(1002, 7)
top.insert(kdb.CellInstArray(child.cell_index(), kdb.Trans(4000, 0))).set_property(1005, json.dumps({'instance_prov_id': 9, 'file': 'source.py', 'line': 42}))
gds = directory + '/chip.gds'; layout.write(gds)
with open(directory + '/chip.provenance.json', 'w', encoding='utf-8') as handle:
    json.dump({'version': 1, 'entries': sidecar, 'ports': {}, 'ref_names': {}}, handle)
print(gds)
`;
}

function makeEntries(withMalformedFrames) {
  return [
    { id: 7, file: 'source.py', line: 10, function: 'create', component: 'CHILD' },
    {
      id: 9,
      file: 'source.py',
      line: 42,
      function: 'place',
      component: 'CHILD',
      instance_path: 'TOP/ref[3]',
      loop_index: ['i', 3],
      call_stack: withMalformedFrames
        ? [null, { file: 'object-frame.py', line: 8 }, 'helper.py:12 in helper', 'malformed frame']
        : ['helper.py:12 in helper'],
    },
  ];
}

function writeFixture(directory, withMalformedFrames) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'source.py'), Array.from({ length: 70 }, (_, index) => `# source fixture line ${index + 1}`).join('\n') + '\n', 'utf8');
  return execFileSync(PYTHON, ['-c', makeFixtureScript(), directory, JSON.stringify(makeEntries(withMalformedFrames))], { cwd: ROOT, encoding: 'utf8' }).trim();
}

function comparable(result) {
  return result.geojson.features.map((feature) => ({
    geometry: feature.geometry,
    layer: feature.properties.layer,
    data_type: feature.properties.data_type,
    bbox: feature.properties.bbox,
  }));
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

async function browserContract(gds, temp, python, expectedSource) {
  assert(BROWSER && fs.existsSync(BROWSER), 'required GDS_BROWSER or GDS_TEST_BROWSER headless shell is missing');
  const { startServer } = require(path.join(ROOT, 'scripts', 'serve-web.cjs'));
  const profile = path.join(temp, 'browser-profile');
  const downloads = path.join(temp, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  let host;
  let browser;
  let cleanup;
  let cleanupError;
  let operationError;
  let result;
  try {
    host = await startServer({ root: temp, stateDir: path.join(temp, 'browser-state'), file: path.relative(temp, gds), python });
    browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, userDataDir: profile, args: ['--no-first-run'] });
    const page = await browser.newPage();
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await page.goto(host.url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__gdsReady && document.getElementById('mode-indicator')?.textContent === 'Provenance: ON');
    const state = await page.evaluate(() => ({
      indicator: document.getElementById('mode-indicator').textContent,
      features: allFeatures.length,
      provenance: allFeatures.find((feature) => feature.get('provenance')?.placement_line)?.get('provenance'),
    }));
    assert.equal(state.indicator, 'Provenance: ON');
    assert.equal(state.features, 1);
    assert.equal(state.provenance.file, 'source.py');
    assert.equal(state.provenance.line, 42);
    assert.equal(state.provenance.placement_line, 42);
    assert.deepEqual(state.provenance.loop_index, ['i', 3]);
    assert.deepEqual(state.provenance.call_chain.map((frame) => [path.basename(frame.file), frame.line, frame.function]), [['source.py', 42, 'place'], ['helper.py', 12, 'helper']]);

    const pixel = await page.evaluate(() => {
      map.renderSync();
      const point = map.getPixelFromCoordinate([4.5, 0.5]);
      const rect = map.getTargetElement().getBoundingClientRect();
      return [point[0] + rect.left, point[1] + rect.top];
    });
    await page.mouse.click(...pixel, { button: 'right' });
    await page.waitForSelector('#canvas-context-menu', { visible: true });
    await page.click('#canvas-context-menu [data-action="review-more"]');
    await page.waitForFunction(() => !document.querySelector('#canvas-context-menu [data-action="source-navigation"]')?.hidden);
    await page.click('#canvas-context-menu [data-action="source-navigation"]');
    await page.waitForFunction(() => window.__gdsDebug.sent.some((message) => message.type === 'requestSource'));
    const sourceRequest = await page.evaluate(() => window.__gdsDebug.sent.filter((message) => message.type === 'requestSource').at(-1));
    assert.equal(fs.realpathSync(sourceRequest.file), fs.realpathSync(expectedSource));
    assert.equal(sourceRequest.line, 42);
    await page.waitForFunction(() => /Source downloaded: source\.py:42/.test(document.getElementById('browser-host-status')?.textContent || ''));
    const downloadedSource = path.join(downloads, 'source.py');
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(downloadedSource) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert(fs.existsSync(downloadedSource), 'source action did not produce a configured browser download');
    assert.deepEqual(fs.readFileSync(downloadedSource), fs.readFileSync(expectedSource), 'downloaded source bytes changed');
    result = { indicator: state.indicator, features: state.features, sourceRequest, download: downloadedSource };
  } catch (error) {
    operationError = error;
  } finally {
    // Cleanup evidence is returned with a successful result or attached to the
    // original failure so reports show the actual owned-process verification.
    if (browser) {
      try { cleanup = await closeOwnedBrowser(browser, { profileDir: profile }); } catch (error) { cleanupError = error; }
    }
    if (host) {
      try { await host.close(); } catch (error) { cleanupError ||= error; }
    }
    const cleanupEvidence = { browser: cleanup || null, error: cleanupError ? String(cleanupError) : null };
    if (result) result.cleanup = cleanupEvidence;
    if (operationError) operationError.cleanupEvidence = cleanupEvidence;
    if (cleanupError) {
      const error = cleanupError;
      error.cleanupEvidence = cleanupEvidence;
      throw error;
    }
    if (cleanup && !cleanup.verified) {
      const error = new Error('browser process shutdown was not verified; temporary workspace retained');
      error.cleanupEvidence = cleanupEvidence;
      throw error;
    }
  }
  if (operationError) throw operationError;
  return result;
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-placement-call-stack-'));
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-placement-call-stack-bundle-'));
  let preserveTemp = false;
  try {
    execFileSync(PYTHON, [path.join(ROOT, 'test', 'reliability', 'placement-call-stack.test.py')], { cwd: ROOT, stdio: 'inherit' });
    const malformedDir = path.join(temp, 'malformed');
    const strippedDir = path.join(temp, 'stripped');
    const malformedGds = writeFixture(malformedDir, true);
    const strippedGds = writeFixture(strippedDir, false);
    const parseGdsFileCore = bundleParser(bundleDir);
    const malformed = await parseGdsFileCore(PYTHON, malformedGds, ROOT);
    const stripped = await parseGdsFileCore(PYTHON, strippedGds, ROOT);
    assert.equal(malformed.mode, 'full');
    assert.equal(stripped.mode, 'full');
    assert.deepEqual(comparable(malformed), comparable(stripped), 'optional call-stack frames changed geometry, layer, or bbox');
    assert.equal(malformed.geojson.features.length, 1);
    const provenance = malformed.geojson.features[0].properties.provenance;
    assert.equal(provenance.file, 'source.py');
    assert.equal(provenance.line, 42);
    assert.equal(provenance.placement_line, 42);
    assert.deepEqual(provenance.loop_index, ['i', 3]);
    assert.deepEqual(provenance.call_chain, [
      { file: 'source.py', line: 42, function: 'place' },
      { file: 'helper.py', line: 12, function: 'helper' },
    ]);
    assert.deepEqual(provenance, stripped.geojson.features[0].properties.provenance, 'invalid optional frames changed retained provenance');
    const browser = await browserContract(malformedGds, temp, PYTHON, path.join(malformedDir, 'source.py'));
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify({
      status: 'passed',
      python: PYTHON,
      checks: ['mixed-optional-call-stack-api-full-mode', 'geometry-layer-bbox-parity', 'placement-source-loop-index-call-chain', 'browser-provenance-source-download'],
      malformedMode: malformed.mode,
      strippedMode: stripped.mode,
      featureCount: malformed.geojson.features.length,
      browser,
      cleanup: browser.cleanup,
    }, null, 2));
    console.log(JSON.stringify({ status: 'passed', checks: ['mixed-optional-call-stack-api', 'browser-source-navigation'], python: PYTHON }));
  } catch (error) {
    preserveTemp = true;
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'failure.json'), JSON.stringify({ status: 'failed', error: String(error), cleanup: error.cleanupEvidence || null, temp, python: PYTHON }, null, 2));
    throw error;
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
    if (!preserveTemp) fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
