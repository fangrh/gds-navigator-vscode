'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { inventoryProcesses } = require('../../scripts/process-cleanup.cjs');
const ROOT = path.resolve(__dirname, '../..');
const REPORT = path.resolve(process.env.GDS_PROVIDER_PROCESS_REPORT_DIR || path.join(ROOT, 'logs/reliability/build-provider-shutdown-process'));
const PYTHON = path.resolve(process.env.GDS_TEST_PYTHON || process.env.GDS_PYTHON || path.join(ROOT, '.venv-fork', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test) {
  const deadline = Date.now() + 15000;
  while (!test()) { if (Date.now() > deadline) throw new Error('private process fixture did not become ready'); await sleep(20); }
}
function stop(provider) { if (provider.shutdown) return provider.shutdown(); provider.dispose(); return provider.shutdownUsage(); }
(async () => {
  fs.mkdirSync(REPORT, { recursive: true }); assert(fs.existsSync(PYTHON));
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-provider-process-')));
  const bundle = path.join(temp, 'provider.cjs');
  const owned = new Map(), providers = [], runs = [], opened = [], warnings = [];
  const report = { platform: process.platform, cases: [] }; let failure;
  const originalLoad = Module._load;
  async function recordOwned() {
    for (const row of (await inventoryProcesses()).filter(row => row.command.includes(temp))) {
      assert(row.start); assert.notEqual(row.pid, process.pid); owned.set(`${row.pid}:${row.start}`, row);
    }
  }
  async function survivors() {
    const rows = await inventoryProcesses();
    return [...owned.values()].filter(wanted => rows.some(row => row.pid === wanted.pid && row.start === wanted.start));
  }
  try {
    await require('esbuild').build({ entryPoints: [path.join(ROOT, 'src/gdsEditor.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle });
    const uri = fsPath => ({ fsPath });
    const vscode = {
      window: { createTextEditorDecorationType: () => ({}), showErrorMessage() {}, showInformationMessage() {}, showWarningMessage: value => warnings.push(value),
        withProgress: (_options, task) => task({}, { onCancellationRequested: () => ({ dispose() {} }) }) },
      workspace: { workspaceFolders: [{ uri: uri(temp) }], getWorkspaceFolder: () => ({ uri: uri(temp) }), getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
      commands: { executeCommand: async (command, value) => opened.push({ command, file: value?.fsPath }) },
      Uri: { file: uri }, ProgressLocation: { Notification: 15 }, OverviewRulerLane: { Right: 4 },
    };
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    const { GdsEditorProvider } = require(bundle);
    function provider() {
      const instance = new GdsEditorProvider({ extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(temp, 'storage') }, workspaceState: { get() {}, update: async () => {} } },
        { ready: async () => {}, getPython: () => PYTHON }, { appendLine() {}, show() {} });
      providers.push(instance); return instance;
    }
    const normal = provider(), normalScript = path.join(temp, 'normal.py'), output = path.join(temp, 'normal.gds');
    fs.writeFileSync(normalScript, "open('normal.gds','w').write('unchanged output bytes')\n");
    const normalRun = normal.runScriptFor(normalScript); runs.push(normalRun); await normalRun;
    assert.equal(fs.readFileSync(output, 'utf8'), 'unchanged output bytes');
    assert.equal(normal.getAssociatedScript(output), normalScript);
    assert.deepEqual(opened, [{ command: 'vscode.openWith', file: output }]); await stop(normal);
    report.cases.push({ name: 'normal-output-and-association', status: 'passed' });
    opened.length = 0; warnings.length = 0;
    const parentPid = path.join(temp, 'parent.pid'), helperPid = path.join(temp, 'helper.pid');
    const helper = path.join(temp, 'helper.py'), script = path.join(temp, 'stubborn.py');
    fs.writeFileSync(helper, `import os,signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(helperPid)},'w').write(str(os.getpid()))\nwhile True: time.sleep(1)\n`);
    fs.writeFileSync(script, `import os,signal,subprocess,sys,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(parentPid)},'w').write(str(os.getpid()))\nsubprocess.Popen([sys.executable,${JSON.stringify(helper)}])\nwhile True: time.sleep(1)\n`);
    const active = provider(); const run = active.runScriptFor(script); runs.push(run);
    await waitFor(() => fs.existsSync(parentPid) && fs.existsSync(helperPid)); await recordOwned();
    const pids = [Number(fs.readFileSync(parentPid)), Number(fs.readFileSync(helperPid))];
    assert(pids.every(pid => [...owned.values()].some(row => row.pid === pid)), 'both process identities must be authenticated');
    const shutdown = stop(active); let settled = false; shutdown.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'shutdown must not finish while resistant processes remain');
    await shutdown;
    assert.deepEqual(await survivors(), [], 'real parent and helper must be gone at shutdown settlement');
    await run;
    assert.deepEqual(opened, []); assert.deepEqual(warnings, []);
    assert.equal(active.shutdown(), active.shutdown());
    await active.commandRunScript({ fsPath: script }); assert.deepEqual(await survivors(), []);
    report.cases.push({ name: 'resistant-build-parent-helper-drained', status: 'passed', pids });
    report.status = 'passed';
  } catch (error) { failure = error; report.status = 'failed'; report.error = String(error.stack || error); }
  finally {
    for (const instance of providers) instance.dispose();
    await recordOwned();
    for (const wanted of await survivors()) {
      const current = (await inventoryProcesses()).find(row => row.pid === wanted.pid && row.start === wanted.start);
      if (current) { try { process.kill(current.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    }
    const deadline = Date.now() + 3000;
    while ((await survivors()).length && Date.now() < deadline) await sleep(25);
    await Promise.allSettled(runs);
    await Promise.all(providers.map(instance => stop(instance)));
    Module._load = originalLoad;
    const remaining = await survivors();
    report.cleanup = { verified: remaining.length === 0, pids: [...owned.values()].map(row => row.pid), survivors: remaining };
    report.ownedIdentities = [...owned.values()]; report.tempDir = temp;
    fs.writeFileSync(path.join(REPORT, 'report.json'), JSON.stringify(report, null, 2));
    assert.deepEqual(remaining, []);
    if (!failure) fs.rmSync(temp, { recursive: true, force: true });
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ status: 'passed', cases: report.cases.length, cleanup: report.cleanup }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
