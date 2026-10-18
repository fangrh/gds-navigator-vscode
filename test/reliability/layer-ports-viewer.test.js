'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { closeOwnedBrowser } = require('../../scripts/process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '../..');
const BROWSER = [process.env.GDS_BROWSER, process.env.GDS_TEST_BROWSER].filter(Boolean).find(fs.existsSync);
assert(BROWSER, 'required GDS_BROWSER/GDS_TEST_BROWSER headless shell is missing');
const REPORT_DIR = path.resolve(process.env.GDS_LAYER_PORTS_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'layer-ports'));

const polygon = (x) => ({ type: 'Polygon', coordinates: [[[x, 0], [x + 4, 0], [x + 4, 2], [x, 2], [x, 0]]] });
const fixture = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: polygon(0), properties: { layer: 1, data_type: 0, color: '#89b4fa', element_id: 'layout-a', provenance: { file: 'source_a.py', line: 11, function: 'make_a', cell: 'TOP_A' } } },
    { type: 'Feature', geometry: polygon(10), properties: { layer: 2, data_type: 0, color: '#f38ba8', element_id: 'layout-b', provenance: { file: 'source_b.py', line: 22, function: 'make_b', cell: 'TOP_B' } } },
  ],
  ports: [
    { id: 'port-a', name: 'optical_in_a', center: [2, 1], width: 0.5, orientation: 0, layer: [1, 0], coordinate_frame: 'layout', provenance: { cell: 'TOP_A', file: 'source_a.py', line: 11 } },
    { id: 'port-b', name: 'optical_in_b', center: [12, 1], width: 0.5, orientation: 180, layer: [2, 0], coordinate_frame: 'layout', provenance: { cell: 'TOP_B', file: 'source_b.py', line: 22 } },
  ],
};

function startHost() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/fixture.json') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(fixture));
    }
    const file = path.resolve(ROOT, `.${url.pathname}`);
    if (!file.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader('Content-Type', path.extname(file) === '.js' ? 'text/javascript' : 'text/html');
    return res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/webview/test-standalone.html?data=/fixture`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  cp.execFileSync(process.execPath, ['scripts/make-standalone.js'], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  const profile = fs.mkdtempSync(path.join(REPORT_DIR, 'browser-profile-'));
  const host = await startHost();
  let browser;
  let cleanup;
  let cleanupError;
  let hostError;
  let testError;
  let report;
  try {
    browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, userDataDir: profile, args: ['--no-first-run'] });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewport({ width: 1000, height: 800 });
    await page.goto(host.url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__viewerReady && allFeatures.length === 2 && portSource.getFeatures().length === 2);

    const initial = await page.evaluate(() => {
      map.renderSync();
      const rows = [...document.querySelectorAll('.legend-row')];
      const center = (id) => {
        const p = map.getPixelFromCoordinate(portFeatureById.get(id).getGeometry().getCoordinates());
        const r = map.getTargetElement().getBoundingClientRect();
        return [p[0] + r.left, p[1] + r.top];
      };
      window.__layerPortsProbe = {
        features: Object.fromEntries([...portFeatureById].map(([id, feature]) => [id, { feature, raw: feature.get('port') }])),
      };
      return {
        rows: rows.map((row) => row.textContent.trim()),
        layerCounts: [...featuresByLayer].map(([key, features]) => [key, features.length]),
        geometry: allFeatures.map((feature) => feature.getGeometry().getCoordinates()),
        provenance: allFeatures.map((feature) => feature.get('provenance')),
        ports: [...portFeatureById].map(([id, feature]) => ({ id, raw: feature.get('port'), pixel: center(id) })),
      };
    });
    assert.deepEqual(initial.layerCounts, [['1/0', 1], ['2/0', 1]]);
    assert.deepEqual(initial.rows, ['1/0 · 1', '2/0 · 1']);
    assert.deepEqual(initial.ports.map((port) => port.id), ['port-a', 'port-b']);

    await page.mouse.click(...initial.ports[0].pixel);
    await page.waitForFunction(() => selectedFeatures.getArray().some((feature) => feature.get('port')?.id === 'port-a'));
    const selectedBeforeHide = await page.evaluate(() => selectedFeatures.getArray().map((feature) => feature.get('port')?.id || feature.get('elementId')));
    assert.deepEqual(selectedBeforeHide, ['port-a']);

    await page.evaluate(() => [...document.querySelectorAll('.legend-row')].find((row) => row.textContent.trim().startsWith('1/0')).click());
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const hidden = await page.evaluate(() => {
      const hiddenPort = portFeatureById.get('port-a');
      addToSelection([hiddenPort]);
      replaceSelection([hiddenPort]);
      refreshPortOverlay();
      map.renderSync();
      const port = hiddenPort;
      const pixel = map.getPixelFromCoordinate(port.getGeometry().getCoordinates());
      const hit = map.forEachFeatureAtPixel(pixel, (feature) => feature.get('port')?.id || null, { hitTolerance: 8 });
      return {
        selected: selectedFeatures.getArray().map((feature) => feature.get('port')?.id || feature.get('elementId')),
        markerInSource: portSource.getFeatures().some((feature) => feature.get('port')?.id === 'port-a'),
        hit,
        hiddenFeature: allFeatures.find((feature) => feature.get('elementId') === 'layout-a').get('visible') === false,
        layerCounts: [...featuresByLayer].map(([key, features]) => [key, features.length]),
        rows: [...document.querySelectorAll('.legend-row')].map((row) => row.textContent.trim()),
      };
    });
    assert.deepEqual(hidden.selected, []);
    assert.equal(hidden.markerInSource, true, 'hidden imported port should retain identity for restore');
    assert.equal(hidden.hit, undefined, 'hidden imported port must not be hit selectable');
    assert.equal(hidden.hiddenFeature, true);
    assert.deepEqual(hidden.layerCounts, initial.layerCounts);
    assert.deepEqual(hidden.rows, initial.rows);

    const restored = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.legend-row')].find((candidate) => candidate.textContent.trim().startsWith('1/0'));
      row.click();
      return {
        sameFeature: portFeatureById.get('port-a') === window.__layerPortsProbe.features['port-a'].feature,
        sameRaw: portFeatureById.get('port-a').get('port') === window.__layerPortsProbe.features['port-a'].raw,
        raw: portFeatureById.get('port-a').get('port'),
        selected: selectedFeatures.getArray().map((feature) => feature.get('port')?.id || feature.get('elementId')),
        visible: allFeatures.find((feature) => feature.get('elementId') === 'layout-a').get('visible') !== false,
        count: portSource.getFeatures().length,
      };
    });
    assert.equal(restored.sameFeature, true, 'layer restore changed imported port feature identity');
    assert.equal(restored.sameRaw, true, 'layer restore changed imported raw port object identity');
    assert.deepEqual(restored.raw, initial.ports[0].raw, 'layer restore changed imported raw port data');
    assert.deepEqual(restored.selected, []);
    assert.equal(restored.visible, true);
    assert.equal(restored.count, 2);
    await page.mouse.click(...initial.ports[0].pixel);
    await page.waitForFunction(() => selectedFeatures.getArray().some((feature) => feature.get('port')?.id === 'port-a'));
    await page.evaluate(() => clearSelection());

    await page.evaluate(() => document.getElementById('port-names-visible').click());
    assert.deepEqual(await page.evaluate(() => ({ names: portNamesVisible, text: portLayer.getStyleFunction()(portFeatureById.get('port-a')).getText() })), { names: false, text: null });
    await page.evaluate(() => document.getElementById('port-names-visible').click());
    await page.mouse.click(...initial.ports[1].pixel);
    await page.waitForFunction(() => selectedFeatures.getArray().some((feature) => feature.get('port')?.id === 'port-b'));
    await page.evaluate(() => document.getElementById('ports-visible').click());
    assert.deepEqual(await page.evaluate(() => ({ layerVisible: portLayer.getVisible(), sourceCount: portSource.getFeatures().length, selected: selectedFeatures.getArray().map((feature) => feature.get('port')?.id || feature.get('elementId')) })), { layerVisible: false, sourceCount: 2, selected: [] });
    await page.evaluate(() => document.getElementById('ports-visible').click());

    const factoryPhase = await page.evaluate(async () => {
      const sourceGeometry = { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 2], [0, 2], [0, 0]]] };
      const factory = new ol.Feature({ geometry: new ol.geom.Polygon([[[30, 0], [34, 0], [34, 2], [30, 2], [30, 0]]]) });
      factory.setProperties({ isDrawn: true, layer: '1/0', annotationId: 'factory-shape', factory: { groupId: 'same-layer-factory', pieceIndex: 0, pieceCount: 1, name: 'same-layer-factory', sourceGeometry, ports: [{ name: 'factory_in', center: [1, 1], width: 0.5, orientation: 0, layer: [1, 0] }] } });
      const drawing = new ol.Feature({ geometry: new ol.geom.Polygon([[[36, 0], [39, 0], [39, 2], [36, 2], [36, 0]]]) });
      drawing.setProperties({ isDrawn: true, layer: '1/0', annotationId: 'ordinary-drawing', provenance: { file: 'drawings.json', line: 7 } });
      drawSource.addFeatures([factory, drawing]);
      await new Promise(requestAnimationFrame);
      refreshPortOverlay();
      fitView();
      await new Promise(resolve => setTimeout(resolve, 350));
      map.renderSync();
      const point = (id) => {
        const coordinate = id === 'factory' ? portFeatureById.get('factory:same-layer-factory:0').getGeometry().getCoordinates() : [37.5, 1];
        const pixel = map.getPixelFromCoordinate(coordinate), rect = map.getTargetElement().getBoundingClientRect();
        return [pixel[0] + rect.left, pixel[1] + rect.top];
      };
      return { factoryPort: portFeatureById.has('factory:same-layer-factory:0'), factoryGeometry: factory.getGeometry().getCoordinates(), drawingGeometry: drawing.getGeometry().getCoordinates(), factoryPoint: point('factory'), drawingPoint: point('drawing'), sourceIds: drawSource.getFeatures().map(feature => feature.get('annotationId')) };
    });
    assert.equal(factoryPhase.factoryPort, true);
    await page.mouse.click(...factoryPhase.factoryPoint);
    await page.waitForFunction(() => selectedFeatures.getArray().some((feature) => feature.get('port')?.id === 'factory:same-layer-factory:0'));
    await page.evaluate(() => clearSelection());
    await page.mouse.click(...factoryPhase.drawingPoint);
    await page.waitForFunction(() => selectedFeatures.getArray().some((feature) => feature.get('annotationId') === 'ordinary-drawing'));
    await page.evaluate(() => clearSelection());
    await page.evaluate(() => [...document.querySelectorAll('.legend-row')].find((row) => row.textContent.trim().startsWith('1/0')).click());
    await page.evaluate(() => { refreshPortOverlay(); map.renderSync(); });
    const factoryHiddenImported = await page.evaluate(() => ({
      importedVisible: portFeatureById.get('port-a').get('visible') !== false,
      factoryVisible: portFeatureById.get('factory:same-layer-factory:0').get('visible') !== false,
      factorySource: portSource.getFeatures().some(feature => feature.get('port')?.id === 'factory:same-layer-factory:0'),
      drawingVisible: drawSource.getFeatures().find(feature => feature.get('annotationId') === 'ordinary-drawing').get('visible') !== false,
      factoryGeometry: drawSource.getFeatures().find(feature => feature.get('factory')).getGeometry().getCoordinates(),
      drawingGeometry: drawSource.getFeatures().find(feature => feature.get('annotationId') === 'ordinary-drawing').getGeometry().getCoordinates(),
      sourceIds: drawSource.getFeatures().map(feature => feature.get('annotationId')),
    }));
    assert.equal(factoryHiddenImported.importedVisible, false);
    assert.equal(factoryHiddenImported.factoryVisible, true);
    assert.equal(factoryHiddenImported.factorySource, true);
    assert.equal(factoryHiddenImported.drawingVisible, true);
    assert.deepEqual(factoryHiddenImported.factoryGeometry, factoryPhase.factoryGeometry);
    assert.deepEqual(factoryHiddenImported.drawingGeometry, factoryPhase.drawingGeometry);
    assert.deepEqual(factoryHiddenImported.sourceIds, factoryPhase.sourceIds);
    await page.mouse.click(...factoryPhase.factoryPoint);
    await page.waitForFunction(() => selectedFeatures.getArray().some((feature) => feature.get('port')?.id === 'factory:same-layer-factory:0'));
    await page.evaluate(() => clearSelection());
    await page.mouse.click(...factoryPhase.drawingPoint);
    await page.waitForFunction(() => selectedFeatures.getArray().some((feature) => feature.get('annotationId') === 'ordinary-drawing'));
    await page.evaluate(() => clearSelection());

    const reload = await page.evaluate((data) => {
      refreshPortOverlay();
      loadGdsData(data, 'reload.gds', '', [], 'full');
      return { layerCounts: [...featuresByLayer].map(([key, features]) => [key, features.length]), rows: [...document.querySelectorAll('.legend-row')].map((row) => row.textContent.trim()), visible: allFeatures.every((feature) => feature.get('visible') !== false), portIds: [...portFeatureById.keys()].sort(), portVisible: ['port-a', 'port-b'].every((id) => portFeatureById.get(id)?.get('visible') !== false), selected: selectedFeatures.getLength(), geometry: allFeatures.map((feature) => feature.getGeometry().getCoordinates()), provenance: allFeatures.map((feature) => feature.get('provenance')) };
    }, fixture);
    assert.deepEqual(reload.layerCounts, initial.layerCounts);
    assert.deepEqual(reload.rows, initial.rows);
    assert.equal(reload.visible, true, 'reload retained stale layer visibility');
    assert.deepEqual(reload.portIds, ['port-a', 'port-b']);
    assert.equal(reload.portVisible, true, 'reload retained stale imported port visibility');
    assert.equal(reload.selected, 0);
    assert.deepEqual(reload.geometry, initial.geometry);
    assert.deepEqual(reload.provenance, initial.provenance);
    assert.deepEqual(pageErrors, []);
    report = { status: 'passed', layers: 2, importedPorts: 2, hiddenSelectionRemoved: true, hitSelectionDisabled: true, restoredIdentity: true, globalToggles: true, factoryIndependent: true, drawingIndependent: true, reloadClearsStaleVisibility: true, cleanup: null };
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    try {
      if (browser) cleanup = await closeOwnedBrowser(browser, { profileDir: profile });
    } catch (error) {
      cleanupError = error;
    }
    try {
      await host.close();
    } catch (error) {
      hostError = error;
    }
    if (report) {
      report.cleanup = cleanupError ? { verified: false, error: String(cleanupError), survivors: cleanup?.survivors || [] } : { pid: cleanup?.pid, verified: cleanup?.verified === true, survivors: cleanup?.survivors || [] };
      fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    } else {
      fs.writeFileSync(path.join(REPORT_DIR, 'failure.json'), `${JSON.stringify({
        status: 'failed',
        error: testError?.stack || cleanupError?.stack || hostError?.stack || 'test failed',
        profile,
        cleanup: cleanupError ? { verified: false, error: String(cleanupError), pid: cleanup?.pid, survivors: cleanup?.survivors || [] } : { verified: cleanup?.verified === true, pid: cleanup?.pid, survivors: cleanup?.survivors || [] },
      }, null, 2)}\n`);
    }
    if (cleanupError) throw cleanupError;
    if (hostError) throw hostError;
    if (cleanup && !cleanup.verified) throw new Error('browser process shutdown was not verified; temporary workspace retained');
    if (report && cleanup?.verified === true) {
      fs.rmSync(profile, { recursive: true, force: true });
      console.log(JSON.stringify(report));
    }
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
