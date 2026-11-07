#!/usr/bin/env node
'use strict';

// Contract tests for the EnvProvider lifecycle.  These deliberately load the
// real provider with only the VS Code surface and discovery/probe leaves
// controlled, so cancellation and generation ownership are observable.
const assert = require('assert/strict');
const esbuild = require('esbuild');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.resolve(__dirname, '../..');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-env-shutdown-')), 'env.cjs');
esbuild.buildSync({ entryPoints: [path.join(root, 'src/envProvider.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode'], outfile: out });

const configValues = new Map();
const configurationListeners = new Set();
const statusItems = [];
const vscode = {
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3 },
  Uri: { file: fsPath => ({ fsPath }) },
  window: {
    createStatusBarItem() {
      const item = { disposed: false, showCount: 0, dispose() { this.disposed = true; }, show() { this.showCount++; } };
      statusItems.push(item); return item;
    },
    showQuickPick: async () => undefined, showInformationMessage() {}, showErrorMessage() {},
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: path.join(root, '.missing-workspace') } }],
    getConfiguration(section) {
      return { get: (_key, fallback) => configValues.get(section) ?? fallback,
        update: async (_key, value) => { configValues.set(section, value || ''); } };
    },
    onDidChangeConfiguration(callback) {
      const entry = { callback, disposed: false, dispose() { this.disposed = true; configurationListeners.delete(this); } };
      configurationListeners.add(entry); return entry;
    },
  },
};
const originalLoad = Module._load;
Module._load = (name, ...args) => name === 'vscode' ? vscode : originalLoad.call(Module, name, ...args);
const { EnvProvider } = require(out);
Module._load = originalLoad;

const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const diagnostics = (python, extra = {}) => ({ executable: python,
  gdsfactory: { path: '/fork/gdsfactory/__init__.py' }, klayout: { path: '/klayout/db.py' },
  provenance: { available: true }, ...extra });
function makeContext() {
  const values = new Map();
  const subscriptions = [];
  return { values, subscriptions,
    workspaceState: { get: key => values.get(key), update: async (key, value) => value === undefined ? values.delete(key) : values.set(key, value) } };
}
function fireConfiguration() {
  for (const listener of [...configurationListeners]) listener.callback({ affectsConfiguration: () => true });
}
function stop(provider) { return typeof provider.shutdown === 'function' ? provider.shutdown() : Promise.resolve(); }
function dispose(provider) { if (typeof provider.dispose === 'function') provider.dispose(); }
function resetHarness() { configValues.clear(); }

async function testPendingDiscoveryShutdown() {
  resetHarness();
  const context = makeContext(); const discovery = gate();
  const provider = new EnvProvider(context, { discover: async () => discovery.promise, probe: async python => diagnostics(python) });
  const ready = provider.ready(); await tick();
  try {
    const stopping = stop(provider);
    let settled = false; stopping.then(() => { settled = true; }, () => { settled = true; }); await tick();
    assert.equal(settled, false, 'shutdown must wait for pending discovery to drain');
    discovery.release([]); await ready; await stopping;
    assert.equal(provider.getPython(), 'python');
  } finally {
    discovery.release([]); await ready.catch(() => {}); await stop(provider).catch(() => {}); dispose(provider);
  }
}

async function testActiveProbeShutdownError() {
  resetHarness();
  const context = makeContext(); const cleanup = gate(); let probeSignal; let probes = 0;
  const provider = new EnvProvider(context, { discover: async () => ['active'], probe: async (python, _timeout, signal) => {
    probes++; probeSignal = signal;
    await cleanup.promise;
    return diagnostics(python, { error: 'Python diagnostics cancelled', shutdownError: 'probe cleanup failed' });
  } });
  const ready = provider.ready(); void ready.catch(() => {}); await tick(); await tick();
  try {
    const stopping = stop(provider);
    assert.equal(probeSignal?.aborted, true, 'shutdown must abort active probe');
    let settled = false; stopping.then(() => { settled = true; }, () => { settled = true; }); await tick();
    assert.equal(settled, false, 'shutdown must wait for active probe cleanup');
    cleanup.release(); await assert.rejects(ready, /Python diagnostics cancelled/);
    await assert.rejects(stopping, error => error?.errors?.some(item => item?.shutdownError === 'probe cleanup failed'));
    assert.equal(probes, 1);
  } finally {
    cleanup.release(); await ready.catch(() => {}); await stop(provider).catch(() => {}); dispose(provider);
  }
}

async function testInvalidationManualPriority() {
  resetHarness();
  const context = makeContext(); const old = gate(); let oldSignal; let updates = 0;
  vscode.workspace.getConfiguration = section => ({ get: (_key, fallback) => configValues.get(section) ?? fallback,
    update: async (_key, value) => { updates++; configValues.set(section, value || ''); } });
  const provider = new EnvProvider(context, { discover: async () => ['old'], probe: (python, _timeout, signal) => { oldSignal = signal; return old.promise.then(() => diagnostics(python)); } });
  const pending = provider.ready();
  try {
    await tick(); configValues.set('gdsNavigator', 'configured'); provider.invalidateAutomatic(); await provider.setPython('manual');
    assert.equal(oldSignal?.aborted, true, 'invalidation/manual choice must cancel superseded probe');
    old.release(); await pending; assert.equal(provider.getPython(), 'manual');
    assert.equal(updates, 1, 'only the explicit manual choice may write configuration');
  } finally {
    old.release(); await pending.catch(() => {}); await stop(provider).catch(() => {}); dispose(provider);
  }
}

async function testReplacementGeneration() {
  resetHarness();
  const context = makeContext(); const first = gate(); let firstSignal; let calls = 0;
  const provider = new EnvProvider(context, { discover: async () => [calls++ ? 'replacement' : 'first'], probe: (python, _timeout, signal) => {
    if (python === 'first') { firstSignal = signal; return first.promise.then(() => diagnostics(python)); }
    return Promise.resolve(diagnostics(python));
  } });
  const initial = provider.ready(); await tick(); provider.invalidateAutomatic(); const replacement = provider.ready();
  try {
    await replacement; assert.equal(provider.getPython(), 'replacement'); assert.equal(firstSignal?.aborted, true);
  } finally {
    first.release(); await initial.catch(() => {}); await replacement.catch(() => {}); await stop(provider).catch(() => {}); dispose(provider);
  }
}

async function testRetiredCleanupFailurePropagation() {
  resetHarness();
  const context = makeContext(); const cleanup = gate(); let oldSignal; let calls = 0;
  const provider = new EnvProvider(context, {
    discover: async () => [calls++ ? 'replacement' : 'retired'],
    probe: (python, _timeout, signal) => {
      if (python === 'retired') {
        oldSignal = signal;
        return cleanup.promise.then(() => diagnostics(python, { error: 'Python diagnostics cancelled', shutdownError: 'retired cleanup failed' }));
      }
      return Promise.resolve(diagnostics(python));
    },
  });
  const initial = provider.ready(); void initial.catch(() => {}); await tick();
  try {
    provider.invalidateAutomatic();
    const replacement = provider.ready();
    assert.equal(oldSignal?.aborted, true, 'replacement generation must abort retired probe');
    cleanup.release();
    await replacement;
    await assert.rejects(stop(provider), error => error?.errors?.some(item => item?.shutdownError === 'retired cleanup failed'));
  } finally {
    cleanup.release(); await initial.catch(() => {}); await stop(provider).catch(() => {}); dispose(provider);
  }
}

async function testConfigAfterShutdownAndDisposal() {
  resetHarness();
  const context = makeContext(); let discoveries = 0;
  const provider = new EnvProvider(context, { discover: async () => { discoveries++; return ['ok']; }, probe: async python => diagnostics(python) });
  await provider.ready(); const before = discoveries; const item = statusItems.at(-1); const subscription = context.subscriptions.find(value => value.callback);
  await stop(provider); fireConfiguration(); await tick();
  assert.equal(discoveries, before, 'configuration events after shutdown must not rediscover');
  assert.equal(item.disposed, true, 'status item must be disposed'); assert.equal(subscription.disposed, true, 'configuration listener must be disposed');
  const stopping = stop(provider); dispose(provider); assert.equal(stop(provider), stopping, 'shutdown must be idempotent');
}

async function testSuccessAndFallback() {
  resetHarness();
  const context = makeContext(); const provider = new EnvProvider(context, { discover: async () => ['broken', 'viewer'], probe: async python => python === 'broken'
    ? diagnostics(python, { error: 'broken', gdsfactory: { error: 'broken' } })
    : { executable: python, klayout: { path: '/klayout/db.py' }, provenance: { available: false } } });
  await provider.ready(); assert.equal(provider.getPython(), 'viewer', 'KLayout-only fallback must remain usable');
  await stop(provider); dispose(provider);
}

(async () => {
  await testPendingDiscoveryShutdown();
  await testActiveProbeShutdownError();
  await testInvalidationManualPriority();
  await testReplacementGeneration();
  await testRetiredCleanupFailurePropagation();
  await testConfigAfterShutdownAndDisposal();
  await testSuccessAndFallback();
  console.log(JSON.stringify({ status: 'passed', pendingDiscovery: true, activeProbeCleanup: true, invalidation: true,
    replacementGeneration: true, configAfterShutdown: true, disposal: true, fallback: true }));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});
