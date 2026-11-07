#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { inventoryProcesses } = require('../../scripts/process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '../..');
const REPORT_DIR = path.resolve(process.env.GDS_ENVIRONMENT_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'environment-shutdown-process'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (fs.existsSync(file)) return; await sleep(20); }
  throw new Error(`Timed out waiting for ${file}`);
}

function writeFixture(dir) {
  const parentPid = path.join(dir, 'parent.pid');
  const helperPid = path.join(dir, 'helper.pid');
  const ready = path.join(dir, 'ready');
  const gate = path.join(dir, 'gate');
  const helper = path.join(dir, 'helper.py');
  fs.writeFileSync(helper, `import os, signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen(${JSON.stringify(helperPid)}, 'w').write(str(os.getpid()))\nwhile True: time.sleep(1)\n`);
  const fixture = path.join(dir, 'fixture.py');
  fs.writeFileSync(fixture, `import os, signal, subprocess, sys, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen(${JSON.stringify(parentPid)}, 'w').write(str(os.getpid()))\nsubprocess.Popen([sys.executable, ${JSON.stringify(helper)}])\nopen(${JSON.stringify(ready)}, 'w').write('ready')\nwhile not os.path.exists(${JSON.stringify(gate)}): time.sleep(0.01)\nwhile True: time.sleep(1)\n`);
  return { fixture, parentPid, helperPid, ready, gate };
}

async function ownedRows(marker, pids) {
  const rows = await inventoryProcesses();
  return pids.map(pid => rows.find(row => row.pid === pid && row.command.includes(marker))).filter(Boolean);
}

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-env-shutdown-')));
  const bundle = path.join(temp, 'env.cjs');
  const report = { status: 'failed', platform: process.platform, tempDir: temp, cases: [] };
  const baseline = process.env.GDS_ENVIRONMENT_BASELINE === '1';
  let originalLoad;
  let originalSpawn;
  const owned = new Map();
  const providers = new Set();
  let pendingReady;
  try {
    if (process.platform === 'win32') {
      report.status = 'skipped'; report.reason = 'process fixture uses POSIX signal semantics';
      return;
    }
    const python = path.resolve((process.env.GDS_TEST_PYTHON || process.env.GDS_PYTHON || path.join(ROOT, '.venv-fork', 'bin', 'python')).trim());
    assert(fs.existsSync(python), `Python interpreter is required: ${python}`);
    const fixture = writeFixture(temp);
    await esbuild.build({ entryPoints: [path.join(ROOT, 'src', 'envProvider.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle });

    const config = { gdsNavigator: '', python: '' };
    const subscriptions = [];
    const vscode = {
      StatusBarAlignment: { Left: 1 }, ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3 },
      Uri: { file: fsPath => ({ fsPath }) },
      window: { createStatusBarItem: () => ({ show() {}, dispose() {} }) },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: temp } }],
        getConfiguration(section) { return { get: (_key, fallback) => config[section] || fallback, update: async (_key, value) => { config[section] = value || ''; } }; },
        onDidChangeConfiguration() { const item = { dispose() {} }; subscriptions.push(item); return item; },
      },
    };
    originalLoad = Module._load;
    Module._load = (request, ...args) => request === 'vscode' ? vscode : originalLoad.call(Module, request, ...args);
    originalSpawn = childProcess.spawn;
    const marker = 'gds-environment-shutdown-marker';
    let spawnCount = 0;
    const marker2 = 'gds-environment-shutdown-marker-2';
    let secondFixture;
    let condaFixture;
    childProcess.spawn = (file, args, options) => {
      if (file !== marker && file !== marker2 && file !== 'conda') return originalSpawn(file, args, options);
      spawnCount++;
      // Keep spawn options intact; only substitute the private fixture executable.
      const selected = file === marker2 ? secondFixture : file === 'conda' ? condaFixture : fixture;
      return originalSpawn(python, [selected.fixture], options);
    };
    const { EnvProvider, inspectPython } = require(bundle);
    const values = new Map();
    const context = { workspaceState: { get: key => values.get(key), update: async (key, value) => value === undefined ? values.delete(key) : values.set(key, value) }, subscriptions };
    let forwarded;
    const probe = (pythonPath, timeoutMs, signal) => {
      forwarded = { pythonPath, timeoutMs, signal };
      return inspectPython(pythonPath, timeoutMs, signal);
    };
    const provider = new EnvProvider(context, { discover: async () => [marker], probe });
    providers.add(provider);
    let readySettled = false;
    let readyRejection;
    pendingReady = provider.ready();
    // Keep retired-generation failures observed; a forced baseline cleanup must
    // not turn the intentionally stalled probe into an unhandled rejection.
    pendingReady.then(() => { readySettled = true; }, error => { readySettled = true; readyRejection = error; });
    await waitForFile(fixture.ready);
    await waitForFile(fixture.helperPid);
    const pids = [Number(fs.readFileSync(fixture.parentPid)), Number(fs.readFileSync(fixture.helperPid))];
    const rows = await inventoryProcesses();
    for (const pid of pids) {
      const row = rows.find(candidate => candidate.pid === pid && candidate.command.includes(temp));
      assert(row && row.start, `cannot authenticate owned process ${pid}`);
      owned.set(`${row.pid}:${row.start}`, row);
    }
    const helperRow = (await inventoryProcesses()).find(row => row.pid === pids[1] && row.command.includes(temp));
    assert(helperRow && helperRow.start, `cannot authenticate helper process ${pids[1]}`);
    assert.equal(forwarded.pythonPath, marker);
    if (!baseline) assert(forwarded.signal instanceof AbortSignal, 'automatic probe must receive an AbortSignal');

    const manual = provider.setPython('manual-selected-python');
    await sleep(20);
    await manual;
    if (baseline) {
      // Legacy behavior: the active real probe remains alive and no shutdown
      // owner exists (or shutdown resolves without waiting for the probe).
      const signalAborted = Boolean(forwarded.signal?.aborted);
      const survivorsBeforeCleanup = await ownedRows(temp, pids);
      const oldShutdown = typeof provider.shutdown === 'function' ? provider.shutdown() : Promise.resolve();
      let oldShutdownSettled = false;
      oldShutdown.then(() => { oldShutdownSettled = true; }, error => { oldShutdownSettled = true; readyRejection ||= error; });
      await sleep(40);
      const survivorsAfterShutdown = await ownedRows(temp, pids);
      report.cases.push({ name: 'legacy-manual-race-baseline', status: 'observed', pids, signal: forwarded.signal ? 'supplied' : 'undefined', signalAborted, readySettled, readyRejection: readyRejection ? String(readyRejection) : undefined, oldShutdownSettled, survivorsBeforeCleanup: survivorsBeforeCleanup.map(row => row.pid), survivorsAfterShutdown: survivorsAfterShutdown.map(row => row.pid), spawnCount });
      report.status = 'baseline-observed';
      // Do not await the intentionally stalled old probe. The finally block
      // authenticates and removes only its exact parent/helper identities.
      return;
    }
    const shutdown = provider.shutdown();
    let settled = false;
    shutdown.then(() => { settled = true; }, error => { readyRejection ||= error; });
    fs.writeFileSync(fixture.gate, 'go');
    await shutdown;
    assert.equal(settled, true, 'shutdown must settle after probe cleanup');
    assert.equal(provider.getPython(), 'manual-selected-python', 'superseded automatic result must not overwrite manual choice');
    assert.equal(spawnCount, 1, 'manual selection must prevent later automatic candidates');
    const survivors = await ownedRows(temp, pids);
    assert.equal(survivors.length, 0, `owned processes survived shutdown: ${survivors.map(row => row.pid).join(', ')}`);
    await pendingReady;
    report.cases.push({ name: 'manual-selection-and-graceful-shutdown', status: 'passed', pids, signalForwarded: true, spawnCount });

    // Independent shutdown-only proof: no manual invalidation is involved.
    // The first case deliberately persisted a manual choice; isolate this
    // provider so the control actually exercises automatic discovery.
    config.gdsNavigator = '';
    config.python = '';
    values.clear();
    fs.mkdirSync(path.join(temp, 'shutdown-only'));
    secondFixture = writeFixture(path.join(temp, 'shutdown-only'));
    const shutdownOnly = new EnvProvider(context, { discover: async () => [marker2], probe });
    providers.add(shutdownOnly);
    const shutdownReady = shutdownOnly.ready();
    shutdownReady.catch(error => { readyRejection ||= error; });
    await waitForFile(secondFixture.ready);
    await waitForFile(secondFixture.helperPid);
    const shutdownPids = [Number(fs.readFileSync(secondFixture.parentPid)), Number(fs.readFileSync(secondFixture.helperPid))];
    const shutdownRows = await inventoryProcesses();
    for (const pid of shutdownPids) {
      const row = shutdownRows.find(candidate => candidate.pid === pid && candidate.command.includes(path.join(temp, 'shutdown-only')));
      assert(row && row.start, `cannot authenticate shutdown-only process ${pid}`);
      owned.set(`${row.pid}:${row.start}`, row);
    }
    const shutdownOnlyPromise = shutdownOnly.shutdown();
    await shutdownOnlyPromise;
    assert.equal((await ownedRows(path.join(temp, 'shutdown-only'), shutdownPids)).length, 0, 'shutdown-only probe processes survived');
    await shutdownReady;
    report.cases.push({ name: 'active-shutdown-only', status: 'passed', pids: shutdownPids, signalForwarded: true });

    // Conda discovery owns the same helper lifetime but uses the direct
    // process path rather than inspectPython's probe. Keep its context fresh.
    fs.mkdirSync(path.join(temp, 'conda-only'));
    condaFixture = writeFixture(path.join(temp, 'conda-only'));
    const condaValues = new Map();
    const condaContext = { workspaceState: { get: key => condaValues.get(key), update: async (key, value) => value === undefined ? condaValues.delete(key) : condaValues.set(key, value) }, subscriptions: [] };
    const condaProvider = new EnvProvider(condaContext, { discover: async () => [] });
    providers.add(condaProvider);
    const condaList = condaProvider.listCondaEnvs(10_000);
    await waitForFile(condaFixture.ready);
    await waitForFile(condaFixture.helperPid);
    const condaPids = [Number(fs.readFileSync(condaFixture.parentPid)), Number(fs.readFileSync(condaFixture.helperPid))];
    const condaRows = await inventoryProcesses();
    for (const pid of condaPids) {
      const row = condaRows.find(candidate => candidate.pid === pid && candidate.command.includes(path.join(temp, 'conda-only')));
      assert(row && row.start, `cannot authenticate Conda process ${pid}`);
      owned.set(`${row.pid}:${row.start}`, row);
    }
    let condaListSettled = false;
    condaList.then(() => { condaListSettled = true; }, () => { condaListSettled = true; });
    const condaShutdown = condaProvider.shutdown();
    let condaShutdownSettled = false;
    condaShutdown.then(() => { condaShutdownSettled = true; }, () => { condaShutdownSettled = true; });
    await condaShutdown;
    assert.equal((await ownedRows(path.join(temp, 'conda-only'), condaPids)).length, 0, 'Conda discovery processes survived shutdown');
    await condaList;
    assert.equal(condaShutdownSettled, true);
    assert.equal(condaListSettled, true);
    report.cases.push({ name: 'conda-list-and-shutdown', status: 'passed', pids: condaPids, spawnCount });
    report.status = 'passed';
  } catch (error) {
    report.error = String(error && error.stack || error);
    throw error;
  } finally {
    if (originalSpawn) childProcess.spawn = originalSpawn;
    if (originalLoad) Module._load = originalLoad;
    // No group kill: only identities authenticated from this fixture may be signalled.
    let rows;
    try { rows = await inventoryProcesses(); }
    catch (error) {
      report.cleanupError = `cannot verify process inventory during emergency cleanup: ${error.message}`;
      rows = [];
    }
    for (const identity of owned.values()) {
      const current = rows.find(row => row.pid === identity.pid && row.start === identity.start && row.command.includes(temp));
      if (current) { try { process.kill(current.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') report.cleanupError = String(error); } }
    }
    const deadline = Date.now() + 2500;
    let survivors = [];
    do {
      try { survivors = await ownedRows(temp, [...owned.values()].map(row => row.pid)); }
      catch (error) { report.cleanupError = `cannot verify survivors after emergency cleanup: ${error.message}`; break; }
      if (!survivors.length) break;
      await sleep(30);
    } while (Date.now() < deadline);
    // Killing only authenticated fixture identities should release a stalled
    // real probe; observe its terminal state before writing the report.
    if (pendingReady) {
      await Promise.race([pendingReady.catch(() => {}), sleep(1500)]);
    }
    for (const provider of providers) {
      try { await Promise.race([provider.shutdown(), sleep(1500)]); } catch { /* reported by the owning assertion */ }
    }
    report.ownedIdentities = [...owned.values()].map(row => ({ pid: row.pid, start: row.start, command: row.command }));
    report.cleanup = { verified: survivors.length === 0 && !report.cleanupError, survivors: survivors.map(row => ({ pid: row.pid, start: row.start })) };
    fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    if (survivors.length || report.cleanupError) process.exitCode = 1;
    if (report.cleanup.verified && report.status === 'passed') fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
