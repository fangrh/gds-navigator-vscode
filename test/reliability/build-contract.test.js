#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-contract-bundle-'));
require('esbuild').buildSync({entryPoints:[path.join(ROOT,'src','pythonRunner.ts')],bundle:true,platform:'node',format:'cjs',external:['vscode'],outfile:path.join(bundleDir,'pythonRunner.js')});

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return { window: { showErrorMessage: () => undefined } };
  return originalLoad.call(this, request, parent, isMain);
};
const { findChangedGds, runPythonScript } = require(path.join(bundleDir, 'pythonRunner.js'));
Module._load = originalLoad;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-build-'));
  try {
    fs.writeFileSync(path.join(dir, 'stale.gds'), 'old');
    const before = await findChangedGds(dir, new Map([[path.resolve(dir, 'stale.gds'), `${3}:${fs.statSync(path.join(dir, 'stale.gds')).mtimeMs}`]]));
    assert.deepEqual(before, [], 'unchanged stale outputs must not count');
    fs.writeFileSync(path.join(dir, 'new.gds'), 'new');
    const one = await findChangedGds(dir, new Map([[path.resolve(dir, 'stale.gds'), `${3}:${fs.statSync(path.join(dir, 'stale.gds')).mtimeMs}`]]));
    assert.deepEqual(one, [path.resolve(dir, 'new.gds')]);
    fs.writeFileSync(path.join(dir, 'other.gds'), 'other');
    const many = await findChangedGds(dir, new Map([[path.resolve(dir, 'stale.gds'), `${3}:${fs.statSync(path.join(dir, 'stale.gds')).mtimeMs}`]]));
    assert.equal(many.length, 2, 'multiple changed outputs must remain observable for the caller to reject');
    const python = path.join(ROOT, '.venv-fork', 'Scripts', 'python.exe');
    if (fs.existsSync(python)) {
      const output = { show() {}, appendLine() {} };
      fs.writeFileSync(path.join(dir,'missing.py'),'import gds_test_dependency_that_does_not_exist');
      const missing = await runPythonScript(python,path.join(dir,'missing.py'),dir,output,{timeoutMs:60000});
      assert.equal(missing.ok,false);assert(missing.reason.includes(python));assert.match(missing.reason,/gds_test_dependency_that_does_not_exist/);assert.match(missing.reason,/Set Up Project Environment/);
      fs.writeFileSync(path.join(dir, 'none.py'), '');
      const none = await runPythonScript(python, path.join(dir, 'none.py'), dir, output, { timeoutMs: 60000 });
      assert.equal(none.ok, false); assert.match(none.reason, /no new or modified/);
      fs.writeFileSync(path.join(dir, 'one.py'), 'open("single.gds", "w").write("gds")');
      const oneRun = await runPythonScript(python, path.join(dir, 'one.py'), dir, output, { timeoutMs: 60000 });
      assert.equal(oneRun.ok, true); assert.equal(path.basename(oneRun.gdsPath), 'single.gds');
      fs.writeFileSync(path.join(dir, 'many.py'), 'open("a.gds", "w").write("a"); open("b.gds", "w").write("b")');
      const manyRun = await runPythonScript(python, path.join(dir, 'many.py'), dir, output, { timeoutMs: 60000 });
      assert.equal(manyRun.ok, false); assert.match(manyRun.reason, /multiple GDS/);
      fs.writeFileSync(path.join(dir, 'slow.py'), 'import time; time.sleep(2)');
      const timed = await runPythonScript(python, path.join(dir, 'slow.py'), dir, output, { timeoutMs: 100 });
      assert.equal(timed.ok, false); assert.match(timed.reason, /timed out/);
      const controller = new AbortController();
      const cancelledPromise = runPythonScript(python, path.join(dir, 'slow.py'), dir, output, { timeoutMs: 5000, signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      const cancelled = await cancelledPromise;
      assert.equal(cancelled.ok, false); assert.match(cancelled.reason, /cancelled/);
      fs.writeFileSync(path.join(dir, 'noisy.py'), 'print("x" * 10000)');
      const noisy = await runPythonScript(python, path.join(dir, 'noisy.py'), dir, output, { timeoutMs: 60000, maxOutputBytes: 100 });
      assert.equal(noisy.ok, false); assert.match(noisy.reason, /output exceeded/);
    }
    console.log(JSON.stringify({ status: 'passed', stale: 0, single: 1, multiple: many.length, runContract: fs.existsSync(python) }));
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300));
    try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(bundleDir, {recursive:true,force:true}); } catch { /* child termination may settle slightly later */ }
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
