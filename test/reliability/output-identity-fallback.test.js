'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// Exercise the public build contract with real files and a simulated Python
// writer. Filesystem faults must preserve candidates instead of hiding outputs.
(async () => {
  const root = path.resolve(__dirname, '../..');
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-output-identity-')));
  const originalLoad = Module._load;
  const originalStat = fs.promises.stat;
  const originalRealpath = fs.promises.realpath;
  let fixture;
  try {
    const bundle = path.join(temp, 'runner.cjs');
    require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/pythonRunner.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle });
    Module._load = function (name, ...args) {
      if (name === 'vscode') return { window: { showErrorMessage() {} } };
      if (name === 'child_process') return { spawn: (_executable, _args, options) => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
        setImmediate(() => {
          fs.writeFileSync(fixture.file, 'GDS output');
          if (fixture.mode !== 'single') fs.writeFileSync(options.env.GDS_NAV_AUDIT_FILE, JSON.stringify({ path: fixture.alias, before: { exists: false }, after: { exists: true } }) + '\n');
          proc.emit('close', 0);
        });
        return proc;
      } };
      return originalLoad.call(this, name, ...args);
    };
    const { runPythonScript } = require(bundle);
    Module._load = originalLoad;
    fs.promises.stat = async function (file, ...args) {
      if (file === fixture.alias) {
        if (fixture.mode === 'stat-failure') throw Object.assign(new Error('output disappeared'), { code: 'ENOENT' });
        return originalStat.call(this, fixture.file, ...args);
      }
      return originalStat.call(this, file, ...args);
    };
    fs.promises.realpath = async function (file, ...args) {
      fixture.realpathCalls.push(file);
      if (fixture.mode === 'all-realpath-failure' || (fixture.mode === 'alias-realpath-failure' && file === fixture.alias)) throw Object.assign(new Error('canonicalization unavailable'), { code: 'EACCES' });
      return originalRealpath.call(this, file === fixture.alias ? fixture.file : file, ...args);
    };
    const cases = ['single', 'aliases', 'alias-realpath-failure', 'all-realpath-failure', 'stat-failure'];
    for (const mode of cases) {
      const cwd = path.join(temp, mode); fs.mkdirSync(cwd);
      fixture = { mode, file: path.join(cwd, 'one.gds'), alias: path.join(cwd, 'virtual-alias.gds'), realpathCalls: [] };
      const result = await runPythonScript('simulated-python', path.join(cwd, 'build.py'), cwd, { show() {}, appendLine() {} }, { timeoutMs: 5000 });
      if (mode.endsWith('realpath-failure')) {
        assert.equal(result.ok, false, mode);
        assert.match(result.reason, /multiple GDS files \(2\)/);
        assert.deepEqual(result.candidates, [fixture.file, fixture.alias].sort(), mode);
      } else {
        assert.equal(result.ok, true, mode);
        assert.deepEqual(result.candidates, [fixture.file], mode);
      }
      if (mode === 'single') assert.deepEqual(fixture.realpathCalls, [], 'one candidate needs no additional canonicalization');
    }
    console.log(JSON.stringify({ status: 'passed', cases: cases.length, singleCandidateRealpathCalls: 0 }));
  } finally {
    Module._load = originalLoad;
    fs.promises.stat = originalStat;
    fs.promises.realpath = originalRealpath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
