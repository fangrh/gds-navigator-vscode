#!/usr/bin/env node
'use strict';
const assert = require('assert/strict'); const fs = require('fs'); const os = require('os'); const path = require('path');
const root = path.resolve(__dirname, '../..'); const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-review-build-')), 'reviewStore.js');
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/reviewStore.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out });
const { ReviewSnapshotStore, validateReviewState } = require(out);
(async () => {
  assert(validateReviewState({ version: 1, bookmarks: [], measurements: [] }));
  assert(!validateReviewState({ version: 1, bookmarks: [{ id: 'x' }], measurements: [] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-review-')); const store = new ReviewSnapshotStore(dir);
  const a = path.join(dir, 'a.gds'), b = path.join(dir, 'b.gds');
  const h1 = '1'.repeat(64), h2 = '2'.repeat(64);
  await store.record(a, h1, [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } }]);
  let same = await store.record(a, h1, [{ type: 'Feature', geometry: { type: 'Point', coordinates: [3, 4] } }]);
  assert.equal(same.previousHash, undefined);
  await store.record(a, h2, [{ type: 'Feature', geometry: { type: 'Point', coordinates: [5, 6] } }]);
  const loaded = await store.load(a); assert.equal(loaded.previousHash, h1); assert.equal(loaded.previous[0].geometry.coordinates[0], 3);
  const other = '3'.repeat(64); await store.record(b, other, []); const isolated = await store.load(b); assert.equal(isolated.currentHash, other); assert.equal((await store.load(a)).currentHash, h2);
  fs.writeFileSync(path.join(dir, require('crypto').createHash('sha256').update(path.resolve(b).toLowerCase()).digest('hex') + '.json'), '{bad');
  assert.equal((await store.load(b)).status, 'unavailable');
  const corruptPath=path.join(dir,require('crypto').createHash('sha256').update(path.resolve(b).toLowerCase()).digest('hex')+'.json');
  fs.writeFileSync(corruptPath,JSON.stringify({version:1,gdsPath:b,currentHash:other,current:[{type:'Feature',geometry:{type:'Point',coordinates:['bad',2]}}]}));
  const corrupt=fs.readFileSync(corruptPath,'utf8');assert.equal((await store.record(b,h1,[])).status,'unavailable');assert.equal(fs.readFileSync(corruptPath,'utf8'),corrupt);
  const h3='3'.repeat(64),h4='4'.repeat(64);await Promise.all([store.record(a,h3,[]),store.record(a,h4,[])]);assert.equal((await store.load(a)).currentHash,h4);assert.equal((await store.load(a)).previousHash,h3);
  const tooLarge = new ReviewSnapshotStore(path.join(dir, 'small'), 10); assert.equal((await tooLarge.record(a, '4'.repeat(64), [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { x: '0123456789' } }])).status, 'unavailable');
  console.log(JSON.stringify({ status: 'passed', atomicValidation: true, perFileIsolation: true, sameHashRetained: true, changedHashRotated: true, malformedStorageUnavailable: true }));
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
