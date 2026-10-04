'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { closeOwnedProcess, closeOwnedBrowser } = require('../../scripts/process-cleanup.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testRealEscalationAndSentinel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-'));
  const profile = path.join(dir, 'profile');
  const sentinel = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const childCode = 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)';
  const parentCode = 'process.on("SIGTERM",()=>{}); require("node:child_process").spawn(process.execPath,["-e",process.argv[1]],{stdio:"ignore"}); setInterval(()=>{},1000)';
  const child = cp.spawn(process.execPath, ['-e', parentCode, childCode, `--user-data-dir=${profile}`], { stdio: 'ignore' });
  try {
    await sleep(120);
    const result = await closeOwnedProcess(child, { profileDir: profile, graceMs: 20, termMs: 30, killMs: 100 });
    assert.equal(result.verified, true);
    assert.equal(result.escalated, true);
    assert.equal(sentinel.exitCode, null, 'unrelated sentinel must survive');
  } finally {
    if (sentinel.exitCode === null) sentinel.kill('SIGKILL');
    await sleep(30);
  }
}

async function testInjectedCases() {
  const profile = path.join(os.tmpdir(), 'injected-profile');
  const child = { pid: 10, exitCode: null, signalCode: null, once() {} };
  const rows = [
    { pid: 10, ppid: 1, start: 'a', command: `runner --user-data-dir=${profile}` },
    { pid: 11, ppid: 10, start: 'b', command: 'helper' },
  ];
  let live = rows.slice();
  const signals = [];
  const inventory = async () => live.slice();
  const signal = async (row, sig) => { signals.push([row.pid, row.start, sig]); live = live.filter((x) => !(x.pid === row.pid && x.start === row.start)); };
  const result = await closeOwnedProcess(child, { profileDir: profile, inventory, signal, graceMs: 0, termMs: 0, killMs: 10 });
  assert.equal(result.verified, true);
  assert.deepEqual(signals.map((x) => x[2]), ['SIGTERM', 'SIGTERM']);

  let lateScan = 0;
  let lateRows = [{ pid: 20, ppid: 1, start: 'root', command: `runner --user-data-dir=${profile}` }];
  const lateSignals = [];
  const lateResult = await closeOwnedProcess({ pid: 20, exitCode: null, signalCode: null }, {
    profileDir: profile,
    inventory: async () => {
      lateScan += 1;
      if (lateScan === 2) lateRows = [...lateRows, { pid: 21, ppid: 20, start: 'late', command: 'helper' }];
      return lateRows.slice();
    },
    signal: async (row) => { lateSignals.push(row.pid); lateRows = lateRows.filter((x) => x.pid !== row.pid); },
    graceMs: 0, termMs: 0, killMs: 10,
  });
  assert.equal(lateResult.verified, true);
  assert.deepEqual(lateSignals.sort(), [20, 21]);

  const alreadyExited = { pid: 99, exitCode: 0, signalCode: null };
  const gone = await closeOwnedProcess(alreadyExited, { profileDir: profile, inventory: async () => [] });
  assert.equal(gone.verified, true);
  // Do not traverse an unrelated process that has reused the exited root PID.
  const reusedExited = await closeOwnedProcess(alreadyExited, { profileDir: profile, inventory: async () => [
    { pid: 99, ppid: 1, start: 'new-owner', command: 'unrelated' },
    { pid: 100, ppid: 99, start: 'new-child', command: 'unrelated helper' },
  ], signal: async () => { throw Error('must not signal a reused root or its children'); } });
  assert.equal(reusedExited.verified, true);
  let orphan = [{ pid: 88, ppid: 1, start: 'orphan', command: `helper --user-data-dir=${profile}` }];
  const orphanResult = await closeOwnedProcess(alreadyExited, { profileDir: profile, inventory: async () => orphan.slice(), signal: async () => { orphan = []; }, graceMs: 0, termMs: 0, killMs: 10 });
  assert.equal(orphanResult.alreadyExited, true);

  await assert.rejects(() => closeOwnedProcess({ pid: 10, exitCode: null, signalCode: null }, { profileDir: profile, inventory: async () => { throw new Error('broken'); } }), /cannot verify process inventory/);

  // A recycled PID with a different start identity is never signaled.
  let scan = 0;
  await assert.rejects(() => closeOwnedProcess({ pid: 10, exitCode: null, signalCode: null }, {
    profileDir: profile,
    inventory: async () => scan++ === 0
      ? [{ pid: 10, ppid: 1, start: 'old', command: `runner --user-data-dir=${profile}` }]
      : [{ pid: 10, ppid: 1, start: 'new', command: `runner --user-data-dir=${profile}` }],
    signal: async () => { throw new Error('must not signal recycled pid'); },
    graceMs: 0, termMs: 0, killMs: 0,
  }), /PID reuse/);

  let disconnected = false;
  const browserResult = await closeOwnedBrowser({ process: () => null, disconnect: () => { disconnected = true; } }, { profileDir: profile });
  assert.equal(disconnected, true);
  assert.equal(browserResult.disconnected, true);

  let browserClosed = false;
  const browserProcess = { pid: 70, exitCode: null, signalCode: null, spawnargs: ['browser', '--user-data-dir', profile] };
  let browserRows = [{ pid: 70, ppid: 1, start: 'browser', command: `browser --user-data-dir '${profile}'` }];
  const ownedBrowser = { process: () => browserProcess, close: async () => { browserClosed = true; throw new Error('graceful browser close failed'); } };
  const browserCleanup = await closeOwnedBrowser(ownedBrowser, { inventory: async () => browserRows.slice(), signal: async () => { browserRows = []; }, graceMs: 0, termMs: 0, killMs: 10 });
  assert.equal(browserClosed, true);
  assert.equal(browserCleanup.verified, true);

  await assert.rejects(() => closeOwnedProcess({ pid: 12, exitCode: null, signalCode: null }, {
    profileDir: profile,
    inventory: async () => [{ pid: 12, ppid: 1, start: '', command: `runner --user-data-dir=${profile}` }],
  }), /birth\/start identity/);
}

(async () => {
  await testInjectedCases();
  await testRealEscalationAndSentinel();
  console.log('process cleanup tests passed');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
