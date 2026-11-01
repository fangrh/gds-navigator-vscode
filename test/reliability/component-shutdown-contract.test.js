#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const esbuild = require('esbuild');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async (test, label) => {
  const deadline = Date.now() + 5000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
};

function makeChild(jobs, args) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  // Deliberately leave pid undefined: this is a controlled contract fixture;
  // the real worker/process tests cover authenticated OS-process termination.
  proc.kill = () => { proc.killed = true; };
  const job = { proc, args, closed: false };
  jobs.push(job);
  return proc;
}
function closeJob(job, value, code = 0) {
  if (job.closed) return;
  job.closed = true;
  if (value !== undefined) job.proc.stdout.emit('data', Buffer.from(JSON.stringify(value)));
  job.proc.emit('close', code);
}
function payload(id) {
  return { components: [{ name: id, description: '', parameters: [] }], environment: { id } };
}
function fakeVscode() {
  const uri = fsPath => ({ fsPath });
  return {
    window: { createTextEditorDecorationType: () => ({}), showErrorMessage() {}, showInformationMessage() {}, showWarningMessage() {} },
    workspace: {
      isTrusted: true,
      workspaceFolders: [],
      getWorkspaceFolder: () => undefined,
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      createFileSystemWatcher: () => ({ dispose() {}, onDidChange() {}, onDidCreate() {}, onDidDelete() {} }),
    },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    RelativePattern: function (base, pattern) { this.base = base; this.pattern = pattern; },
    OverviewRulerLane: { Right: 4 },
  };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-component-shutdown-contract-'));
  const catalogBundle = path.join(temp, 'componentCatalog.cjs');
  const providerBundle = path.join(temp, 'gdsEditor.cjs');
  const jobs = [];
  const originalLoad = Module._load;
  let provider;
  const pending = [];
  const values = new Map();
  try {
    esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src/componentCatalog.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: catalogBundle });
    esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src/gdsEditor.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: providerBundle });
    Module._load = function (name, ...args) {
      if (name === 'child_process') {
        const childProcess = originalLoad.call(this, name, ...args);
        return { ...childProcess, spawn: (_python, spawnArgs) => makeChild(jobs, spawnArgs) };
      }
      if (name === 'vscode') return fakeVscode();
      return originalLoad.call(this, name, ...args);
    };

    const { loadComponentCatalog, previewComponent } = require(catalogBundle);
    const finalAbort = new AbortController();
    const final = loadComponentCatalog(process.execPath, finalAbort.signal); pending.push(final);
    await waitFor(() => jobs.length === 1, 'catalog child');
    finalAbort.abort();
    let finalSettled = false;
    final.catch(() => { finalSettled = true; });
    await nextTurn();
    assert.equal(finalSettled, false, 'final shared cancellation settled before child close');
    closeJob(jobs[0], payload('closed-after-cancel'));
    await assert.rejects(final, /cancelled/);

    const survivorAbort = new AbortController();
    const canceledPeer = loadComponentCatalog(process.execPath, survivorAbort.signal); pending.push(canceledPeer);
    const survivor = loadComponentCatalog(process.execPath); pending.push(survivor);
    await waitFor(() => jobs.length === 2, 'shared survivor child');
    survivorAbort.abort();
    await assert.rejects(canceledPeer, /cancelled/);
    closeJob(jobs[1], payload('survivor'));
    assert.deepEqual(await survivor, payload('survivor'), 'remaining shared subscriber lost normal JSON');

    const failed = loadComponentCatalog(process.execPath, undefined, undefined, true); pending.push(failed);
    await waitFor(() => jobs.length === 3, 'catalog failure child');
    closeJob(jobs[2], { error: 'controlled component failure' }, 1);
    await assert.rejects(failed, /controlled component failure|component catalog failed/);

    // A child that never emits close exercises the bounded verification-failure
    // path.  The fake has no pid by design, so only the explicit close below
    // can clean up the fixture after the helper reports shutdownError.
    const unverifiedAbort = new AbortController();
    const unverified = loadComponentCatalog(process.execPath, unverifiedAbort.signal, undefined, true); pending.push(unverified);
    await waitFor(() => jobs.length === 4, 'unverified catalog child');
    unverifiedAbort.abort();
    await assert.rejects(unverified, error => !!error?.shutdownError && /confirm Python process/.test(error.shutdownError));
    closeJob(jobs[3], payload('unverified-cleanup'));

    const { GdsEditorProvider } = require(providerBundle);
    const context = {
      extensionUri: { fsPath: ROOT },
      globalStorageUri: { fsPath: path.join(temp, 'storage') },
      workspaceState: { get: key => values.get(key), update: async (key, value) => values.set(key, value) },
    };
    provider = new GdsEditorProvider(context, { ready: async () => {}, getPython: () => process.execPath }, { appendLine() {}, show() {} });
    const messages = [];
    const entry = {
      gdsPath: path.join(temp, 'layout.gds'), ready: true, loading: false, disposed: false,
      saveQueue: Promise.resolve(), images: new Map(), imageRevisions: new Map(), lastSelection: [],
      panel: { webview: { postMessage: async message => { messages.push(message); return true; } } },
    };
    provider.viewers.set(entry.gdsPath, [entry]);
    const request = provider.onMessage(entry, { type: 'requestComponentCatalog', requestId: 'catalog-1' }); pending.push(request);
    await waitFor(() => jobs.length === 5, 'provider catalog child');
    const shutdown = provider.shutdown();
    let shutdownSettled = false;
    shutdown.then(() => { shutdownSettled = true; });
    await nextTurn();
    assert.equal(shutdownSettled, false, 'provider shutdown settled before component child close');
    const jobsBeforeLate = jobs.length;
    const late = provider.onMessage(entry, { type: 'requestComponentCatalog', requestId: 'late' }); pending.push(late);
    await late;
    assert.equal(jobs.length, jobsBeforeLate, 'late request started a component child after shutdown');
    closeJob(jobs[4], payload('provider-close'));
    await request;
    await shutdown;
    assert.deepEqual(messages, [], 'shutdown published a late component response');

    async function providerCase(message, label, jobIndex) {
      const instance = new GdsEditorProvider(context, { ready: async () => {}, getPython: () => process.execPath }, { appendLine() {}, show() {} });
      const emitted = [];
      const item = { gdsPath: path.join(temp, `${label}.gds`), ready: true, loading: false, disposed: false,
        saveQueue: Promise.resolve(), images: new Map(), imageRevisions: new Map(), lastSelection: [],
        panel: { webview: { postMessage: async value => { emitted.push(value); return true; } } } };
      instance.viewers.set(item.gdsPath, [item]);
      const operation = instance.onMessage(item, message); pending.push(operation);
      await waitFor(() => jobs.length === jobIndex + 1, `${label} child`);
      const close = instance.shutdown();
      let done = false; close.then(() => { done = true; });
      await nextTurn(); assert.equal(done, false, `${label} shutdown settled before child close`);
      closeJob(jobs[jobIndex], label === 'preview' ? { name: 'alpha', settings: {}, geojson: { type: 'FeatureCollection', features: [] }, ports: [] } : { items: [{ name: 'alpha', error: 'closed after shutdown' }] });
      await operation; await close;
      assert.deepEqual(emitted, [], `${label} published after shutdown`);
      await instance.shutdown();
    }
    await providerCase({ type: 'previewComponent', requestId: 'preview-1', name: 'alpha', settings: {} }, 'preview', 5);
    await providerCase({ type: 'requestComponentThumbnails', requestId: 'thumb-1', names: ['alpha'] }, 'thumbnail', 6);

    const timeoutRoot = fs.mkdtempSync(path.join(temp, 'timeout-registry-'));
    fs.writeFileSync(path.join(timeoutRoot, 'gds_components.py'), 'COMPONENTS = {}\n');
    const originalSetTimeout = global.setTimeout;
    let timeoutCallback;
    global.setTimeout = (callback, delay, ...args) => {
      if (delay === 45000) {
        timeoutCallback = () => callback(...args);
        const timer = originalSetTimeout(() => {}, 0x7fffffff);
        if (typeof timer.unref === 'function') timer.unref();
        return timer;
      }
      return originalSetTimeout(callback, delay, ...args);
    };
    let timeout;
    try {
      timeout = previewComponent(process.execPath, 'alpha', {}, undefined, timeoutRoot); pending.push(timeout);
      await waitFor(() => jobs.length === 8 && typeof timeoutCallback === 'function', 'component timeout child');
      timeoutCallback();
    } finally {
      global.setTimeout = originalSetTimeout;
    }
    await nextTurn();
    let timeoutSettled = false;
    timeout.catch(() => { timeoutSettled = true; });
    await nextTurn();
    assert.equal(timeoutSettled, false, 'timeout settled before child close');
    closeJob(jobs[7], JSON.parse('{"name":"late","settings":{},"geojson":{}}'));
    await assert.rejects(timeout, /^Error: component catalog request timed out$|component catalog request timed out/);

    const overflowRoot = fs.mkdtempSync(path.join(temp, 'overflow-registry-'));
    fs.writeFileSync(path.join(overflowRoot, 'gds_components.py'), 'COMPONENTS = {}\n');
    const overflow = previewComponent(process.execPath, 'alpha', {}, undefined, overflowRoot); pending.push(overflow);
    await waitFor(() => jobs.length === 9, 'component overflow child');
    jobs[8].proc.stdout.emit('data', Buffer.alloc(32 * 1024 * 1024 + 1));
    let overflowSettled = false;
    overflow.catch(() => { overflowSettled = true; });
    await nextTurn();
    assert.equal(overflowSettled, false, 'output overflow settled before child close');
    jobs[8].proc.stdout.emit('data', Buffer.from(JSON.stringify({ name: 'late', settings: {}, geojson: {} })));
    closeJob(jobs[8], undefined);
    await assert.rejects(overflow, /component catalog output exceeded limit/);
    console.log(JSON.stringify({ status: 'passed', finalCancelDrain: true, sharedSurvivor: true, failurePropagation: true, unverifiedShutdownError: true, providerDrain: true, previewDrain: true, thumbnailDrain: true, timeoutDrain: true, overflowDrain: true, noLatePublication: true }));
  } finally {
    for (const job of jobs) closeJob(job, payload('cleanup'));
    await Promise.allSettled(pending);
    if (provider) await Promise.allSettled([provider.shutdown()]);
    Module._load = originalLoad;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
