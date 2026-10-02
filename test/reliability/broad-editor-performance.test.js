'use strict';

// Real-browser counter gate for the bounded viewer optimizations. This file is
// intentionally not run by the controller while another agent owns browser
// profiling; invoke it separately with GDS_BROWSER when the browser gate is free.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { startServer } = require('../../scripts/serve-web.cjs');
const { renderViewer } = require('../../scripts/render-viewer.cjs');

const ROOT = path.resolve(__dirname, '../..');
const baseline = require('../fixtures/performance-baseline.json');
const BROWSER = process.env.GDS_BROWSER;
assert(BROWSER && fs.existsSync(BROWSER), 'Set GDS_BROWSER to an installed browser');

function fixture() {
  return { type: 'FeatureCollection', features: Array.from({ length: 1000 }, (_, i) => ({
    type: 'Feature', properties: { element_id: `broad-${i}`, layer: i % 4 + 1, data_type: 0, color: '#89b4fa', provenance: { file: 'fixture.py', line: i + 1 } },
    geometry: { type: 'Polygon', coordinates: [[[i, 0], [i + .5, 0], [i + .5, 1], [i, 1], [i, 0]]] },
  })) };
}

const probe = `
window.__broad = { metadata: 0, metadataEvents: 0, json: 0, coordinates: 0, portSets: 0, domRows: 0, domOptions: 0 };
(function () {
  var keys = new Set(['elementId','layer','color','layerKey','visible','selected','provenance','meta']);
  var fp=ol.Feature.prototype,oldNotify=fp.notify,oldDispatch=fp.dispatchEvent;
  fp.notify=function(key,oldValue){if(keys.has(key))window.__broad.metadata++;return oldNotify.call(this,key,oldValue);};
  fp.dispatchEvent=function(event){if(event&&event.type==='propertychange'&&keys.has(event.key))window.__broad.metadataEvents++;return oldDispatch.apply(this,arguments);};
  var oldJson = JSON.stringify; JSON.stringify = function () { if (window.__broad.countJson) window.__broad.json++; return oldJson.apply(this, arguments); };
  var oldCoords = ol.geom.Point.prototype.setCoordinates; ol.geom.Point.prototype.setCoordinates = function () { if (window.__broad.countPorts) window.__broad.coordinates++; return oldCoords.apply(this, arguments); };
  var oldCreate = document.createElement.bind(document); document.createElement = function (tag) { if (window.__broad.countDom && String(tag).toLowerCase() === 'div') window.__broad.domRows++; if (window.__broad.countDom && String(tag).toLowerCase() === 'option') window.__broad.domOptions++; return oldCreate(tag); };
}());`;

async function openVariant(browser, host, before = false) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.isNavigationRequest() && request.url() === `${host.url}/`) {
      let body = renderViewer({ browser: true });
      if (before) {
        const overrides = Object.values(baseline.functions).join('\n') + '\nrouteStyleCache=boundedStyleCache(96);vectorStyleCache=boundedStyleCache(256);portStyleCache=boundedStyleCache(128);\n' + Object.entries(baseline.styles).map(([layer, fn]) => layer + '.setStyle(' + fn + ');').join('\n');
        body = body.replace('</body>', '<script>' + overrides.replace(/<\/script/gi, '<\\/script') + '</script></body>');
      }
      body = body.replace('<script src="/media/ol.js"></script>', `<script src="/media/ol.js"></script><script>${probe}</script>`);
      const csp = "default-src 'none'; connect-src 'self'; worker-src blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; font-src 'self'";
      body = body.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
      void request.respond({ status: 200, contentType: 'text/html', body });
    } else void request.continue();
  });
  await page.goto(host.url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.allFeatures && allFeatures.length === 1000, { timeout: 30000 });
  return page;
}

async function collect(page) {
  return page.evaluate(async () => {
    const initial = {
      metadata: __broad.metadata, metadataEvents: __broad.metadataEvents,
      geometry: JSON.stringify(allFeatures[17].getGeometry().getCoordinates()),
      properties: { id: allFeatures[17].get('elementId'), layer: allFeatures[17].get('layer'), provenance: allFeatures[17].get('provenance') },
    };
    const route = { get: key => key === 'route' ? { width: 4 } : key === 'selected' ? false : undefined };
    const vector = vectorLayer.getStyleFunction(), draw = drawLayer.getStyleFunction();
    __broad.countJson = true; __broad.json = 0;
    const first = vector(allFeatures[17]), routeFirst = draw({ get: key => key === 'route' ? { width: 4 } : key === 'selected' ? false : undefined }, 2);
    draw(route, 2);
    let styleKeyBuilds = 0;
    if (typeof styleKey === 'function') { const originalKey = styleKey; window.styleKey = function () { styleKeyBuilds++; return originalKey.apply(this, arguments); }; }
    for (let i = 0; i < 100; i++) { vector(allFeatures[17]); draw(route, 2); }
    const styleWarmJson = __broad.json, warmStyleKeyBuilds = styleKeyBuilds;
    const styles = []; for (let i = 0; i < 100; i++) styles.push(draw({ get: key => key === 'route' ? { width: i + 10 } : key === 'selected' ? false : undefined }, 2));
    const evicted = draw(route, 2) !== routeFirst;
    const transitions = { normal: vector(allFeatures[17]) === first, selected: vector({ get: key => key === 'selected' ? true : key === 'label' ? '' : undefined }) !== first };

    __broad.countPorts = true; __broad.coordinates = 0; __broad.portSets = 0;
    const originalPortSet = ol.Feature.prototype.set;
    ol.Feature.prototype.set = function (key, value, silent) { if (key === 'port') __broad.portSets++; return originalPortSet.call(this, key, value, silent); };
    layoutPortRecords = [{ id: 'probe-port', center: [1, 2], name: 'P', layer: [1, 0] }]; refreshPortOverlay();
    __broad.coordinates = 0; __broad.portSets = 0; refreshPortOverlay();
    const unchangedPort = { coordinates: __broad.coordinates, portSets: __broad.portSets };
    layoutPortRecords = [{ id: 'probe-port', center: [2, 3], name: 'Q', layer: [1, 0] }]; refreshPortOverlay();
    const changedPort = { coordinates: __broad.coordinates, portSets: __broad.portSets, name: portFeatureById.get('probe-port').get('port').name };
    layoutPortRecords = []; refreshPortOverlay();
    const removedPort = !portFeatureById.has('probe-port');

    __broad.countDom = true; __broad.domRows = 0; __broad.domOptions = 0;
    const one = { imageId: 'one', name: 'one.png', visible: true, locked: true, opacity: 1, img: { naturalWidth: 10, naturalHeight: 10 }, display: {}, quality: { status: 'unverified' } };
    microImages = [one]; microImg = one; microLayer = null; imageBusy = false; currentMode = 'select'; updateImageControls();
    __broad.domRows = 0; __broad.domOptions = 0;
    for (let i = 0; i < 200; i++) { one.cx = i; imageFeedback = 'pose'; imageSaveStatus = 'Saving'; updateImageControls(); }
    const stableDom = { rows: __broad.domRows, options: __broad.domOptions };
    const two = { imageId: 'two', name: 'two.png', visible: true, locked: false, opacity: .5, img: { naturalWidth: 10, naturalHeight: 10 }, display: {}, quality: { status: 'unverified' } };
    microImages.push(two); selectMicroImage(1); two.visible = false; two.opacity = .7; imageBusy = true; updateImageControls();
    const listChanged = { rows: document.querySelectorAll('.image-stack-row').length, options: document.querySelectorAll('#image-select option').length, disabled: document.querySelector('.image-stack-row input').disabled };
    imageBusy=false;updateImageControls();
    const replacement={...two};microImages[1]=replacement;microImg=replacement;updateImageControls();
    document.querySelector('.image-stack-row button').click();
    const restoredImageSelection=microImg===replacement;
    return { initial, styleWarmJson, styleKeyBuilds: warmStyleKeyBuilds, evicted, transitions, unchangedPort, changedPort, removedPort, stableDom, listChanged, restoredImageSelection };
  });
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-broad-editor-'));
  fs.writeFileSync(path.join(temp, 'layout.geojson'), JSON.stringify(fixture()));
  const host = await startServer({ port: 0, root: temp, file: 'layout.geojson', stateDir: path.join(temp, 'state') });
  const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
  try {
    const pages = [await openVariant(browser, host, true), await openVariant(browser, host)];
    const [before, after] = await Promise.all(pages.map(collect));
    assert(before.initial.metadata >= 8000, `baseline metadata notification probe too small: ${before.initial.metadata}`);
    assert.equal(after.initial.metadata, 0, 'initial metadata assignment still performed notification checks');
    assert.equal(before.initial.metadataEvents,0);assert.equal(after.initial.metadataEvents,0);
    assert.deepEqual(after.initial.geometry, before.initial.geometry);
    assert.deepEqual(after.initial.properties, before.initial.properties);
    assert.equal(after.styleWarmJson, 0, 'warm style callbacks rebuilt serialization keys');
    assert.equal(after.styleKeyBuilds, 0, 'warm callbacks rebuilt primitive style keys');
    assert.equal(after.evicted, true); assert.equal(after.transitions.normal, true); assert.equal(after.transitions.selected, true);
    assert.deepEqual(after.unchangedPort, { coordinates: 0, portSets: 0 });
    assert.deepEqual(after.changedPort, { coordinates: 1, portSets: 1, name: 'Q' });
    assert.equal(after.removedPort, true);
    assert.deepEqual(after.stableDom, { rows: 0, options: 0 });
    assert.deepEqual(after.listChanged, { rows: 2, options: 2, disabled: true });
    assert.equal(after.restoredImageSelection, true, 'rows retained callbacks for replaced/restored image objects');
    const report = { status: 'passed', before, after, featureCount: 1000, poseUpdates: 200 };
    const out = path.join(ROOT, 'logs/broad-performance/interaction'); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: 'passed', metadata: [before.initial.metadata, after.initial.metadata], stableDom: after.stableDom, unchangedPort: after.unchangedPort }));
  } finally { await browser.close(); await host.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
