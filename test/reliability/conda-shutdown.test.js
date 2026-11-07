#!/usr/bin/env node
'use strict';

// In-process contract tests: no conda or Python subprocess is ever started.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '../..');
const REPORT_DIR = path.resolve(process.env.GDS_CONDA_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'conda-shutdown'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanupState = { temp: null, provider: null, originalLoad: null, originalSpawn: null, childProcess: null, records: [] };

class FakeProcess extends EventEmitter {
  constructor() {
    super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.pid = 4321; this.closed = false;
  }
  close(code = 0) { if (this.closed) return; this.closed = true; this.emit('close', code, null); }
  kill() { this.close(); }
}

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-conda-contract-'));
  cleanupState.temp = temp;
  const bundle = path.join(temp, 'env.cjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'envProvider.ts')], bundle: true, platform: 'node', format: 'cjs',
    external: ['vscode', 'child_process'], outfile: bundle,
    plugins: [{
      name: 'conda-contract-stubs',
      setup(build) {
        build.onResolve({ filter: /^\.\/pythonProcess$/ }, () => ({ path: 'python-process-contract', namespace: 'conda-contract' }));
        build.onResolve({ filter: /^\.\/projectEnvironment$/ }, () => ({ path: 'project-environment-contract', namespace: 'conda-contract' }));
        build.onResolve({ filter: /^\.\/pythonEnvironmentManager$/ }, () => ({ path: 'environment-manager-contract', namespace: 'conda-contract' }));
        build.onLoad({ filter: /.*/, namespace: 'conda-contract' }, args => ({ loader: 'js', contents:
          args.path === 'python-process-contract' ? 'module.exports = { spawnPythonProcess: (...args) => globalThis.__spawnPythonProcess(...args) };' :
          args.path === 'project-environment-contract' ? 'module.exports = { readProjectEnvironment: () => undefined, saveProjectEnvironment: () => undefined };' :
          'module.exports = { PythonEnvironmentManager: class {} };' }));
      },
    }],
  });

  const subscriptions = [];
  const config = { gdsNavigator: '', python: '' };
  const vscode = {
    StatusBarAlignment: { Left: 1 }, ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3 },
    Uri: { file: fsPath => ({ fsPath }) },
    window: { createStatusBarItem: () => ({ show() {}, dispose() {} }) },
    workspace: {
      workspaceFolders: [],
      getConfiguration(section) { return { get: (_key, fallback) => config[section] || fallback, update: async () => {} }; },
      onDidChangeConfiguration() { const d = { dispose() {} }; subscriptions.push(d); return d; },
    },
  };
  const originalLoad = Module._load; cleanupState.originalLoad = originalLoad;
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn; cleanupState.originalSpawn = originalSpawn; cleanupState.childProcess = childProcess;
  let active;
  childProcess.spawn = () => { active = new FakeProcess(); return active; };
  Module._load = (request, ...args) => request === 'vscode' ? vscode : originalLoad.call(Module, request, ...args);
  const { EnvProvider } = require(bundle);
  const context = { workspaceState: { get: () => undefined, update: async () => {} }, subscriptions };
  const provider = new EnvProvider(context, { discover: async () => [] }); cleanupState.provider = provider;

  const records = cleanupState.records;
  globalThis.__spawnPythonProcess = (...args) => {
    const proc = new FakeProcess();
    active = proc;
    const record = { args, proc, terminateCalled: false, releaseTerminate: null, rejectTerminate: null };
    record.terminate = new Promise((resolve, reject) => { record.releaseTerminate = resolve; record.rejectTerminate = reject; });
    records.push(record);
    return { proc, terminate: () => { record.terminateCalled = true; return record.terminate; } };
  };

  const normal = provider.listCondaEnvs(100);
  // The baseline may use raw child_process.spawn; the barrier assertions below
  // are the meaningful red. The patched path must populate this ownership log.
  active.stdout.emit('data', Buffer.from(JSON.stringify({ envs: ['/opt/a', '/opt/a', '/opt/b'] })));
  active.close();
  assert.deepEqual(await normal, [{ name: 'a', prefix: '/opt/a' }, { name: 'b', prefix: '/opt/b' }]);

  const missing = provider.listCondaEnvs(100);
  active.emit('error', Object.assign(new Error('conda missing'), { code: 'ENOENT' }));
  assert.deepEqual(await missing, [], 'missing conda remains an ordinary empty result');

  const timeout = provider.listCondaEnvs(3);
  await sleep(25);
  if (records.at(-1)) assert.equal(records.at(-1).terminateCalled, true, 'timeout must request verified termination');
  let timeoutSettled = false; timeout.then(() => { timeoutSettled = true; }, () => { timeoutSettled = true; });
  await sleep(5); assert.equal(timeoutSettled, false, 'timeout result must wait for the termination barrier');
  active.close(); records.at(-1)?.releaseTerminate();
  assert.deepEqual(await timeout, []);

  // Late output/close events after stop has started cannot revive the result.
  active.stdout.emit('data', Buffer.from(JSON.stringify({ envs: ['/late'] })));
  active.close();

  const overflow = provider.listCondaEnvs(1000);
  active.stdout.emit('data', Buffer.alloc(128 * 1024 + 1));
  await sleep(5);
  if (records.at(-1)) assert.equal(records.at(-1).terminateCalled, true, 'output overflow must request verified termination');
  let overflowSettled = false; overflow.then(() => { overflowSettled = true; }, () => { overflowSettled = true; });
  await sleep(5); assert.equal(overflowSettled, false, 'overflow result must wait for the termination barrier');
  active.close(); records.at(-1)?.releaseTerminate();
  assert.deepEqual(await overflow, []);

  const cancelledController = new AbortController();
  const cancelled = provider.listCondaEnvs(1000, cancelledController.signal);
  cancelledController.abort(); await sleep(5);
  if (records.at(-1)) assert.equal(records.at(-1).terminateCalled, true, 'cancellation must request verified termination');
  let cancelledSettled = false; cancelled.then(() => { cancelledSettled = true; }, () => { cancelledSettled = true; });
  await sleep(5); assert.equal(cancelledSettled, false, 'cancellation must wait for the termination barrier');
  active.close(); records.at(-1)?.releaseTerminate();
  assert.deepEqual(await cancelled, []);

  const preAborted = new AbortController(); preAborted.abort();
  const spawnedBeforePreAbort = records.length;
  assert.deepEqual(await provider.listCondaEnvs(1000, preAborted.signal), []);
  assert.equal(records.length, spawnedBeforePreAbort, 'pre-aborted listing must not spawn');

  const unverified = provider.listCondaEnvs(3);
  await sleep(25); const failure = new Error('could not confirm exit'); failure.shutdownError = 'could not confirm exit';
  records.at(-1).rejectTerminate(failure);
  await assert.rejects(unverified, error => error.shutdownError === 'could not confirm exit');

  const external = provider.listCondaEnvs(1000, new AbortController().signal);
  const shutdown = provider.shutdown();
  let shutdownSettled = false;
  shutdown.then(() => { shutdownSettled = true; }, () => { shutdownSettled = true; });
  await sleep(5);
  assert.equal(records.at(-1).terminateCalled, true, 'shutdown must drain externally-signalled listings');
  let externallySettled = false; external.then(() => { externallySettled = true; }, () => { externallySettled = true; });
  await sleep(5); assert.equal(externallySettled, false, 'shutdown must wait for external listing cleanup');
  assert.equal(shutdownSettled, false, 'an earlier cleanup failure must not skip the remaining shutdown drain');
  active.close(); records.at(-1).releaseTerminate();
  assert.deepEqual(await external, []);

  const report = { status: 'passed', controls: ['json-dedupe-order', 'missing-conda', 'late-events-ignored', 'preabort-no-spawn', 'terminal-no-spawn'], barriers: ['timeout', 'overflow', 'cancel', 'external-signal-shutdown'], unverifiedShutdown: true };
  await assert.rejects(shutdown, error => String(error?.message || error).includes('could not confirm exit'));
  const spawnedBeforeTerminal = records.length;
  assert.deepEqual(await provider.listCondaEnvs(1000), []);
  assert.equal(records.length, spawnedBeforeTerminal, 'terminal provider must not spawn');
  assert(records.length >= 7 && records.every(record => record.args[0] === 'conda'
    && JSON.stringify(record.args[1]) === JSON.stringify(['env', 'list', '--json'])), 'each listing must use the owned process helper with the original command');
  fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}

async function cleanup() {
  for (const record of cleanupState.records) { record.proc.close(); record.releaseTerminate(); }
  try { await cleanupState.provider?.shutdown?.().catch(() => {}); } catch {}
  cleanupState.childProcess && (cleanupState.childProcess.spawn = cleanupState.originalSpawn);
  if (cleanupState.originalLoad) Module._load = cleanupState.originalLoad;
  delete globalThis.__spawnPythonProcess;
  if (cleanupState.temp) fs.rmSync(cleanupState.temp, { recursive: true, force: true });
}

main().then(() => cleanup()).catch(async error => { await cleanup(); console.error(error.stack || error); process.exitCode = 1; });
