#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const root = path.resolve(__dirname, '../..');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-links-')), 'links.js');
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/fileLinks.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out });
const f = require(out); let graph = f.createFileLinks();
for (let i = 0; i < 20; i++) graph = f.updateBuildLinks(graph, 'C:/project/build.py', [`C:/project/out/${i}.gds`]);
assert.equal(f.relatedLayouts(graph, 'c:\\PROJECT\\build.py').length, 20);
graph = f.updateBuildLinks(graph, 'C:/other/build.py', ['C:/project/out/0.gds']);
assert.equal(f.linkedScript(graph, 'c:/project/out/0.gds'), 'C:/other/build.py');
graph = f.linkScript(graph, 'C:/project/out/0.gds', 'C:/explicit/manual.py');
assert.equal(f.linkedScript(graph, 'c:/project/out/0.gds'), 'C:/explicit/manual.py');
assert.equal(f.relatedLayouts(graph, 'C:/explicit/manual.py')[0], 'C:/project/out/0.gds');
graph = f.remapPath(graph, 'C:/project', 'D:/moved/project');
assert.equal(f.linkedScript(graph, 'D:/moved/project/out/0.gds'), 'C:/explicit/manual.py');
assert.deepEqual(f.loadFileLinks('{bad'), f.createFileLinks());
console.log(JSON.stringify({ status: 'passed', repeatedCycles: 20, explicitOverride: true, pathRemap: true }));
