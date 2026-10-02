'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const fixture = path.join(ROOT, 'test', 'fixtures', 'jj_pad_center_50_test.gds');
assert(fs.existsSync(fixture), 'real GDS fixture is missing');

function jsonRequest(base, pathname, body, method = 'POST', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = require('http').request({ hostname: url.hostname, port: url.port, path: url.pathname, method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...extraHeaders } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let value; try { value = text ? JSON.parse(text) : undefined; } catch { value = text; } resolve({ status: res.statusCode, headers: res.headers, value }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}

async function main() {
  const startServer = require(path.join(ROOT, 'scripts', 'serve-web.cjs')).startServer;
  assert.equal(typeof startServer, 'function', 'serve-web.cjs must export startServer');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-browser-host-'));
  const second = path.join(temp, 'second.gds'); fs.copyFileSync(fixture, path.join(temp, 'chip.gds')); fs.copyFileSync(fixture, second);
  const state = path.join(temp, 'state'); fs.mkdirSync(state);
  const python = process.env.GDS_PYTHON || (fs.existsSync(path.join(ROOT, '.venv-fork/Scripts/python.exe')) ? path.join(ROOT, '.venv-fork/Scripts/python.exe') : 'python');
  const { server, url, close } = await startServer({ port: 0, root: temp, stateDir: state, file: 'chip.gds', python });
  try {
    const config = await jsonRequest(url, '/api/config', undefined, 'GET');
    assert.equal(config.status, 200); assert(Array.isArray(config.value.files));
    assert.deepEqual(config.value.files.map(f => f.name).sort(), ['Built-in sample', 'chip.gds', 'second.gds']);
    assert.equal(path.basename(config.value.defaultFile), 'chip.gds');
    assert.equal((await jsonRequest(url, '/api/config', undefined, 'GET', { origin: 'https://example.com' })).status, 403);
    assert.equal((await jsonRequest(url, '/api/config', undefined, 'GET', { host: 'example.com' })).status, 403);
    assert.equal((await jsonRequest(url, '/.git/config', undefined, 'GET')).status, 404);

    const loaded = await jsonRequest(url, '/api/load', { path: 'chip.gds' });
    assert.equal(loaded.status, 200); const messages = loaded.value.messages || [];
    const load = messages.find(m => m.type === 'loadGds'); assert(load && load.geojson);
    assert.match(load.layoutHash || load.gdsHash, /^[a-f0-9]{64}$/); assert.equal(load.layoutHash, crypto.createHash('sha256').update(fs.readFileSync(path.join(temp, 'chip.gds'))).digest('hex'));
    assert(messages.some(m => m.type === 'reviewState')); assert(messages.some(m => m.type === 'instructions'));

    const secondLoad = await jsonRequest(url, '/api/load', { path: 'second.gds' });
    assert.equal(secondLoad.status, 200); assert.equal(path.basename(secondLoad.value.messages.find(m => m.type === 'loadGds').gdsPath), 'second.gds');
    const annotation = { id: 'browser-drawing', shapeType: 'polygon', geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] }, intent: { action: 'add', text: 'Browser proposal', targetIds: [] } };
    const save = await jsonRequest(url, '/api/message', { documentPath: 'chip.gds', message: { type: 'saveAnnotations', layoutHash: load.layoutHash, annotations: [annotation], recordInstruction: false, components: [] } });
    assert.equal(save.status, 200); assert(save.value.messages.some(m => m.type === 'annotationsSaved'));
    const reloaded = await jsonRequest(url, '/api/load', { path: 'chip.gds' });
    assert.equal(reloaded.value.messages.find(m => m.type === 'loadGds').annotations.length, 1);
    const isolated = await jsonRequest(url, '/api/load', { path: 'second.gds' });
    assert.equal(isolated.value.messages.find(m => m.type === 'loadGds').annotations.length, 0);

    const stale = await jsonRequest(url, '/api/message', { documentPath: 'chip.gds', message: { type: 'saveAnnotations', layoutHash: '0'.repeat(64), annotations: [annotation] } });
    assert.equal(stale.status, 200); assert(stale.value.messages.some(m => m.type === 'annotationsSaveFailed'));
    const malformed = await jsonRequest(url, '/api/message', { documentPath: 'chip.gds', message: { type: 'saveAnnotations', layoutHash: load.layoutHash, annotations: [{ id: 'bad', geometry: { type: 'Point', coordinates: ['x'] } }] } });
    assert.equal(malformed.status, 200); assert(malformed.value.messages.some(m => m.type === 'annotationsSaveFailed'));

    for (const bad of [{ path: '../chip.gds' }, { path: 'missing.gds' }]) assert((await jsonRequest(url, '/api/load', bad)).status >= 400);
    assert((await jsonRequest(url, '/api/load', { path: 'chip.gds' }, 'GET')).status >= 400);
    assert((await jsonRequest(url, '/api/message', { documentPath: '../chip.gds', message: { type: 'ping' } })).status >= 400);
    assert((await jsonRequest(url, '/api/message', { documentPath: 'chip.gds', message: { type: 'saveAnnotations', layoutHash: load.layoutHash, annotations: [] } }, 'GET')).status >= 400);

    const upload = await jsonRequest(url, '/api/upload', { name: 'uploaded.gds', base64: fs.readFileSync(fixture).toString('base64') });
    assert.equal(upload.status, 200); assert(upload.value.path && fs.existsSync(upload.value.path));
    const oversized = await jsonRequest(url, '/api/upload', { name: 'too.gds', base64: 'A'.repeat(44 * 1024 * 1024) }); assert(oversized.status >= 400);

    const feature = load.geojson.features[0];
    const exported = await jsonRequest(url, '/api/message', { documentPath: 'chip.gds', message: { type: 'exportYaml', layoutHash: load.layoutHash, components: [{ provId: feature.properties.element_id, geometry: feature.geometry, drawn: false, primitive: { layer: [feature.properties.layer, feature.properties.data_type] } }], request: { action: 'inspect', text: 'Export this layout' } } });
    assert.equal(exported.status, 200); assert(exported.value.clipboard && /gds-navigator|schema:/.test(exported.value.clipboard.text));
    const order = await jsonRequest(url, '/api/message', { documentPath: 'chip.gds', message: { type: 'instructionAction', action: 'add', workOrder: true, requestId: 'browser-order', layoutHash: load.layoutHash, request: { action: 'inspect', text: 'Review the selected pad', targetIds: [String(feature.properties.element_id)] }, components: [{ provId: feature.properties.element_id, drawn: false, geometry: feature.geometry }] } });
    assert.equal(order.status, 200); assert(order.value.messages.some(m => m.type === 'instructions'));
    const review = { version: 1, bookmarks: [{ id: 'overview', name: 'Overview', center: [0, 0], resolution: 1, rotation: 0, visibleLayers: [] }], measurements: [] };
    const savedReview = await jsonRequest(url, '/api/message', { documentPath: 'chip.gds', message: { type: 'saveReviewState', layoutHash: load.layoutHash, state: review, requestId: 'review' } });
    assert(savedReview.value.messages.some(m => m.type === 'reviewStateSaved'));
    const reviewLoad = await jsonRequest(url, '/api/load', { path: 'chip.gds' });
    assert.deepEqual(reviewLoad.value.messages.find(m => m.type === 'reviewState').state, review);
    const catalog = await jsonRequest(url, '/api/message', { documentPath: 'chip.gds', message: { type: 'requestComponentCatalog', requestId: 'catalog' } });
    const catalogResult = catalog.value.messages.find(m => m.type === 'componentCatalog');
    assert(catalogResult?.result.components.some(c => c.name === 'straight'), JSON.stringify(catalog.value));
    const preview = await jsonRequest(url, '/api/message', { documentPath: 'chip.gds', message: { type: 'previewComponent', requestId: 'preview', name: 'straight', settings: {} } });
    assert(preview.value.messages.find(m => m.type === 'componentPreview')?.result.geojson.features.length > 0, JSON.stringify(preview.value));
    const report = { status: 'passed', checks: ['config-files', 'real-gds-load-hash', 'annotation-save-reload-isolation', 'stale-malformed-rejection', 'path-method-origin-rejection', 'bounded-upload', 'yaml-export', 'work-order-create', 'review-persistence', 'real-component-catalog-preview'] };
    const output = path.join(ROOT, 'logs/reliability/browser-host'); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'api-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
