'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const esbuild = require('esbuild');

function loadProcessModule(platform, childProcess) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/pythonProcess.ts'), 'utf8');
  const code = esbuild.transformSync(source, { loader: 'ts', format: 'cjs', platform: 'node' }).code;
  const module = { exports: {} };
  const processMock = {
    platform,
    kill: (...args) => processMock.killCalls.push(args),
    killCalls: [],
  };
  vm.runInNewContext(`(function (require, module, exports) { ${code}\n})(require, module, module.exports);`, {
    require: (name) => name === 'child_process' ? childProcess : require(name),
    module,
    process: processMock,
    exports: module.exports,
    console,
    setTimeout,
    clearTimeout,
    Date,
  });
  return { api: module.exports, processMock };
}

class MockProc extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.closed = false;
    this.on('error', () => {});
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', 0, null);
  }
}

function childStub(proc, execFileImpl = () => {}) {
  const child = { spawnCalls: [], execFile: execFileImpl };
  child.spawn = (path, args, options) => {
      child.spawnCalls.push({ path, args, options });
      return proc;
    };
  return {
    ...child,
  };
}

async function testPosixTerminationAndOwnership() {
  const proc = new MockProc(41);
  let groupPresent = true;
  const child = childStub(proc);
  const { api, processMock } = loadProcessModule('darwin', child);
  processMock.kill = (pid, signal) => {
    processMock.killCalls.push([pid, signal]);
    if (signal === 0) {
      if (!groupPresent) { const error = new Error('gone'); error.code = 'ESRCH'; throw error; }
      return true;
    }
    if (signal === 'SIGKILL') groupPresent = false;
  };
  const { proc: spawned, terminate } = api.spawnPythonProcess('python', ['script.py']);
  assert.equal(child.spawnCalls[0].options.detached, true);
  const first = terminate();
  assert.strictEqual(first, terminate(), 'stop must be memoized');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(processMock.killCalls[0], [-41, 'SIGTERM']);
  assert(processMock.killCalls.every(([pid]) => pid === -41 || pid === undefined), 'must never signal host process group');
  spawned.close();
  groupPresent = false;
  await first;
  assert.equal(processMock.killCalls.filter(([, signal]) => signal !== 0).length, 1, 'normal close needs one termination signal');
}

async function testPosixEscalationAndFailure() {
  const proc = new MockProc(42);
  let groupPresent = true;
  const child = childStub(proc);
  const { api, processMock } = loadProcessModule('linux', child);
  processMock.kill = (pid, signal) => {
    processMock.killCalls.push([pid, signal]);
    if (signal === 0) {
      if (!groupPresent) { const error = new Error('gone'); error.code = 'ESRCH'; throw error; }
      return true;
    }
    if (signal === 'SIGKILL') groupPresent = false;
  };
  const { terminate } = api.spawnPythonProcess('python', []);
  const stopping = terminate();
  // TERM is ignored; the helper must escalate and wait for group disappearance.
  await new Promise((resolve) => setTimeout(resolve, 10));
  proc.close();
  let settled = false;
  stopping.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, 'stop must not resolve while the owned group remains alive');
  await stopping;
  assert.deepEqual(processMock.killCalls.filter(([, signal]) => signal !== 0).map(([, signal]) => signal), ['SIGTERM', 'SIGKILL']);

  const failedProc = new MockProc(43);
  const failedChild = childStub(failedProc);
  const loaded = loadProcessModule('linux', failedChild);
  loaded.processMock.kill = (pid, signal) => {
    loaded.processMock.killCalls.push([pid, signal]);
    if (signal === 0) return true;
    const error = new Error('permission denied'); error.code = 'EPERM'; throw error;
  };
  await assert.rejects(() => loaded.api.spawnPythonProcess('python', []).terminate(), /permission denied/);

  const survivorProc = new MockProc(44);
  let survivorGroup = true;
  const survivorChild = childStub(survivorProc);
  const survivorLoaded = loadProcessModule('linux', survivorChild);
  survivorLoaded.processMock.kill = (pid, signal) => {
    survivorLoaded.processMock.killCalls.push([pid, signal]);
    if (signal === 0 && !survivorGroup) { const error = new Error('gone'); error.code = 'ESRCH'; throw error; }
    // The owned group ignores both signals and remains observable.
    return true;
  };
  await assert.rejects(() => survivorLoaded.api.spawnPythonProcess('python', []).terminate(), /after SIGKILL/);
}

async function testWindowsTaskkillAndMissingPid() {
  const proc = new MockProc(51);
  let call;
  const child = childStub(proc, (name, args, options, callback) => { call = { name, args, options }; callback(null); });
  const { api } = loadProcessModule('win32', child);
  const { terminate } = api.spawnPythonProcess('python.exe', []);
  const stopping = terminate();
  assert.equal(call.name, 'taskkill');
  assert.equal(JSON.stringify(call.args), JSON.stringify(['/PID', '51', '/T', '/F']));
  assert.equal(call.options.timeout, 2000);
  proc.close();
  await stopping;

  const errorProc = new MockProc(52);
  const errorChild = childStub(errorProc, (name, args, options, callback) => {
    const error = new Error('taskkill timed out'); error.code = 'ETIMEDOUT'; callback(error);
  });
  const errorApi = loadProcessModule('win32', errorChild).api;
  await assert.rejects(() => errorApi.spawnPythonProcess('python.exe', []).terminate(), /taskkill timed out/);

  const noCloseProc = new MockProc(53);
  const noCloseChild = childStub(noCloseProc, (name, args, options, callback) => callback(null));
  const noCloseApi = loadProcessModule('win32', noCloseChild).api;
  await assert.rejects(() => noCloseApi.spawnPythonProcess('python.exe', []).terminate(), /confirm Python process tree exit/);

  const missing = new MockProc(undefined);
  const missingApi = loadProcessModule('win32', childStub(missing)).api;
  const missingStop = missingApi.spawnPythonProcess('python.exe', []).terminate();
  missing.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  missing.close();
  await missingStop;

  const missingNoClose = new MockProc(undefined);
  const missingNoCloseApi = loadProcessModule('win32', childStub(missingNoClose)).api;
  await assert.rejects(() => missingNoCloseApi.spawnPythonProcess('python.exe', []).terminate(), /confirm Python process exit/);
}

(async () => {
  await testPosixTerminationAndOwnership();
  await testPosixEscalationAndFailure();
  await testWindowsTaskkillAndMissingPid();
  console.log('python process contract tests passed');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
