#!/usr/bin/env node
'use strict';
const assert = require('assert/strict'); const fs = require('fs'); const os = require('os'); const path = require('path');
const root = path.resolve(__dirname, '../..'); const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-store-')), 'store.js');
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/projectStore.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out });
const { ProjectStore } = require(out);
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-project-')); const legacyMap = new Map([['gdsNavigator.old', 7]]);
  const legacy = { keys: ['gdsNavigator.old', 'other'], get: (k, d) => legacyMap.has(k) ? legacyMap.get(k) : d, update: async (k, v) => legacyMap.set(k, v) };
  const store = new ProjectStore(dir, legacy); await store.ready(); await store.update('gdsNavigator.paths', { gdsPath: path.join(dir, 'layout.gds') });
  const disk = JSON.parse(fs.readFileSync(path.join(dir, '.gds-navigator/project.json'), 'utf8')); assert.equal(disk.entries['gdsNavigator.paths'] .gdsPath.$projectRelative, 'layout.gds');
  const reopened = new ProjectStore(dir, legacy); await reopened.ready(); assert.equal(reopened.get('gdsNavigator.paths').gdsPath, path.join(dir, 'layout.gds'));
  assert.equal(await reopened.get('gdsNavigator.old'), 7);
  await reopened.update('gdsNavigator.annotations.v1:' + path.join(dir, 'layout.gds').toLowerCase(), { gdsPath: path.join(dir, 'layout.gds') });
  await reopened.update('gdsNavigator.alignment:' + path.join(dir, 'layout.gds').toLowerCase(), { imagePath: path.join(dir, 'photo.png') });
  await reopened.update('gdsNavigator.assoc:' + path.join(dir, 'layout.gds').toLowerCase(), path.join(dir, 'build.py'));
  const moved = path.join(path.dirname(dir), path.basename(dir) + '-moved'); fs.renameSync(dir, moved);
  const movedStore = new ProjectStore(moved, legacy); await movedStore.ready(); assert.equal(movedStore.get('gdsNavigator.assoc:' + path.join(moved, 'layout.gds').toLowerCase()), path.join(moved, 'build.py'));
  fs.renameSync(moved, dir);
  const first = new ProjectStore(dir, legacy); const second = new ProjectStore(dir, legacy); await first.ready(); await second.ready(); await first.update('gdsNavigator.queue.a', 1); await assert.rejects(second.update('gdsNavigator.queue.b', 2), /changed externally/); const recovered = new ProjectStore(dir, legacy); await recovered.ready(); await recovered.update('gdsNavigator.queue.c', 3);
  fs.writeFileSync(path.join(dir, '.gds-navigator/project.json'), '{bad'); const corrupt = new ProjectStore(dir, legacy); await corrupt.ready(); assert.equal(corrupt.get('gdsNavigator.old'), 7); await assert.rejects(corrupt.update('gdsNavigator.x', 1), /malformed/); assert(corrupt.warning);
  console.log(JSON.stringify({ status: 'passed', relativeEncoding: true, legacyFallback: true, malformedGuard: true }));
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
