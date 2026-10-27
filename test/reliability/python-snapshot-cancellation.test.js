#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { Readable, addAbortSignal } = require('node:stream');

const ROOT = path.resolve(__dirname, '../..');

class HeldHashStream extends Readable {
  constructor(file) {
    super();
    this.file = file;
    this.destroyStarted = false;
    this.destroyFinished = false;
    this.releaseDestroy = undefined;
    this.destroyGate = new Promise(resolve => { this.releaseDestroy = resolve; });
  }
  _read() {}
  _destroy(error, callback) {
    this.destroyStarted = true;
    this.destroyGate.then(() => {
      this.destroyFinished = true;
      callback(error);
    });
  }
  release() {
    if (this.releaseDestroy) this.releaseDestroy();
  }
}

class MockProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = undefined;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.closed = false;
  }
  close(code = 0) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, null);
  }
}

function bounded(promise, label, timeoutMs = 1500) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function until(predicate, label) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} was not observed`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function run() {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-snapshot-cancel-')));
  const bundle = path.join(temp, 'pythonRunner.cjs');
  const cwd = path.join(temp, 'workspace');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'build.py'), '# simulated build\n');
  fs.writeFileSync(path.join(cwd, 'existing.gds'), 'existing fixture\n');
  for (let index = 0; index < 8; index += 1) fs.writeFileSync(path.join(cwd, `fixture-${index}.gds`), `fixture ${index}\n`);
  const originalLoad = Module._load;
  const originalCreateReadStream = fs.createReadStream;
  const processes = [];
  const held = [];
  const runPromises = [];
  const signalAbortedAtCreation = [];
  let mode = 'held';
  let spawnCount = 0;
  let inspectionStarted;
  let inspectionResolve;
  const resetInspection = () => {
    inspectionStarted = new Promise(resolve => { inspectionResolve = resolve; });
  };
  resetInspection();

  try {
    require('esbuild').buildSync({
      entryPoints: [path.join(ROOT, 'src', 'pythonRunner.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['vscode'],
      outfile: bundle,
    });

    Module._load = function load(request, parent, isMain) {
      if (request === 'vscode') return { window: { showErrorMessage() {} } };
      if (request === 'child_process') {
        return {
          spawn() {
            spawnCount += 1;
            const proc = new MockProcess();
            processes.push(proc);
            return proc;
          },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    const { runPythonScript } = require(bundle);
    Module._load = originalLoad;

    fs.createReadStream = function createReadStream(file, ...args) {
      if (mode !== 'held') return originalCreateReadStream.call(this, file, ...args);
      const options = args[0] && typeof args[0] === 'object' ? args[0] : undefined;
      signalAbortedAtCreation.push(Boolean(options?.signal?.aborted));
      const stream = new HeldHashStream(String(file));
      held.push(stream);
      inspectionResolve();
      return options?.signal ? addAbortSignal(options.signal, stream) : stream;
    };

    const output = { show() {}, appendLine() {} };
    const releaseHeld = () => {
      for (const stream of held) stream.release();
    };

    // Aborting during the initial snapshot must destroy every active hash
    // stream, avoid Python spawn, and settle only after the streams close.
    resetInspection();
    const preController = new AbortController();
    const prePromise = runPythonScript('simulated-python', path.join(cwd, 'build.py'), cwd, output, { signal: preController.signal, timeoutMs: 5000 });
    runPromises.push(prePromise);
    await bounded(inspectionStarted, 'initial snapshot');
    preController.abort();
    await until(() => held.some(stream => stream.destroyStarted), 'pre-scan stream destruction');
    let preSettled = false;
    prePromise.finally(() => { preSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(preSettled, false, 'pre-scan cancellation waits for the gated stream close');
    releaseHeld();
    const preResult = await bounded(prePromise, 'pre-scan cancellation');
    assert.equal(preResult.ok, false);
    assert.match(preResult.reason, /cancelled/);
    assert.equal(preResult.candidates, undefined);
    assert.equal(spawnCount, 0, 'pre-scan cancellation must not spawn Python');
    assert(held.every(stream => stream.closed), 'pre-scan cancellation must close all hash streams');
    assert(signalAbortedAtCreation.every(aborted => !aborted), 'pre-scan must not create a stream with an already-aborted signal');

    // A normal build still publishes the one changed output.
    mode = 'real';
    const normalPromise = runPythonScript('simulated-python', path.join(cwd, 'build.py'), cwd, output, { timeoutMs: 5000 });
    runPromises.push(normalPromise);
    await until(() => processes.length === 1, 'normal Python spawn');
    fs.writeFileSync(path.join(cwd, 'normal.gds'), 'normal output\n');
    processes[0].close(0);
    const normalResult = await bounded(normalPromise, 'ordinary build');
    assert.equal(normalResult.ok, true);
    assert.equal(normalResult.gdsPath, path.join(cwd, 'normal.gds'));

    async function cancellationAfterExit(kind) {
      mode = 'held';
      held.length = 0;
      resetInspection();
      const controller = new AbortController();
      const beforeSpawn = spawnCount;
      const options = kind === 'timeout' ? { timeoutMs: 250 } : { timeoutMs: 5000, signal: controller.signal };
      // Let the initial snapshot use real streams so spawn is reached; hold
      // only the post-exit output inspection streams.
      mode = 'real';
      const promise = runPythonScript('simulated-python', path.join(cwd, 'build.py'), cwd, output, options);
      runPromises.push(promise);
      await until(() => spawnCount === beforeSpawn + 1, `${kind} Python spawn`);
      mode = 'held';
      resetInspection();
      const proc = processes.at(-1);
      proc.close(0);
      await bounded(inspectionStarted, `${kind} output inspection`);
      if (kind === 'cancel') controller.abort();
      await until(() => held.some(stream => stream.destroyStarted), `${kind} stream destruction`);
      const scheduledAtCancellation = held.length;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(held.length, scheduledAtCancellation, `${kind} must not queue extra hash streams after cancellation`);
      let settledBeforeRelease = false;
      promise.finally(() => { settledBeforeRelease = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settledBeforeRelease, false, `${kind} waits for the gated stream close before settling`);
      releaseHeld();
      const result = await bounded(promise, `${kind} cancellation`);
      assert.equal(result.ok, false);
      assert.match(result.reason, kind === 'timeout' ? /timed out/ : /cancelled/);
      assert(held.every(stream => stream.closed), `${kind} must close all hash streams`);
      assert(signalAbortedAtCreation.every(aborted => !aborted), `${kind} must not create a stream with an already-aborted signal`);
    }

    await cancellationAfterExit('cancel');
    await cancellationAfterExit('timeout');
    return { status: 'passed', cases: ['pre-scan abort', 'ordinary output', 'post-exit abort', 'post-exit timeout'] };
  } finally {
    mode = 'real';
    for (const proc of processes) proc.close(0);
    for (const stream of held) {
      if (!stream.destroyed) stream.destroy();
      stream.release();
    }
    await Promise.all(held.map(stream => bounded(new Promise(resolve => {
      if (stream.closed) resolve();
      else stream.once('close', resolve);
    }), 'hash stream close')));
    await Promise.all(runPromises.map(promise => bounded(promise, 'run promise drain')));
    Module._load = originalLoad;
    fs.createReadStream = originalCreateReadStream;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run().then(report => console.log(JSON.stringify(report))).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
