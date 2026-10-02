const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-route-export-reliability-'));
const bundle = path.join(tmp, 'selection-export.cjs');
buildSync({ entryPoints: [path.join(root, 'src/selectionExport.ts')], bundle: true, platform: 'node', outfile: bundle });
const exporter = require(bundle);

function annotation(id, coordinates, route) {
    return { id, provId: id, drawn: true, shapeType: 'route', geometry: { type: 'LineString', coordinates }, route,
        intent: { action: 'add', text: 'route test', targetIds: [] } };
}

// Legacy v1 Manhattan records remain valid and export byte-for-byte as route metadata.
const legacyRoute = { version: 1, horizontalFirst: true, width: 2.5, layer: [7, 3] };
const legacy = annotation('legacy', [[0, 0], [8, 0], [8, 4]], legacyRoute);
assert.equal(exporter.validateAnnotations([legacy]), true);
const legacyDoc = exporter.selectionDocument('layout.gds', 'hash', [legacy], 'TOP');
assert.deepEqual(legacyDoc.annotations[0].route, legacyRoute);
assert.equal(legacyDoc.annotations[0].route_convention.geometry, 'Manhattan centerline');

// Octilinear accepts horizontal, vertical, and exact 45-degree segments.
const octRoute = { version: 1, horizontalFirst: true, width: 1.25, layer: [11, 2], style: 'octilinear', method: 'guided', clearance: 0.4 };
const oct = annotation('oct', [[0, 0], [4, 0], [8, 4], [8, 7]], octRoute);
assert.equal(exporter.validateAnnotations([oct]), true);
const octDoc = exporter.selectionDocument('layout.gds', 'hash', [oct], 'TOP');
assert.deepEqual(octDoc.annotations[0].route, octRoute);
assert.equal(octDoc.annotations[0].route_convention.geometry, 'H/V/45 centerline');
assert.deepEqual(octDoc.annotations[0].route.layer, [11, 2]);

// Guided and automatic route methods survive export/annotation roundtrip.
for (const method of ['guided', 'auto']) {
    const route = { ...octRoute, method };
    const source = annotation('method-' + method, [[1, 1], [5, 1], [9, 5]], route);
    const doc = exporter.selectionDocument('layout.gds', 'hash', [source], 'TOP');
    assert.deepEqual(doc.annotations[0].route, route);
    assert.equal(doc.annotations[0].route.method, method);
}

assert.equal(exporter.validateAnnotations([annotation('bad-diagonal', [[0, 0], [4, 3]], octRoute)]), false, 'non-45 diagonal rejected');
assert.equal(exporter.validateAnnotations([annotation('bad-style', [[0, 0], [1, 0]], { ...legacyRoute, style: 'curved' })]), false, 'unknown style rejected');
assert.equal(exporter.validateAnnotations([annotation('bad-style-type', [[0, 0], [1, 0]], { ...legacyRoute, style: 45 })]), false, 'non-string style rejected');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify({ status: 'passed', checks: ['legacy-manhattan-v1', 'octilinear-hv45', 'guided-method-roundtrip', 'auto-method-roundtrip', 'non45-rejection', 'bad-style-rejection'] }));
