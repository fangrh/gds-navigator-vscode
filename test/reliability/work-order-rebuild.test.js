const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '../..');
const out = path.join(require('os').tmpdir(), `work-order-tracking-${process.pid}.cjs`);
buildSync({ entryPoints: [path.join(root, 'src/workOrderTracking.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out });
const { trackWorkOrder } = require(out);
const reportDir = path.join(root, 'logs/reliability/work-order-tracking');
fs.mkdirSync(reportDir, { recursive: true });
const polygon = (x = 0) => ({ type: 'Polygon', coordinates: [[[x, 0], [x + 2, 0], [x + 2, 1], [x, 0]]] });
const item = (provId, x, provenance = {}, layer = '1/0') => ({ provId, layer, geometry: polygon(x), provenance });
const makeRecord = (gdsHash, ids, extras = {}) => ({
    gdsPath: extras.gdsPath || 'chip.gds', gdsHash, request: { action: 'move', text: 'move selected targets', targetIds: ids },
    components: (extras.components || ids.map((id, i) => ({ provId: id, geometry: polygon(i * 10), layer: '1/0', provenance: extras.provenance?.[id] || {} }))),
    context: { document: { sha256: gdsHash }, request: { target_ids: ids }, elements: extras.elements || [], referenced_elements: extras.referenced_elements || [], annotations: extras.contextAnnotations || [] }
});
const run = () => {
    const sameHash = makeRecord('h1', ['a', 'b'], { components: [{ provId: 'a', geometry: polygon(0), layer: '1/0' }, { provId: 'b', geometry: polygon(10), layer: '1/0' }] });
    const reordered = trackWorkOrder(sameHash, 'h1', [item('b', 10), item('a', 0)], []);
    assert.equal(reordered.status, 'current'); assert.deepEqual(reordered.targetIds, ['a', 'b']); assert(reordered.matches.every(m => m.kind === 'direct'));

    const namedOld = makeRecord('old', ['old-pad'], { components: [{ provId: 'old-pad', geometry: polygon(0), layer: '1/0', provenance: { file: 'build.py', instance_name: 'pad', array_index: [0], line: 12 } }] });
    const namedMoved = trackWorkOrder(namedOld, 'new', [item('new-b', 0, { file: 'build.py', instance_name: 'other', array_index: [0] }), item('new-a', 20, { file: 'build.py', instance_name: 'pad', array_index: [0], line: 33 })], []);
    assert.equal(namedMoved.status, 'relinked'); assert.deepEqual(namedMoved.targetIds, ['new-a']); assert.equal(namedMoved.matches[0].kind, 'provenance');

    const duplicate = makeRecord('old', ['old-dup'], { components: [{ provId: 'old-dup', geometry: polygon(0), layer: '1/0', provenance: { file: 'build.py', instance_name: 'pad', array_index: [2] } }] });
    const duplicateGeometry = trackWorkOrder(duplicate, 'new', [item('n1', 0, { file: 'build.py', instance_name: 'pad', array_index: [1] }), item('n2', 0, { file: 'build.py', instance_name: 'pad', array_index: [2] })], []);
    assert.equal(duplicateGeometry.status, 'relinked'); assert.deepEqual(duplicateGeometry.targetIds, ['n2']); assert.equal(duplicateGeometry.matches[0].kind, 'provenance');
    const ambiguous = trackWorkOrder(duplicate, 'new', [item('n1', 0, { file: 'build.py', instance_name: 'pad', array_index: [2] }), item('n2', 0, { file: 'build.py', instance_name: 'pad', array_index: [2] })], []);
    assert.equal(ambiguous.status, 'needs_review'); assert.equal(ambiguous.targetIds.length, 0); assert(ambiguous.issues.some(i => /Ambiguous/.test(i)));

    const deleted = trackWorkOrder(namedOld, 'new', [item('other', 50, { file: 'other.py', instance_name: 'other', array_index: [0] })], []);
    assert.equal(deleted.status, 'needs_review'); assert.equal(deleted.targetIds.length, 0); assert(deleted.issues.some(i => /Deleted|unmatchable/.test(i)));

    const annotationRecord = makeRecord('old', ['ann-1'], { components: [{ drawn: true, annotationId: 'ann-1', geometry: polygon(0), layer: '1/0' }] });
    const annotation = trackWorkOrder(annotationRecord, 'new', [], [{ id: 'ann-1', geometry: polygon(99) }]);
    assert.equal(annotation.status, 'relinked'); assert.deepEqual(annotation.targetIds, ['ann-1']); assert.equal(annotation.matches[0].kind, 'annotation');
    const missingAnnotation = trackWorkOrder(annotationRecord, 'new', [], []);
    assert.equal(missingAnnotation.status, 'needs_review'); assert.equal(missingAnnotation.targetIds.length, 0);

    const annotationContextRecord = makeRecord('old', ['ann-2'], { components: [], contextAnnotations: [{ id: 'ann-2', geometry: polygon(0) }] });
    const annotationContext = trackWorkOrder(annotationContextRecord, 'new', [], [{ id: 'ann-2', geometry: polygon(99) }]);
    assert.equal(annotationContext.status, 'relinked'); assert.deepEqual(annotationContext.targetIds, ['ann-2']);

    const collapseRecord = makeRecord('old', ['old-a', 'old-b'], { components: [{ provId: 'old-a', geometry: polygon(0), layer: '1/0' }, { provId: 'old-b', geometry: polygon(0), layer: '1/0' }] });
    const collapse = trackWorkOrder(collapseRecord, 'new', [item('new-one', 0)], []);
    assert.equal(collapse.status, 'needs_review'); assert.equal(collapse.targetIds.length, 1); assert(collapse.issues.some(i => /Multiple old targets/.test(i)));

    const noSnapshot = trackWorkOrder(makeRecord(undefined, ['a']), 'h1', [item('a', 0)], []);
    assert.equal(noSnapshot.status, 'needs_review'); assert(noSnapshot.issues.some(i => /snapshot hash/.test(i)));
    const noCurrentHash = trackWorkOrder(makeRecord('h1', ['a']), undefined, [item('a', 0)], []);
    assert.equal(noCurrentHash.status, 'needs_review'); assert(noCurrentHash.issues.some(i => /Current layout/.test(i)));
    // Separate host catalogs remain independent: a target is never looked up outside the supplied document catalog.
    const docA = trackWorkOrder(makeRecord('a', ['pad-a'], { gdsPath: 'a.gds', components: [{ provId: 'pad-a', geometry: polygon(0), layer: '1/0' }] }), 'a', [item('pad-a', 0)], []);
    const docB = trackWorkOrder(makeRecord('b', ['pad-b'], { gdsPath: 'b.gds', components: [{ provId: 'pad-b', geometry: polygon(10), layer: '1/0' }] }), 'b', [item('pad-b', 10)], []);
    assert.deepEqual(docA.targetIds, ['pad-a']); assert.deepEqual(docB.targetIds, ['pad-b']);
    return { status: 'passed', checks: ['reordered-direct-ids', 'named-moved-provenance-over-geometry', 'duplicate-geometry-disambiguation', 'ambiguous-rejection', 'deleted-target', 'annotation-persistence', 'context-annotation-persistence', 'bijection-collapse', 'missing-snapshot', 'missing-current-hash', 'separate-document-catalogs'] };
};
try { const report = run(); fs.writeFileSync(path.join(reportDir, 'rebuild.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)); }
catch (error) { const report = { status: 'failed', error: String(error.stack || error) }; fs.writeFileSync(path.join(reportDir, 'rebuild.json'), JSON.stringify(report, null, 2) + '\n'); throw error; }
