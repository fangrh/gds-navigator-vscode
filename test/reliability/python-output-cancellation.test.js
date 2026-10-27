'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const esbuild = require('esbuild');

class MockProc extends EventEmitter {
  constructor() {
    super();
    this.pid = undefined;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.closed = false;
    this.killCalls = 0;
  }
  kill() { this.killCalls += 1; }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', 0, null);
  }
}

function bundleRunner(directory) {
  const outfile = path.join(directory, 'pythonRunner.cjs');
  const root = path.resolve(__dirname, '../..');
  const options = { bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile };
  esbuild.buildSync({ ...options, entryPoints: [path.join(root, 'src/pythonRunner.ts')] });
  return outfile;
}

async function bounded(promise, label, timeoutMs = 2000) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gds-output-cancel-'));
  const cwd = path.join(temp, 'workspace');
  await fs.promises.mkdir(cwd);
  await fs.promises.writeFile(path.join(cwd, 'build.py'), '# build fixture\n');
  const proc = new MockProc();
  let spawnedResolve;
  const spawned = new Promise((resolve) => { spawnedResolve = resolve; });
  const childProcess = { spawn: () => { spawnedResolve(); return proc; } };
  const originalLoad = Module._load;
  const originalReadFile = fs.promises.readFile;
  let inspectionResolve;
  let releaseInspection;
  const inspectionGate = new Promise((resolve) => { releaseInspection = resolve; });
  const inspectionStarted = new Promise((resolve) => { inspectionResolve = resolve; });
  fs.promises.readFile = async function (file, ...args) {
    if (String(file).endsWith(`${path.sep}writes.jsonl`)) {
      inspectionResolve();
      await inspectionGate;
    }
    return originalReadFile.call(this, file, ...args);
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return { window: { showErrorMessage() {} } };
    if (request === 'child_process') return childProcess;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { runPythonScript } = require(bundleRunner(temp));
    const controller = new AbortController();
    const output = { show() {}, appendLine() {} };
    const resultPromise = runPythonScript('python', path.join(cwd, 'build.py'), cwd, output, { signal: controller.signal, timeoutMs: 5000 });
    let settled = false;
    resultPromise.then(() => { settled = true; });
    // Snapshot and spawn complete before close; the output inspection is then held open.
    await bounded(spawned, 'spawn');
    // The uncancelled path must have a real changed output to publish.
    await fs.promises.writeFile(path.join(cwd, 'one.gds'), 'gds output\n');
    proc.close();
    await bounded(inspectionStarted, 'output inspection');
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'cancellation waits for the pending audit read to drain');
    releaseInspection();
    const result = await resultPromise;
    assert.equal(result.ok, false);
    assert.match(result.reason, /cancelled/);
    assert.equal(result.candidates, undefined, 'late cancellation must not publish output candidates');
  } finally {
    releaseInspection();
    Module._load = originalLoad;
    fs.promises.readFile = originalReadFile;
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
  console.log('python output cancellation contract passed');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
