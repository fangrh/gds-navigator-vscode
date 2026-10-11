'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');

function loadClipboardUtil(spawn) {
  const bundled = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src/clipboardUtil.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['child_process'],
    write: false,
  }).outputFiles[0].text;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'child_process') return { spawn };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const loaded = new Module(path.join(ROOT, 'src/clipboardUtil.ts'), module);
    loaded.filename = path.join(ROOT, 'src/clipboardUtil.ts');
    loaded.paths = Module._nodeModulePaths(ROOT);
    loaded._compile(bundled, loaded.filename);
    return loaded.exports;
  } finally {
    Module._load = originalLoad;
  }
}

function fakeTimers() {
  let nextId = 1;
  const active = new Map();
  let clearCount = 0;
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      active.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      if (active.delete(id)) clearCount += 1;
    },
    fire(id) {
      const timer = active.get(id);
      assert.ok(timer, `timer ${id} should still be active`);
      active.delete(id);
      timer.callback();
    },
    get activeCount() { return active.size; },
    get clearCount() { return clearCount; },
    onlyId() { assert.equal(active.size, 1); return active.keys().next().value; },
  };
}

function fakeChild({ endError = null, killImpl = null } = {}) {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.killCalls = 0;
  child.stdin.endCalls = [];
  child.kill = () => {
    child.killCalls += 1;
    if (killImpl) killImpl(child);
  };
  child.stdin.end = (text, encoding) => {
    child.stdin.endCalls.push([text, encoding]);
    if (endError) throw endError;
  };
  return child;
}

function expectedInvocation() {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command', '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
    };
  }
  if (process.platform === 'darwin') return { command: 'pbcopy', args: [] };
  return { command: 'xclip', args: ['-selection', 'clipboard'] };
}

async function testSuccessAndInvocation(timers) {
  const child = fakeChild();
  let invocation;
  const { writeToClipboard } = loadClipboardUtil((...args) => { invocation = args; return child; });
  const promise = writeToClipboard('π\nclipboard payload');
  assert.deepEqual(invocation, [expectedInvocation().command, expectedInvocation().args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }]);
  assert.deepEqual(child.stdin.endCalls, [['π\nclipboard payload', 'utf8']]);
  child.emit('close', 0);
  await promise;
  assert.equal(timers.activeCount, 0);
}

async function testFailureCleansUpLiveChildAndWatchdog(timers) {
  const child = fakeChild();
  const { writeToClipboard } = loadClipboardUtil(() => child);
  const settlements = [];
  const promise = writeToClipboard('fault injection').then(
    () => settlements.push('resolve'),
    (error) => { settlements.push(`reject:${error.message}`); throw error; },
  );
  const stdinError = new Error('stdin broke');
  child.stdin.emit('error', stdinError);
  await assert.rejects(promise, (error) => error === stdinError);
  assert.equal(child.killCalls, 1, 'stdin failure must request termination of the still-live clipboard child promptly');
  assert.equal(timers.clearCount, 1, 'stdin failure must cancel the watchdog timer');
  assert.equal(timers.activeCount, 0, 'stdin failure must leave no active watchdog');

  // Late failures and close events must not cause a second settlement or termination request.
  assert.doesNotThrow(() => child.stdin.emit('error', new Error('late stdin broke')));
  assert.doesNotThrow(() => child.emit('error', new Error('late process broke')));
  child.emit('close', 0);
  await Promise.resolve();
  assert.deepEqual(settlements, ['reject:stdin broke']);
  assert.equal(child.killCalls, 1);
}

async function testSynchronousEndFailureCleansUp(timers) {
  const endError = new Error('stdin.end threw');
  const child = fakeChild({ endError });
  const { writeToClipboard } = loadClipboardUtil(() => child);
  const promise = writeToClipboard('synchronous end failure');
  await assert.rejects(promise, (error) => error === endError);
  assert.equal(child.killCalls, 1, 'stdin.end failure must request termination of the child');
  assert.equal(timers.clearCount, 1, 'stdin.end failure must cancel the watchdog timer');
  assert.equal(timers.activeCount, 0);
  assert.doesNotThrow(() => child.stdin.emit('error', new Error('late stdin error')));
  assert.doesNotThrow(() => child.emit('error', new Error('late process error')));
  child.emit('close', 0);
  assert.equal(child.killCalls, 1);
}

async function testProcessErrorAndNonzeroExit(timers) {
  {
    const child = fakeChild();
    const { writeToClipboard } = loadClipboardUtil(() => child);
    const promise = writeToClipboard('spawn error');
    const error = new Error('spawn failed');
    child.emit('error', error);
    await assert.rejects(promise, (actual) => actual === error);
    assert.equal(child.killCalls, 0);
    assert.equal(timers.clearCount, 1);
    child.emit('close', 1);
  }
  {
    const child = fakeChild();
    const { writeToClipboard } = loadClipboardUtil(() => child);
    const promise = writeToClipboard('nonzero');
    child.emit('close', 7);
    await assert.rejects(promise, /Clipboard process exited 7/);
    assert.equal(child.killCalls, 0);
    assert.equal(timers.clearCount, 2);
  }
}

async function testTimeoutRemainsBoundedAndTruthful(timers) {
  const child = fakeChild({ killImpl: (proc) => proc.emit('close', 0) });
  const { writeToClipboard } = loadClipboardUtil(() => child);
  const settlements = [];
  const promise = writeToClipboard('timeout').then(
    () => settlements.push('resolve'),
    (error) => { settlements.push(`reject:${error.message}`); throw error; },
  );
  const timerId = timers.onlyId();
  assert.equal(timers.activeCount, 1);
  timers.fire(timerId);
  await assert.rejects(promise, /Clipboard write timed out/);
  assert.equal(child.killCalls, 1, 'timeout must request termination exactly once');
  assert.equal(timers.activeCount, 0);
  assert.deepEqual(settlements, ['reject:Clipboard write timed out']);
}

// The helper reads these globals at call time. Replace them only for this isolated module test.
async function main() {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  // Each test gets a fresh timer object; loading/using one helper per test prevents state leakage.
  for (const test of [testSuccessAndInvocation, testFailureCleansUpLiveChildAndWatchdog, testSynchronousEndFailureCleansUp, testProcessErrorAndNonzeroExit, testTimeoutRemainsBoundedAndTruthful]) {
    const timers = fakeTimers();
    global.setTimeout = timers.setTimeout;
    global.clearTimeout = timers.clearTimeout;
    try {
      await test(timers);
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  }
  console.log('clipboard utility reliability tests passed');
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
