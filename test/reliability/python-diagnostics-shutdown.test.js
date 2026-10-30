#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { inventoryProcesses } = require('../../scripts/process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '../..');
const REPORT_DIR = path.resolve(process.env.GDS_DIAGNOSTICS_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'python-diagnostics-shutdown'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeChild() {
    const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.pid = undefined; proc.killCount = 0; proc.closed = false;
    proc.kill = () => { proc.killCount++; if (!proc.closed) { proc.closed = true; queueMicrotask(() => { proc.emit('close', null); setImmediate(() => proc.stdout.emit('data', Buffer.from('late output\n'))); }); } };
    proc.close = (code = 0) => { if (!proc.closed) { proc.closed = true; proc.emit('close', code); } };
    return proc;
}

async function waitForFile(file, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (fs.existsSync(file)) return; await sleep(20); }
    throw new Error(`Timed out waiting for ${file}`);
}

async function recordOwned(temp, owned) {
    const rows = await inventoryProcesses();
    for (const row of rows.filter(candidate => candidate.command.includes(temp))) {
        assert(row.start, `cannot verify birth identity for owned process ${row.pid}`);
        owned.set(`${row.pid}:${row.start}`, row);
    }
}

async function survivingOwned(owned, pids) {
    const rows = await inventoryProcesses();
    return pids.filter(pid => {
        const current = rows.find(row => row.pid === pid); if (!current) return false;
        assert([...owned.values()].some(row => row.pid === pid && row.start === current.start), `PID identity changed for owned process ${pid}`);
        return true;
    });
}

async function forceOwned(owned) {
    const rows = await inventoryProcesses();
    for (const identity of owned.values()) {
        const current = rows.find(row => row.pid === identity.pid && row.start === identity.start); if (!current) continue;
        assert.notEqual(current.pid, process.pid);
        try { process.kill(current.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
}

function writeFixture(dir, ready, gate, parentPid, helperPid, mode) {
    const helper = path.join(dir, `${mode}-helper.py`);
    fs.writeFileSync(helper, `import os, signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen(${JSON.stringify(helperPid)}, 'w').write(str(os.getpid()))\nwhile True: time.sleep(1)\n`);
    const fixture = path.join(dir, `${mode}-parent.py`);
    fs.writeFileSync(fixture, `import os, signal, subprocess, sys, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen(${JSON.stringify(parentPid)}, 'w').write(str(os.getpid()))\nsubprocess.Popen([sys.executable, ${JSON.stringify(helper)}])\nopen(${JSON.stringify(ready)}, 'w').write('ready')\nwhile not os.path.exists(${JSON.stringify(gate)}): time.sleep(0.01)\nif ${JSON.stringify(mode)} == 'overflow': print('x' * (300 * 1024), flush=True)\nwhile True: time.sleep(1)\n`);
    return fixture;
}

async function assertOwnedGone(owned, pids) {
    const survivors = await survivingOwned(owned, pids);
    assert.equal(survivors.length, 0, `owned processes remained at settlement: ${survivors.join(', ')}`);
}

async function main() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-diagnostics-')));
    const bundle = path.join(temp, 'env.cjs');
    const owned = new Map(); const report = { platform: process.platform, cases: [] };
    let originalLoad; let originalSpawn;
    try {
        await esbuild.build({ entryPoints: [path.join(ROOT, 'src', 'envProvider.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle });
        originalLoad = Module._load; Module._load = function (request, ...args) { return request === 'vscode' ? {} : originalLoad.call(this, request, ...args); };
        const childProcess = require('child_process'); originalSpawn = childProcess.spawn;
        let mode = 'normal'; let spawnCount = 0; let last;
        childProcess.spawn = (file, args, options) => {
            if (file !== 'diagnostics-test-executable') return originalSpawn(file, args, options);
            spawnCount++; last = fakeChild();
            if (mode === 'normal') queueMicrotask(() => { last.stdout.emit('data', Buffer.from('warning\nGDS_NAV_DIAGNOSTICS={"executable":"fake","pythonVersion":"test"}\n')); last.close(0); });
            if (mode === 'invalid') queueMicrotask(() => { last.stdout.emit('data', Buffer.from('noise\n')); last.close(0); });
            if (mode === 'missing') queueMicrotask(() => last.close(127));
            if (mode === 'overflow') queueMicrotask(() => { last.stdout.emit('data', Buffer.from('x'.repeat(256 * 1024 + 1))); setImmediate(() => last.close(null)); });
            return last;
        };
        const { inspectPython } = require(bundle);
        let result;

        if (process.platform !== 'win32') {
            const python = path.resolve(process.env.GDS_TEST_PYTHON || process.env.GDS_PYTHON || path.join(ROOT, '.venv-fork', 'bin', 'python'));
            assert(fs.existsSync(python), `Python interpreter is required: ${python}`);
            for (const realMode of ['timeout', 'cancel', 'overflow']) {
                const dir = path.join(temp, realMode); fs.mkdirSync(dir); const ready = path.join(dir, 'ready'); const gate = path.join(dir, 'gate'); const parent = path.join(dir, 'parent.pid'); const helper = path.join(dir, 'helper.pid');
                const fixture = writeFixture(dir, ready, gate, parent, helper, realMode);
                const realSpawn = childProcess.spawn;
                childProcess.spawn = (file, args, options) => file === 'diagnostics-real-executable' ? realSpawn(python, [fixture], options) : realSpawn(file, args, options);
                try {
                    const ctl = new AbortController(); const promise = inspectPython('diagnostics-real-executable', realMode === 'timeout' ? 600 : 5000, ctl.signal); await waitForFile(ready); await waitForFile(helper); const pids = [Number(fs.readFileSync(parent)), Number(fs.readFileSync(helper))]; await recordOwned(temp, owned); fs.writeFileSync(gate, 'go'); if (realMode === 'cancel') ctl.abort();
                    result = await promise; assert.match(result.error, realMode === 'cancel' ? /cancelled/ : realMode === 'overflow' ? /output limit exceeded/ : /timed out/); await assertOwnedGone(owned, pids);
                    report.cases.push({ name: `real-${realMode}-parent-helper`, status: 'passed', pids, error: result.error });
                } finally { childProcess.spawn = realSpawn; }
            }
        }

        result = await inspectPython('diagnostics-test-executable'); assert.equal(result.executable, 'fake'); report.cases.push({ name: 'tagged-json-and-warning', status: 'passed' });
        mode = 'invalid'; result = await inspectPython('diagnostics-test-executable'); assert.match(result.error, /Invalid diagnostics JSON/); report.cases.push({ name: 'invalid-record', status: 'passed' });
        mode = 'missing'; result = await inspectPython('diagnostics-test-executable'); assert.match(result.error, /exited with code 127/); report.cases.push({ name: 'nonzero-exit', status: 'passed' });
        mode = 'overflow'; result = await inspectPython('diagnostics-test-executable'); assert.match(result.error, /output limit exceeded/); report.cases.push({ name: 'output-limit', status: 'passed' });
        mode = 'hold'; const controller = new AbortController(); let settled = false; const pending = inspectPython('diagnostics-test-executable', 1000, controller.signal); pending.then(() => { settled = true; }); controller.abort(); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); last.stdout.emit('data', Buffer.from('GDS_NAV_DIAGNOSTICS={"executable":"late","pythonVersion":"late"}\n')); last.close(0); result = await pending; assert.equal(result.error, 'Python diagnostics cancelled'); report.cases.push({ name: 'mock-cancellation-late-output', status: 'passed' });
        const pre = new AbortController(); pre.abort(); const before = spawnCount; result = await inspectPython('diagnostics-test-executable', 1000, pre.signal); assert.equal(result.error, 'Python diagnostics cancelled'); assert.equal(spawnCount, before); report.cases.push({ name: 'preabort-no-spawn', status: 'passed' });
        mode = 'hold'; result = await inspectPython('diagnostics-test-executable', 10);
        assert.match(result.error, /timed out/); assert.match(result.shutdownError, /Could not confirm Python process exit/);
        last.close(0); report.cases.push({ name: 'unverified-shutdown-is-explicit', status: 'passed' });

        report.status = 'passed';
        console.log(JSON.stringify({ status: 'passed', scenarios: report.cases.length }));
    } catch (error) {
        report.status = 'failed'; report.error = String(error?.stack || error); throw error;
    } finally {
        if (originalSpawn) require('child_process').spawn = originalSpawn; if (originalLoad) Module._load = originalLoad;
        await recordOwned(temp, owned); const pids = [...owned.values()].map(row => row.pid); await forceOwned(owned); const deadline = Date.now() + 2500; let survivors;
        do { survivors = await survivingOwned(owned, pids); if (!survivors.length) break; await sleep(30); } while (Date.now() < deadline);
        report.cleanup = { verified: !survivors?.length, pids, survivors: survivors || [] }; report.tempDir = temp;
        fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');
        assert.equal(survivors.length, 0, 'test-owned diagnostics processes survived cleanup');
        if (!survivors?.length && report.status === 'passed') fs.rmSync(temp, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
