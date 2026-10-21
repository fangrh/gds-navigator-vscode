'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { inventoryProcesses } = require('../../scripts/process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '../..');
const defaultPython = process.platform === 'win32'
  ? path.join(ROOT, '.venv-fork', 'Scripts', 'python.exe')
  : path.join(ROOT, '.venv-fork', 'bin', 'python');
const PYTHON = path.resolve(process.env.GDS_TEST_PYTHON || process.env.GDS_PYTHON || defaultPython);
const REPORT_DIR = path.resolve(process.env.GDS_PYTHON_SHUTDOWN_OUT || path.join(ROOT, 'logs', 'reliability', 'python-shutdown'));
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

function loadParser(bundleDir) {
  bundle(path.join(ROOT, 'src', 'parseGdsCore.ts'), path.join(bundleDir, 'parseGdsCore.js'));
  return require(path.join(bundleDir, 'parseGdsCore.js')).parseGdsFileCore;
}

function output() { return { show() {}, appendLine() {} }; }

function expectFailure(promise, pattern) {
  const result = assert.rejects(promise, pattern);
  // A wrong early rejection must reach the case's catch/finally, even while it
  // is still waiting for the fixture's ready marker.
  void result.catch(() => {});
  return result;
}

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function recordOwned(temp, owned) {
  const rows = await inventoryProcesses();
  const markers = [temp, fs.realpathSync(temp)];
  // The unique test directory also finds a process whose PID file was not yet
  // written when a ready wait failed. These paths belong only to this test.
  for (const row of rows.filter(candidate => markers.some(marker => candidate.command.includes(marker)))) {
    assert(row.start, `cannot verify start identity for owned process ${row.pid}`);
    owned.set(`${row.pid}:${row.start}`, row);
  }
}

async function forceOwned(owned) {
  let rows = [];
  try { rows = await inventoryProcesses(); } catch (error) { throw new Error(`cannot verify cleanup inventory: ${error.message}`); }
  for (const identity of owned.values()) {
    const row = rows.find((candidate) => candidate.pid === identity.pid && candidate.start === identity.start);
    const pid = identity.pid;
    if (pid === process.pid) throw new Error(`refusing to kill test process ${pid}`);
    if (!row) continue;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(row.pid, 'SIGKILL');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

function writeStubbornScript(dir, ready, pidFile, helperPidFile, kind, gate, action = 'loop') {
  fs.mkdirSync(dir, { recursive: true });
  const helper = path.join(dir, `${kind}-helper.py`);
  fs.writeFileSync(helper, `import os, signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen(${JSON.stringify(helperPidFile)}, 'w').write(str(os.getpid()))\nwhile True: time.sleep(1)\n`);
  const script = path.join(dir, `${kind}.py`);
  const afterGate = action === 'overflow' ? "print('x' * (33 * 1024 * 1024), flush=True)" : action === 'timeout' ? 'time.sleep(30)' : 'time.sleep(1)';
  fs.writeFileSync(script, `import os, signal, subprocess, sys, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen(${JSON.stringify(pidFile)}, 'w').write(str(os.getpid()))\nsubprocess.Popen([sys.executable, ${JSON.stringify(helper)}])\nopen(${JSON.stringify(ready)}, 'w').write('ready')\nwhile not os.path.exists(${JSON.stringify(gate)}): time.sleep(0.01)\n${afterGate}\nwhile True: time.sleep(1)\n`);
  return script;
}

async function survivingOwned(owned, pids) {
  const rows = await inventoryProcesses();
  return pids.filter(pid => {
    assert(Number.isInteger(pid) && pid > 0, `invalid owned PID ${pid}`);
    const current = rows.find(row => row.pid === pid);
    if (!current) return false;
    assert([...owned.values()].some(row => row.pid === pid && row.start === current.start), `cannot verify owned PID ${pid}: identity changed or was not recorded`);
    return true;
  });
}

async function assertOwnedGone(owned, pids) {
  const survivors = await survivingOwned(owned, pids);
  assert.equal(survivors.length, 0, `owned processes remained at settlement: ${survivors.join(', ')}`);
}

(async () => {
  assert(fs.existsSync(PYTHON), `Python interpreter is required: ${PYTHON}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-python-shutdown-'));
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-python-shutdown-bundle-'));
  const report = { python: PYTHON, platform: process.platform, cases: [] };
  const owned = new Map();
  try {
    const { runPythonScript } = loadRunner(bundleDir);
    const parseGdsFileCore = loadParser(bundleDir);
    const parseRoot = path.join(temp, 'parse-extension');
    fs.mkdirSync(path.join(parseRoot, 'python'), { recursive: true });
    const parseScript = path.join(parseRoot, 'python', 'parse_gds.py');
    fs.writeFileSync(parseScript, "import json, sys\nprint(json.dumps({'type':'FeatureCollection','features':[]}))\n");
    const gds = path.join(temp, 'chip.gds'); fs.writeFileSync(gds, 'fixture');

    async function caseRun(name, fn) {
      try { await fn(); report.cases.push({ name, status: 'passed' }); }
      catch (error) { report.cases.push({ name, status: 'failed', error: String(error.stack || error) }); }
    }

    await caseRun('pre-aborted parse with invalid interpreter does not spawn', async () => {
      const probe = path.join(temp, 'preabort-probe.js');
      fs.writeFileSync(probe, `const { parseGdsFileCore } = require(process.argv[2]); const c = new AbortController(); c.abort(); parseGdsFileCore(process.argv[3], process.argv[4], process.argv[5], c.signal).then(() => setImmediate(() => { process.exitCode = 2; })).catch((e) => setImmediate(() => { process.exitCode = /cancelled/.test(e.message) ? 0 : 3; }));`);
      const child = spawn(process.execPath, [probe, path.join(bundleDir, 'parseGdsCore.js'), path.join(temp, 'missing-python'), gds, parseRoot], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      const result = await new Promise((resolve, reject) => {
        let stderr = '';
        const timer = setTimeout(() => reject(new Error('pre-abort probe timed out')), 5000);
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
      });
      assert.equal(result.signal, null, result.stderr); assert.equal(result.code, 0, result.stderr);
    });
    await caseRun('missing interpreter reports normal start error', async () => {
      await assert.rejects(parseGdsFileCore(path.join(temp, 'missing-python'), gds, parseRoot), /Could not start Python/);
    });
    await caseRun('normal parse returns JSON result', async () => {
      const result = await parseGdsFileCore(PYTHON, gds, parseRoot);
      assert.equal(result.mode, 'partial'); assert.equal(result.geojson.type, 'FeatureCollection');
    });
    await caseRun('parse cancellation waits for stubborn process shutdown', async () => {
      const ready = path.join(temp, 'parse-ready'); const gate = path.join(temp, 'parse-gate'); const parent = path.join(temp, 'parse-parent.pid'); const helper = path.join(temp, 'parse-helper.pid');
      const script = writeStubbornScript(path.join(temp, 'parse-stubborn'), ready, parent, helper, 'parse', gate);
      const stubbornRoot = path.join(temp, 'parse-stubborn-extension'); fs.mkdirSync(path.join(stubbornRoot, 'python'), { recursive: true }); fs.copyFileSync(script, path.join(stubbornRoot, 'python', 'parse_gds.py'));
      const controller = new AbortController();
      const promise = parseGdsFileCore(PYTHON, gds, stubbornRoot, controller.signal, 5000);
      const rejected = expectFailure(promise, /cancelled/);
      await waitForFile(ready); await waitForFile(helper); const pids = [Number(fs.readFileSync(parent)), Number(fs.readFileSync(helper))]; await recordOwned(temp, owned); fs.writeFileSync(gate, 'go');
      controller.abort(); await rejected; await assertOwnedGone(owned, pids);
    });
    await caseRun('parse output overflow terminates process', async () => {
      const ready = path.join(temp, 'parse-overflow-ready'); const gate = path.join(temp, 'parse-overflow-gate'); const parent = path.join(temp, 'parse-overflow-parent.pid'); const helper = path.join(temp, 'parse-overflow-helper.pid');
      const script = writeStubbornScript(path.join(temp, 'parse-overflow'), ready, parent, helper, 'parse-overflow', gate, 'overflow'); const root = path.join(temp, 'parse-overflow-extension'); fs.mkdirSync(path.join(root, 'python'), { recursive: true }); fs.copyFileSync(script, path.join(root, 'python', 'parse_gds.py'));
      const promise = parseGdsFileCore(PYTHON, gds, root, undefined, 5000); const rejected = expectFailure(promise, /output exceeded/); await waitForFile(ready); await waitForFile(helper); const pids = [Number(fs.readFileSync(parent)), Number(fs.readFileSync(helper))]; await recordOwned(temp, owned); fs.writeFileSync(gate, 'go'); await rejected; await assertOwnedGone(owned, pids);
    });
    await caseRun('parse timeout reports bounded failure', async () => {
      const ready = path.join(temp, 'parse-timeout-ready'); const gate = path.join(temp, 'parse-timeout-gate'); const parent = path.join(temp, 'parse-timeout-parent.pid'); const helper = path.join(temp, 'parse-timeout-helper.pid');
      const script = writeStubbornScript(path.join(temp, 'parse-timeout'), ready, parent, helper, 'parse-timeout', gate, 'timeout'); const root = path.join(temp, 'parse-timeout-extension'); fs.mkdirSync(path.join(root, 'python'), { recursive: true }); fs.copyFileSync(script, path.join(root, 'python', 'parse_gds.py'));
      const promise = parseGdsFileCore(PYTHON, gds, root, undefined, 500); const rejected = expectFailure(promise, /timed out/); await waitForFile(ready); await waitForFile(helper); const pids = [Number(fs.readFileSync(parent)), Number(fs.readFileSync(helper))]; await recordOwned(temp, owned); fs.writeFileSync(gate, 'go'); await rejected; await assertOwnedGone(owned, pids);
    });

    const buildDir = path.join(temp, 'build'); fs.mkdirSync(buildDir);
    await caseRun('pre-aborted build with invalid interpreter does not spawn', async () => {
      const controller = new AbortController(); controller.abort();
      const result = await runPythonScript(path.join(temp, 'missing-python'), path.join(buildDir, 'missing.py'), buildDir, output(), { signal: controller.signal });
      assert.equal(result.ok, false); assert.match(result.reason, /cancelled/);
    });
    await caseRun('missing interpreter build reports normal start error', async () => {
      const result = await runPythonScript(path.join(temp, 'missing-python'), path.join(buildDir, 'missing.py'), buildDir, output(), { timeoutMs: 1000 });
      assert.equal(result.ok, false); assert.match(result.reason, /Failed to start/);
    });
    const buildScript = path.join(buildDir, 'build.py'); fs.writeFileSync(buildScript, "open('one.gds','w').write('ok')\n");
    await caseRun('normal build returns changed GDS output', async () => {
      const realBuildDir = fs.realpathSync(buildDir);
      const result = await runPythonScript(PYTHON, path.join(realBuildDir, 'build.py'), realBuildDir, output(), { timeoutMs: 5000 });
      assert.equal(result.ok, true, `${result.reason}; candidates=${JSON.stringify(result.candidates)}`); assert.equal(result.gdsPath, path.join(realBuildDir, 'one.gds'));
    });
    await caseRun('build cancellation waits for stubborn process shutdown', async () => {
      const dir = path.join(temp, 'build-stubborn'); fs.mkdirSync(dir); const ready = path.join(dir, 'ready'); const gate = path.join(dir, 'gate'); const parent = path.join(dir, 'parent.pid'); const helper = path.join(dir, 'helper.pid');
      const script = writeStubbornScript(dir, ready, parent, helper, 'build', gate);
      const controller = new AbortController();
      const promise = runPythonScript(PYTHON, script, dir, output(), { timeoutMs: 5000, signal: controller.signal }); await waitForFile(ready); await waitForFile(helper);
      const pids = [Number(fs.readFileSync(parent)), Number(fs.readFileSync(helper))]; await recordOwned(temp, owned); fs.writeFileSync(gate, 'go'); controller.abort();
      const result = await promise; assert.equal(result.ok, false); assert.match(result.reason, /cancelled/); await assertOwnedGone(owned, pids);
    });
    await caseRun('build output overflow terminates process', async () => {
      const dir = path.join(temp, 'build-noisy'); fs.mkdirSync(dir); const ready = path.join(dir, 'ready'); const gate = path.join(dir, 'gate'); const parent = path.join(dir, 'parent.pid'); const helper = path.join(dir, 'helper.pid'); const script = writeStubbornScript(dir, ready, parent, helper, 'build-noisy', gate, 'overflow');
      const promise = runPythonScript(PYTHON, script, dir, output(), { timeoutMs: 5000, maxOutputBytes: 1024 }); const pending = promise; await waitForFile(ready); await waitForFile(helper); const pids = [Number(fs.readFileSync(parent)), Number(fs.readFileSync(helper))]; await recordOwned(temp, owned); fs.writeFileSync(gate, 'go'); const result = await pending;
      assert.equal(result.ok, false); assert.match(result.reason, /output exceeded/); await assertOwnedGone(owned, pids);
    });
    await caseRun('build timeout reports bounded failure', async () => {
      const dir = path.join(temp, 'build-timeout'); fs.mkdirSync(dir); const ready = path.join(dir, 'ready'); const gate = path.join(dir, 'gate'); const parent = path.join(dir, 'parent.pid'); const helper = path.join(dir, 'helper.pid'); const script = writeStubbornScript(dir, ready, parent, helper, 'build-timeout', gate, 'timeout');
      const promise = runPythonScript(PYTHON, script, dir, output(), { timeoutMs: 5000 }); const pending = promise; await waitForFile(ready); await waitForFile(helper); const pids = [Number(fs.readFileSync(parent)), Number(fs.readFileSync(helper))]; await recordOwned(temp, owned); fs.writeFileSync(gate, 'go'); const result = await pending;
      assert.equal(result.ok, false); assert.match(result.reason, /timed out/); await assertOwnedGone(owned, pids);
    });
    if (report.cases.some((entry) => entry.status === 'failed')) {
      throw new Error(report.cases.filter((entry) => entry.status === 'failed').map((entry) => `${entry.name}: ${entry.error}`).join('\n'));
    }
  } finally {
    let cleanupPids = [];
    try {
      await recordOwned(temp, owned);
      cleanupPids = [...new Set([...owned.values()].map(row => row.pid))];
      await forceOwned(owned);
      const deadline = Date.now() + 2500;
      let survivors;
      do {
        survivors = await survivingOwned(owned, cleanupPids);
        if (!survivors.length) break;
        await new Promise(resolve => setTimeout(resolve, 30));
      } while (Date.now() < deadline);
      assert.equal(survivors.length, 0, `owned process cleanup left survivors: ${survivors.join(', ')}`);
      report.cleanup = { verified: true, pids: cleanupPids, survivors };
    } catch (error) { report.cleanupError = String(error.stack || error); report.cleanup = { verified: false, pids: cleanupPids, survivors: 'unverified' }; }
    report.tempDir = temp;
    fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    const failed = report.cases.some((entry) => entry.status === 'failed');
    if (!report.cleanupError && !failed) { fs.rmSync(temp, { recursive: true, force: true }); fs.rmSync(bundleDir, { recursive: true, force: true }); }
    if (report.cleanupError) throw new Error(report.cleanupError);
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
