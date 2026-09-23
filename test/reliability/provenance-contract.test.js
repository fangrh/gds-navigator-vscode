#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-contract-bundle-'));
require('esbuild').buildSync({entryPoints:[path.join(ROOT,'src','sidecar.ts')],bundle:true,platform:'node',format:'cjs',external:['vscode'],outfile:path.join(bundleDir,'sidecar.js')});
require('esbuild').buildSync({entryPoints:[path.join(ROOT,'src','parseGds.ts')],bundle:true,platform:'node',format:'cjs',external:['vscode'],outfile:path.join(bundleDir,'parseGds.js')});

const { deriveScriptFromSidecar, readSidecar } = require(path.join(bundleDir, 'sidecar.js'));
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => Number.NaN }) } };
  return originalLoad.call(this, request, parent, isMain);
};
const { parseGdsFile } = require(path.join(bundleDir, 'parseGds.js'));
Module._load = originalLoad;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-prov-'));
  try {
    const gds = path.join(dir, 'chip.gds'); fs.writeFileSync(gds, 'fixture');
    fs.mkdirSync(path.join(dir, 'scripts')); fs.writeFileSync(path.join(dir, 'scripts', 'build.py'), '');
    fs.writeFileSync(path.join(dir, 'chip.provenance.json'), JSON.stringify({ entries: [null, { id: 1, file: 'scripts/build.py' }, 'bad'], ports: 'bad', ref_names: [] }));
    const old = process.cwd(); process.chdir(os.tmpdir());
    try { assert.equal(path.normalize(deriveScriptFromSidecar(gds)), path.normalize(path.join(dir, 'scripts', 'build.py'))); } finally { process.chdir(old); }
    const sidecar = readSidecar(path.join(dir, 'chip.provenance.json'));
    assert.equal(sidecar.entries.length, 1, 'malformed entries should be filtered individually');
    const sourceGds = path.join(ROOT, 'test', 'fixtures', 'jj_pad_center_50_test.gds');
    const parseGds = path.join(dir, 'parse.gds'); fs.copyFileSync(sourceGds, parseGds);
    fs.writeFileSync(path.join(dir, 'parse.provenance.json'), JSON.stringify({ entries: [null, { id: 7, file: 'build.py' }, { id: [], file: 'invalid.py' }, 3], ports: [], ref_names: 'bad' }));
    const py = path.join(ROOT, '.venv-fork', 'Scripts', 'python.exe');
    if (fs.existsSync(py)) {
      const parsed = JSON.parse(execFileSync(py, [path.join(ROOT, 'python', 'parse_gds.py'), parseGds], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
      assert.equal(parsed.type, 'FeatureCollection'); assert.equal(parsed.error, undefined); assert(parsed._diag.sidecar_warnings.length >= 2);
      const parsedThroughApi = await parseGdsFile(py, parseGds, ROOT);
      assert.equal(parsedThroughApi.mode, 'partial'); assert(parsedThroughApi.warnings.length >= 2);
      fs.writeFileSync(path.join(dir,'parse.provenance.json'),JSON.stringify({version:1,entries:[{id:7,file:'scripts/build.py',line:1}],ports:{},ref_names:{}}));
      const unmatched=await parseGdsFile(py,parseGds,ROOT);
      assert.equal(unmatched.mode,'partial','well-formed unrelated sidecar must not claim provenance ON');
      assert(unmatched.warnings.some(w=>w.includes('covers 0/')));
      const controller = new AbortController(); controller.abort();
      await assert.rejects(parseGdsFile(py, parseGds, ROOT, controller.signal), /cancelled/);
    }
    console.log(JSON.stringify({ status: 'passed', relativePath: true, malformedEntriesFiltered: true, pythonParser: fs.existsSync(py) }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(bundleDir, {recursive:true,force:true}); }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
