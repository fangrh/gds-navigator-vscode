#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-external-bundle-'));
require('esbuild').buildSync({ entryPoints: [path.join(ROOT, 'src/pythonRunner.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: path.join(bundleDir, 'pythonRunner.js') });
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { if (request === 'vscode') return { window: { showErrorMessage() {} } }; return originalLoad.call(this, request, parent, isMain); };
const { runPythonScript } = require(path.join(bundleDir, 'pythonRunner.js'));
Module._load = originalLoad;

const python = process.platform === 'win32' ? path.join(ROOT, '.venv-fork', 'Scripts', 'python.exe') : path.join(ROOT, '.venv-fork', 'bin', 'python');
const output = { show() {}, appendLine() {} };
const writeScript = (dir, name, source) => { const file = path.join(dir, name); fs.writeFileSync(file, source); return file; };

(async () => {
  if (!fs.existsSync(python)) { console.log(JSON.stringify({ status: 'skipped', reason: 'fork Python unavailable' })); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gds external ü-'));
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'gds sibling 空-'));
  try {
    const outside = path.join(sibling, 'outside file.gds');
    const one = await runPythonScript(python, writeScript(root, 'outside.py', `from pathlib import Path\nPath(${JSON.stringify(outside)}).write_text('outside')`), root, output, { timeoutMs: 60000 });
    assert.equal(one.ok, true); assert.deepEqual(one.candidates, [path.resolve(outside)]);

    const stale = path.join(sibling, 'stale.gds'); fs.writeFileSync(stale, 'old');
    const printed = await runPythonScript(python, writeScript(root, 'printed.py', `print(${JSON.stringify(stale)})`), root, output, { timeoutMs: 60000 });
    assert.equal(printed.ok, false); assert.match(printed.reason, /no new or modified/); assert.deepEqual(printed.candidates, []);

    const manyA = path.join(sibling, 'one.gds'); const manyB = path.join(sibling, 'two.gds');
    const many = await runPythonScript(python, writeScript(root, 'many.py', `open(${JSON.stringify(manyA)}, 'w').write('a')\nopen(${JSON.stringify(manyB)}, 'w').write('b')`), root, output, { timeoutMs: 60000 });
    assert.equal(many.ok, false); assert.match(many.reason, /multiple GDS/); assert.deepEqual(many.candidates, [path.resolve(manyA), path.resolve(manyB)]);

    const failedPath = path.join(sibling, 'failed.gds');
    const failed = await runPythonScript(python, writeScript(root, 'failed.py', `open(${JSON.stringify(failedPath)}, 'w').write('failed')\nraise RuntimeError('expected')`), root, output, { timeoutMs: 60000 });
    assert.equal(failed.ok, false); assert.equal(failed.candidates, undefined); assert.doesNotThrow(() => fs.statSync(failedPath));

    let fork = 'skipped';
    const forkProbe = writeScript(root, 'fork.py', `import gdsfactory as gf\nc = gf.Component('external_probe')\nc.write_gds(${JSON.stringify(path.join(sibling, 'fork.gds'))})`);
    const forkResult = await runPythonScript(python, forkProbe, root, output, { timeoutMs: 60000 });
    if (forkResult.ok || /script failed/.test(forkResult.reason || '')) {
      if (fs.existsSync(path.join(sibling, 'fork.gds'))) { assert.equal(forkResult.ok, true); assert.deepEqual(forkResult.candidates, [path.resolve(path.join(sibling, 'fork.gds'))]); fork = 'passed'; }
    }
    console.log(JSON.stringify({ status: 'passed', outside: 1, stale: 1, multiple: 2, failed: 1, fork }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(sibling, { recursive: true, force: true }); fs.rmSync(bundleDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
