#!/usr/bin/env node
'use strict';

// Regression contract for output identity when Python and the workspace use
// different spellings of the same directory (for example /var and
// /private/var on macOS).  This deliberately exercises the public runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inventoryProcesses } = require('../../scripts/process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '../..');
const PYTHON = path.resolve(process.env.GDS_TEST_PYTHON || process.env.GDS_PYTHON ||
  (process.platform === 'win32' ? path.join(ROOT, '.venv-fork', 'Scripts', 'python.exe') : path.join(ROOT, '.venv-fork', 'bin', 'python')));
const REPORT_DIR = path.resolve(process.env.GDS_OUTPUT_ALIAS_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'output-aliases'));
fs.mkdirSync(REPORT_DIR, { recursive: true });

function bundle(entry, outfile) {
  require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile });
}

function loadRunner(bundleDir) {
  bundle(path.join(ROOT, 'src', 'pythonRunner.ts'), path.join(bundleDir, 'pythonRunner.js'));
  const Module = require('module');
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return { window: { showErrorMessage() {} } };
    return original.call(this, request, parent, isMain);
  };
  try { return require(path.join(bundleDir, 'pythonRunner.js')); } finally { Module._load = original; }
}

const output = { show() {}, appendLine() {} };
const writeScript = (dir, name, source) => {
  const file = path.join(dir, name); fs.writeFileSync(file, source); return file;
};
const py = (line) => `${line}\n`;

async function assertNoMarkedProcesses(markers) {
  const rows = await inventoryProcesses();
  const survivors = rows.filter(row => markers.some(marker => row.command.includes(marker)));
  assert.deepEqual(survivors, [], `test-marked Python/helper survivors: ${survivors.map(row => `${row.pid}:${row.command}`).join('; ')}`);
  return survivors;
}

(async () => {
  assert(fs.existsSync(PYTHON), `Python interpreter is required: ${PYTHON}`);
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-output-alias-'));
  const root = fs.realpathSync(rawRoot);
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-output-alias-bundle-'));
  const alias = `${root}-alias`;
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-output-alias-outside-')));
  const outsideAlias = `${outside}-alias`;
  const markers = [rawRoot, root, alias, outside, outsideAlias];
  const report = { python: PYTHON, platform: process.platform, cases: [] };
  let requestedSuccess = false;
  let testError;
  try {
    try { fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
      throw new Error(`cannot create workspace symlink/junction: ${error.message}`);
    }
    try { fs.symlinkSync(outside, outsideAlias, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
      throw new Error(`cannot create external symlink/junction: ${error.message}`);
    }
    const { runPythonScript } = loadRunner(bundleDir);
    const cwd = alias;
    const run = async (name, source) => {
      const result = await runPythonScript(PYTHON, writeScript(root, `${name}.py`, source), cwd, output, { timeoutMs: 60000 });
      report.cases.push({ name, result });
      return result;
    };
    const one = await run('one-relative', py("open('one.gds', 'wb').write(b'one')"));
    assert.equal(one.ok, true, JSON.stringify(one));
    assert.deepEqual(one.candidates, [path.resolve(alias, 'one.gds')]);
    assert.equal(one.gdsPath, path.resolve(alias, 'one.gds'));

    fs.writeFileSync(path.join(root, 'stale.gds'), 'old');
    const stale = await run('stale-no-output', py("print('stale.gds')"));
    assert.equal(stale.ok, false, JSON.stringify(stale));
    assert.match(stale.reason, /no new or modified/);
    assert.deepEqual(stale.candidates, []);

    const two = await run('two-equal-content', py("open('equal-a.gds', 'wb').write(b'same')\nopen('equal-b.gds', 'wb').write(b'same')"));
    assert.equal(two.ok, false, JSON.stringify(two));
    assert.match(two.reason, /multiple GDS/);
    assert.deepEqual(two.candidates, [path.resolve(alias, 'equal-a.gds'), path.resolve(alias, 'equal-b.gds')].sort());

    let caseDistinctSupported = true;
    try {
      fs.writeFileSync(path.join(root, 'CaseDistinct.gds'), 'probe', { flag: 'wx' });
      try { fs.writeFileSync(path.join(root, 'casedistinct.gds'), 'probe', { flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') caseDistinctSupported = false; else throw error; }
    } finally {
      fs.rmSync(path.join(root, 'CaseDistinct.gds'), { force: true });
      fs.rmSync(path.join(root, 'casedistinct.gds'), { force: true });
    }
    report.capabilities = { caseDistinctSupported };
    const caseA = path.resolve(alias, 'CaseDistinct.gds');
    const caseB = path.resolve(alias, 'casedistinct.gds');
    const distinct = await run('case-distinct', py("open('CaseDistinct.gds', 'wb').write(b'a')\nopen('casedistinct.gds', 'wb').write(b'b')"));
    if (caseDistinctSupported) {
      assert.equal(distinct.ok, false, JSON.stringify(distinct));
      assert.deepEqual(distinct.candidates, [caseA, caseB].sort());
    } else {
      assert.equal(distinct.ok, true, JSON.stringify(distinct));
    }

    const external = await run('external-alias', py(`open(${JSON.stringify(path.join(outsideAlias, 'external.gds'))}, 'wb').write(b'external')`));
    assert.equal(external.ok, true, JSON.stringify(external));
    assert.deepEqual(external.candidates, [path.resolve(outsideAlias, 'external.gds')]);

    const sameExternal = await run('external-same-file-aliases', py(`open(${JSON.stringify(path.join(outsideAlias, 'same.gds'))}, 'wb').write(b'alias')\nopen(${JSON.stringify(path.join(outside, 'same.gds'))}, 'wb').write(b'real')`));
    assert.equal(sameExternal.ok, true, JSON.stringify(sameExternal));
    assert.deepEqual(sameExternal.candidates, [path.resolve(outsideAlias, 'same.gds')]);

    let hardlinkSupported = true;
    try {
      fs.writeFileSync(path.join(root, 'hard-probe-a.gds'), 'probe');
      fs.linkSync(path.join(root, 'hard-probe-a.gds'), path.join(root, 'hard-probe-b.gds'));
    }
    catch (error) { hardlinkSupported = error.code !== 'EPERM' && error.code !== 'EOPNOTSUPP'; }
    fs.rmSync(path.join(root, 'hard-probe-a.gds'), { force: true });
    fs.rmSync(path.join(root, 'hard-probe-b.gds'), { force: true });
    report.capabilities.hardlinkSupported = hardlinkSupported;
    const hardlinks = await run('hardlink-distinct', py("open('hard-a.gds', 'wb').write(b'hard')\nimport os\nos.link('hard-a.gds', 'hard-b.gds')"));
    if (hardlinkSupported) {
      assert.equal(hardlinks.ok, false, JSON.stringify(hardlinks));
      assert.deepEqual(hardlinks.candidates, [path.resolve(alias, 'hard-a.gds'), path.resolve(alias, 'hard-b.gds')].sort());
    }

    const externalTwo = await run('external-alias-plus-second', py(`open(${JSON.stringify(path.join(outsideAlias, 'external-second.gds'))}, 'wb').write(b'external')\nopen('genuine-second.gds', 'wb').write(b'second')`));
    assert.equal(externalTwo.ok, false, JSON.stringify(externalTwo));
    assert.match(externalTwo.reason, /multiple GDS/);
    assert.deepEqual(externalTwo.candidates, [path.resolve(alias, 'genuine-second.gds'), path.resolve(outsideAlias, 'external-second.gds')].sort());
    const failed = await run('failed-no-output', py("raise RuntimeError('expected failure')"));
    assert.equal(failed.ok, false, JSON.stringify(failed));
    assert.match(failed.reason, /Script exited with code/);
    assert.equal(failed.candidates, undefined);
    await assertNoMarkedProcesses(markers);
    requestedSuccess = true;
  } catch (error) {
    testError = error;
  } finally {
    try {
      const rows = await inventoryProcesses();
      const survivors = rows.filter(row => markers.some(marker => row.command.includes(marker)));
      report.cleanup = { verified: true, survivors: survivors.map(row => ({ pid: row.pid, command: row.command })) };
      if (requestedSuccess && !survivors.length) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(alias, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(outsideAlias, { recursive: true, force: true });
      fs.rmSync(bundleDir, { recursive: true, force: true });
      } else if (!testError) {
        testError = new Error(`cleanup verification left test-marked survivors: ${survivors.map(row => row.pid).join(', ')}`);
      }
    } catch (error) {
      report.cleanup = { verified: false, error: String(error.stack || error), survivors: null };
      if (!testError) testError = error;
    }
    report.status = testError ? 'failed' : 'passed';
    if (testError) {
      report.error = String(testError.stack || testError);
      console.error(`retaining fixtures for inspection: ${root} ${alias} ${outside} ${outsideAlias} ${bundleDir}`);
    }
    fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (testError) throw testError;
  console.log(JSON.stringify({ status: 'passed', cases: report.cases.length, cleanup: report.cleanup, report: path.join(REPORT_DIR, 'report.json') }));
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
