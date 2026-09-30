#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '../..');
const out = path.join(os.tmpdir(), `work-order-tracking-performance-${process.pid}.cjs`);
const source = fs.readFileSync(path.join(root, 'src/workOrderTracking.ts'), 'utf8');
const instrumented = source
  .replace('function idOf(value: AnyRecord): string | undefined {', 'function idOf(value: AnyRecord): string | undefined { __metrics.idLookups++;')
  .replace('function canonical(value: any): string {', 'function canonical(value: any): string { __metrics.canonical++;')
  .replace('function geometryLayerKey(value: AnyRecord): string | undefined {', 'function geometryLayerKey(value: AnyRecord): string | undefined { __metrics.geometry++;')
  .replace('function strongProvenanceKey(value: AnyRecord): string | undefined {', 'function strongProvenanceKey(value: AnyRecord): string | undefined { __metrics.provenance++;');
buildSync({ stdin: { contents: 'export const __metrics = { canonical: 0, geometry: 0, provenance: 0, idLookups: 0 };\n' + instrumented, resolveDir: root, sourcefile: 'workOrderTracking.instrumented.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: out });
const { trackWorkOrder, __metrics } = require(out);

const polygon = x => ({ type: 'Polygon', coordinates: [[[x, 0], [x + 2, 0], [x + 2, 1], [x, 0]]] });
const provenance = i => ({ file: 'build.py', instance_name: 'pad', array_index: [i] });
const oldItems = Array.from({ length: 100 }, (_, i) => ({ provId: `old-${i}`, geometry: polygon(i * 10), layer: '1/0', provenance: provenance(i) }));
const current = oldItems.map((item, i) => ({
  provId: `new-${i}`, geometry: item.geometry, layer: item.layer,
  // Odd targets exercise geometry fallback after a provenance miss.
  provenance: i % 2 ? {} : provenance(i),
}));
for (let i = 100; i < 1000; i++) current.push({ provId: `extra-${i}`, geometry: polygon(i * 10), layer: '1/0', provenance: {} });
const record = {
  gdsHash: 'old-hash',
  request: { targetIds: oldItems.map(item => item.provId) },
  components: oldItems,
  context: { document: { sha256: 'old-hash' }, request: { target_ids: oldItems.map(item => item.provId) } },
};

const sameHashRecord = { ...record, request: { targetIds: current.slice(0, 100).map(item => item.provId) }, context: { ...record.context, request: { target_ids: current.slice(0, 100).map(item => item.provId) } }, components: current.slice(0, 100) };
const sameHash = trackWorkOrder(sameHashRecord, 'old-hash', current, []);
assert.equal(sameHash.status, 'current');
assert.equal(__metrics.canonical, 0, 'same-hash direct lookup must avoid canonicalization');
assert.equal(__metrics.geometry, 0, 'same-hash direct lookup must avoid geometry indexing');
__metrics.canonical = 0; __metrics.geometry = 0; __metrics.provenance = 0;
__metrics.idLookups = 0;

const allProvenanceCatalog = current.map((item, i) => i < 100 ? { ...item, provenance: provenance(i) } : item);
const allProvenance = trackWorkOrder(record, 'new-hash', allProvenanceCatalog, []);
assert.equal(allProvenance.status, 'relinked');
assert.equal(allProvenance.matches.length, 100);
assert.equal(__metrics.geometry, 0, 'all provenance matches must avoid geometry indexing');
const allProvenanceMetrics = { ...__metrics };
__metrics.canonical = 0; __metrics.geometry = 0; __metrics.provenance = 0; __metrics.idLookups = 0;

const result = trackWorkOrder(record, 'new-hash', current, []);
assert.equal(result.status, 'relinked');
assert.deepEqual(result.targetIds, current.slice(0, 100).map(item => item.provId));
assert.equal(result.matches.length, 100);
assert.equal(result.issues.length, 0);
assert.equal(result.matches.filter(match => match.kind === 'provenance').length, 50);
assert.equal(result.matches.filter(match => match.kind === 'geometry').length, 50);
assert(__metrics.geometry > 0, 'geometry fallback fixture must exercise the lazy geometry index');
assert(__metrics.provenance <= 1200, `too many provenance key evaluations: ${__metrics.provenance}`);
assert(__metrics.canonical <= 20000, `too many canonical operations: ${__metrics.canonical}`);
assert(__metrics.idLookups < 3000, `frozen targets were rescanned: ${__metrics.idLookups}`);

const report = {
  status: 'passed',
  fixture: { targets: 100, catalog: 1000 },
  matches: { total: result.matches.length, provenance: 50, geometry: 50 },
  keyEvaluations: { mixed: { ...__metrics }, allProvenance: allProvenanceMetrics },
  behavior: ['same-hash direct lookup performs zero canonicalization', 'all provenance matches perform zero geometry indexing', 'one-to-one assignment and output ordering preserved'],
};
const reportDir = path.join(root, 'logs/performance');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'work-order-tracking.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
