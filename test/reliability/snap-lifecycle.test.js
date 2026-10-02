'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
const BROWSER = [
  process.env.GDS_BROWSER,
  path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].filter(Boolean).find(fs.existsSync);
assert(BROWSER, 'Set GDS_BROWSER to an installed browser');

const feature = (id, coordinates, provenance) => ({
  type: 'Feature',
  properties: {
    element_id: id,
    layer: 4,
    data_type: 0,
    color: '#89b4fa',
    provenance: provenance || { file: `${id}.py`, line: 7 },
  },
  geometry: { type: 'Polygon', coordinates: [coordinates] },
});

const layouts = {
  'snap-a.geojson': {
    type: 'FeatureCollection',
    features: [feature('a', [[100, 100], [120, 100], [120, 120], [100, 120], [100, 100]])],
  },
  'snap-b.geojson': {
    type: 'FeatureCollection',
    features: [feature('b', [[300, 300], [325, 300], [325, 325], [300, 325], [300, 300]], { file: 'b.py', line: 11 })],
  },
};

async function snapAt(page, interaction, coordinate) {
  return page.evaluate(({ name, coordinate }) => {
    const pixel = map.getPixelFromCoordinate(coordinate);
    const result = window[name].snapTo(pixel, coordinate, map);
    return result && { vertex: result.vertex.slice(), featureId: result.feature.get('elementId') };
  }, { name: interaction, coordinate });
}

async function state(page) {
  return page.evaluate(() => ({
    active: snapActive,
    attached: [snapGds, snapDraw, snapGrid].map(interaction => interaction.getMap() === map),
    order: map.getInteractions().getArray().slice(-3).map(interaction =>
      interaction === snapGds ? 'snapGds' : interaction === snapDraw ? 'snapDraw' : interaction === snapGrid ? 'snapGrid' : 'other'),
    ids: allFeatures.map(f => f.get('elementId')),
    geometry: allFeatures.map(f => f.getGeometry().getCoordinates()),
    provenance: allFeatures.map(f => f.get('provenance')),
  }));
}

async function main() {
  const startServer = require(path.join(ROOT, 'scripts', 'serve-web.cjs')).startServer;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-snap-lifecycle-'));
  for (const [name, value] of Object.entries(layouts)) fs.writeFileSync(path.join(temp, name), JSON.stringify(value));
  const host = await startServer({ port: 0, root: temp, stateDir: path.join(temp, 'state'), file: 'snap-a.geojson' });
  let browser;
  const pageErrors = [];
  try {
    browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
    const page = await browser.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(host.url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => allFeatures.length === 1 && currentGdsPath.endsWith('snap-a.geojson'));

    const initial = await state(page);
    assert.equal(initial.active, false);
    assert.deepEqual(initial.attached, [false, false, false], 'snap interactions must be detached while off');
    assert.deepEqual(initial.order, ['other', 'other', 'other']);
    assert.equal(initial.ids.length, 1);
    assert.deepEqual(initial.geometry, [[[[100, 100], [120, 100], [120, 120], [100, 120], [100, 100]]]]);
    assert.deepEqual(initial.provenance[0], { file: 'a.py', line: 7, source_resolution: 'unavailable' });

    await page.click('[data-mode="snap"]');
    assert.deepEqual((await state(page)).attached, [true, true, true]);
    assert.deepEqual((await state(page)).order, ['snapGds', 'snapDraw', 'snapGrid']);
    assert.deepEqual(await snapAt(page, 'snapGds', [100, 100]), { vertex: [100, 100], featureId: initial.ids[0] });

    // The drawing index follows add, edit, and removal through the public Snap API.
    const drawingCheck = await page.evaluate(() => {
      const drawing = new ol.Feature({ geometry: new ol.geom.LineString([[150, 150], [170, 150]]) });
      drawing.set('elementId', 'drawing-1');
      drawSource.addFeature(drawing);
      const first = snapDraw.snapTo(map.getPixelFromCoordinate([150, 150]), [150, 150], map);
      drawing.getGeometry().setCoordinates([[180, 180], [200, 180]]);
      const oldAfterEdit = snapDraw.snapTo(map.getPixelFromCoordinate([150, 150]), [150, 150], map);
      const newAfterEdit = snapDraw.snapTo(map.getPixelFromCoordinate([180, 180]), [180, 180], map);
      drawSource.removeFeature(drawing);
      const afterRemove = snapDraw.snapTo(map.getPixelFromCoordinate([180, 180]), [180, 180], map);
      return { first: first && first.feature.get('elementId'), oldAfterEdit: oldAfterEdit && oldAfterEdit.feature.get('elementId'), newAfterEdit: newAfterEdit && newAfterEdit.feature.get('elementId'), afterRemove: afterRemove && afterRemove.feature.get('elementId') };
    });
    assert.deepEqual(drawingCheck, { first: 'drawing-1', oldAfterEdit: null, newAfterEdit: 'drawing-1', afterRemove: null });

    // Turning snapping off, replacing the document, then enabling it must not retain A.
    await page.click('[data-mode="snap"]');
    assert.deepEqual((await state(page)).attached, [false, false, false]);
    await page.evaluate(() => window.__gdsDebug.load('snap-b.geojson'));
    await page.waitForFunction(() => allFeatures.length === 1 && currentGdsPath.endsWith('snap-b.geojson'));
    await page.click('[data-mode="snap"]');
    assert.deepEqual(await snapAt(page, 'snapGds', [100, 100]), null);
    const bState = await state(page);
    assert.deepEqual(await snapAt(page, 'snapGds', [300, 300]), { vertex: [300, 300], featureId: bState.ids[0] });

    // Reload while enabled: the enabled state and interaction order survive, with A indexed.
    await page.evaluate(() => window.__gdsDebug.load('snap-a.geojson'));
    await page.waitForFunction(() => allFeatures.length === 1 && currentGdsPath.endsWith('snap-a.geojson'));
    assert.deepEqual((await state(page)).attached, [true, true, true]);
    assert.deepEqual((await state(page)).order, ['snapGds', 'snapDraw', 'snapGrid']);
    assert.deepEqual(await snapAt(page, 'snapGds', [300, 300]), null);
    assert.deepEqual(await snapAt(page, 'snapGds', [100, 100]), { vertex: [100, 100], featureId: (await state(page)).ids[0] });
    const final = await state(page);
    assert.deepEqual(final.geometry, [[[[100, 100], [120, 100], [120, 120], [100, 120], [100, 100]]]]);
    assert.deepEqual(final.provenance[0], { file: 'a.py', line: 7, source_resolution: 'unavailable' });
    assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('; ')}`);
    console.log(JSON.stringify({ status: 'passed', checks: ['off-detached', 'gds-snapTo', 'draw-add-edit-remove', 'off-reload-no-stale-index', 'on-reload-reindexed', 'interaction-order', 'geometry-provenance-order', 'no-page-errors'] }));
  } finally {
    if (browser) await browser.close();
    await host.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
