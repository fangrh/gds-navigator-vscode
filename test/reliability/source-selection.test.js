'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const SourceSelection = require('../../webview/source-selection.js');

const feature = (uid, provenance) => ({ ol_uid: uid, get: key => key === 'provenance' ? provenance : undefined });
const fixtures = [];
for (let i = 0; i < 10000; i++) {
  fixtures.push(feature(String(i), {
    file: i % 2 ? 'build.py' : 'C:\\work\\build.py', resolved_file: i % 3 ? undefined : 'C:/work/build.py',
    line: 20, instance_name: i % 4 ? 'u' : '', loop_index: [i % 5], array_index: [[i % 3, i % 2]],
    call_chain: i % 10 === 0 ? [{ file: 'caller.py', line: 7 }, { resolved_file: 'C:/work/build.py', line: 20 }] : []
  }));
}
fixtures.push(feature('duplicate', { file: 'build.py', line: 20, call_chain: [{ file: 'build.py', line: 20 }] }));
fixtures.push(feature('fraction', { file: 'build.py', line: 20.5 }));
fixtures.push(feature('nan', { file: 'build.py', line: NaN }));
fixtures.push(feature('string-line', { file: 'build.py', line: '20' }));
fixtures.push(feature('chain-only-before-direct', { file: 'other.py', line: 1, call_chain: [{ file: 'build.py', line: 20 }] }));
fixtures.push(feature('missing-primary-chain', { call_chain: [{ file: 'build.py', line: 20 }] }));
fixtures.push(feature('nan-primary-chain', { file: 'other.py', line: NaN, call_chain: [{ file: 'build.py', line: 20 }] }));

function baselineBySource(list, targetFile, targetLine) {
  targetFile = (targetFile || '').replace(/\\/g, '/'); targetLine = parseInt(targetLine, 10);
  if (!targetFile || Number.isNaN(targetLine)) return [];
  const matches = list.filter(f => {
    const p = f.get('provenance') || {}, file = (p.resolved_file || p.file || '').replace(/\\/g, '/');
    return file.toLowerCase() === targetFile.toLowerCase() && (typeof p.line === 'number' ? p.line : parseInt(String(p.line), 10)) === targetLine;
  });
  const chain = list.filter(f => (f.get('provenance')?.call_chain || []).some(cc => {
    const file = (cc.resolved_file || cc.file || '').replace(/\\/g, '/');
    return file.toLowerCase() === targetFile.toLowerCase() && (typeof cc.line === 'number' ? cc.line : parseInt(String(cc.line), 10)) === targetLine;
  }));
  const seen = {}, out = [];
  matches.concat(chain).forEach(f => { if (!seen[f.ol_uid]) { seen[f.ol_uid] = true; out.push(f); } });
  return out;
}

function baselineLine(list, anchor) {
  const a = anchor || {}, file = (a.file || '').replace(/\\/g, '/'), line = a.line;
  return list.filter(f => { const p = f.get('provenance') || {}; return (p.file || '').replace(/\\/g, '/') === file && p.line === line; });
}

const index = SourceSelection.create(fixtures);
assert.deepEqual(index.bySource('C:\\work\\build.py', 20).map(f => f.ol_uid), baselineBySource(fixtures, 'C:\\work\\build.py', 20).map(f => f.ol_uid));
assert.deepEqual(index.bySource('caller.py', 7).map(f => f.ol_uid), baselineBySource(fixtures, 'caller.py', 7).map(f => f.ol_uid));
assert.deepEqual(index.bySource('build.py', 20).map(f => f.ol_uid), baselineBySource(fixtures, 'build.py', 20).map(f => f.ol_uid));
assert.deepEqual(index.bySource('', 20), []);
assert.deepEqual(index.bySource('build.py', 'not-a-line'), []);
assert.deepEqual(index.lineGroup({ file: 'build.py', line: 20 }).map(f => f.ol_uid), baselineLine(fixtures, { file: 'build.py', line: 20 }).map(f => f.ol_uid));
assert.deepEqual(index.lineGroup({ file: 'build.py', line: '20' }).map(f => f.ol_uid), baselineLine(fixtures, { file: 'build.py', line: '20' }).map(f => f.ol_uid));
assert.deepEqual(index.lineGroup({ file: 'build.py', line: NaN }), []);
assert.equal(index.matchesProvenance(fixtures[0]), true);
fixtures[0].get = key => key === 'provenance' ? { file: 'replacement.py', line: 1 } : undefined;
assert.equal(index.matchesProvenance(fixtures[0]), false);
const returned = index.bySource('build.py', 20); returned.length = 0;
assert(index.bySource('build.py', 20).length > 0, 'source bucket was exposed for mutation');
const beforeWarm = index.stats(); index.bySource('build.py', 20); index.lineGroup({ file: 'build.py', line: 20 });
const afterWarm = index.stats(); assert.equal(afterWarm.buildInspections, beforeWarm.buildInspections, 'warm lookup rescanned feature records');

const t0 = performance.now(); for (let i = 0; i < 100; i++) baselineBySource(fixtures, 'build.py', 20); const baselineMs = performance.now() - t0;
const t1 = performance.now(); for (let i = 0; i < 100; i++) index.bySource('build.py', 20); const indexedMs = performance.now() - t1;
const out = path.resolve(__dirname, '../../logs/next-performance/source'); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ status: 'passed', featureCount: fixtures.length, baselineMs, indexedMs, stats: index.stats(), ordering: 'allFeatures order; direct then call_chain; ol_uid dedup' }, null, 2));
console.log(JSON.stringify({ status: 'passed', featureCount: fixtures.length, baselineMs, indexedMs }));
