'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { inventoryProcesses } = require('../../scripts/process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '../..');
const PYTHON = path.resolve(process.env.GDS_TEST_PYTHON || process.env.GDS_PYTHON || path.join(ROOT, '.venv-fork', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
const REPORT = path.resolve(process.env.GDS_PROVIDER_PARSE_PROCESS_REPORT_DIR || path.join(ROOT, 'logs/reliability/parse-provider-shutdown-process'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(test, label) {
  const deadline = Date.now() + 15000;
  while (!test()) { if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`); await sleep(20); }
}

function fixtureScript(root, marker) {
  const python = path.join(root, 'python'); fs.mkdirSync(python, { recursive: true });
  const helperPid = path.join(root, 'helper.pid');
  const parentPid = path.join(root, 'parent.pid');
  const ready = path.join(root, 'ready');
  const gate = path.join(root, 'gate');
  const helper = path.join(root, 'helper.py');
  fs.writeFileSync(helper, `import os, signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen(${JSON.stringify(helperPid)}, 'w').write(str(os.getpid()))\nopen(${JSON.stringify(root + '/helper-ready')}, 'w').write('ready')\nwhile True: time.sleep(1)\n`);
  const script = path.join(python, 'parse_gds.py');
  fs.writeFileSync(script, `import json, os, signal, subprocess, sys, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen(${JSON.stringify(parentPid)}, 'w').write(str(os.getpid()))\nsubprocess.Popen([sys.executable, ${JSON.stringify(helper)}])\nopen(${JSON.stringify(ready)}, 'w').write('ready')\nwhile not os.path.exists(${JSON.stringify(gate)}): time.sleep(0.01)\nprint(json.dumps({'type':'FeatureCollection','features':[{'type':'Feature','geometry':{'type':'Polygon','coordinates':[[[0,0],[1,0],[1,1],[0,0]]]},'properties':{'layer':[1,0],'datatype':0,'provenance':{'file':${JSON.stringify(marker)},'line':7,'function':'fixture'}}}]}), flush=True)\n`);
  return { script, parentPid, helperPid, ready, helperReady: path.join(root, 'helper-ready'), gate };
}

function mockVscode(workspace) {
  const uri = fsPath => ({ fsPath, scheme: 'file' });
  const disposable = () => ({ dispose() {} });
  return {
    window: { createTextEditorDecorationType: () => ({}), showErrorMessage() {}, showWarningMessage() {}, showInformationMessage() {} },
    workspace: {
      workspaceFolders: [{ uri: uri(workspace) }], getWorkspaceFolder: () => ({ uri: uri(workspace)}),
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      createFileSystemWatcher: () => ({ dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable }),
      isTrusted: false,
    },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    RelativePattern: function RelativePattern() {}, OverviewRulerLane: { Right: 4 }, ProgressLocation: { Notification: 15 },
  };
}

async function main() {
  fs.mkdirSync(REPORT, { recursive: true });
  assert(fs.existsSync(PYTHON), `Python interpreter is required: ${PYTHON}`);
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-parse-provider-process-')));
  const extensionRoot = path.join(temp, 'private-extension');
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'webview'), path.join(extensionRoot, 'webview'), 'junction');
  fs.symlinkSync(path.join(ROOT, 'media'), path.join(extensionRoot, 'media'), 'junction');
  const fixture = fixtureScript(extensionRoot, path.join(temp, 'fixture.py'));
  const gds = path.join(temp, 'fixture.gds'); fs.writeFileSync(gds, 'controlled-gds-fixture');
  const bundle = path.join(temp, 'provider.cjs');
  const owned = new Map(); const report = { status: 'failed', python: PYTHON, platform: process.platform, cases: [], tempDir: temp };
  const originalLoad = Module._load;
  let provider; let parseTask; let shutdown;
  const output = { appendLine() {}, show() {} };
  async function recordOwned() {
    for (const row of (await inventoryProcesses()).filter(row => row.command.includes(temp))) {
      assert(row.start, `cannot authenticate start identity for ${row.pid}`);
      owned.set(`${row.pid}:${row.start}`, row);
    }
  }
  async function survivors(pids) {
    const rows = await inventoryProcesses();
    return pids.filter(pid => rows.some(row => row.pid === pid && [...owned.values()].some(w => w.pid === pid && w.start === row.start)));
  }
  async function forceOwned() {
    const rows = await inventoryProcesses();
    for (const wanted of owned.values()) {
      const row = rows.find(candidate => candidate.pid === wanted.pid && candidate.start === wanted.start);
      if (!row || row.pid === process.pid) continue;
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(row.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(row.pid, 'SIGKILL');
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  try {
    await require('esbuild').build({ entryPoints: [path.join(ROOT, 'src', 'gdsEditor.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle });
    const vscode = mockVscode(temp);
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    const { GdsEditorProvider } = require(bundle);
    const values = new Map();
    provider = new GdsEditorProvider({ extensionUri: { fsPath: extensionRoot }, globalStorageUri: { fsPath: path.join(temp, 'storage') }, workspaceState: { get: key => values.get(key), update: async (key, value) => values.set(key, value) } }, { ready: async () => {}, getPython: () => PYTHON }, output);
    let receive;
    const messages = [];
    const panel = {
      active: true,
      webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: value => value.fsPath, postMessage: async message => { messages.push(message); return true; }, onDidReceiveMessage: callback => { receive = callback; return { dispose() {} }; } },
      onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
    };
    await provider.resolveCustomEditor({ uri: { fsPath: gds } }, panel, {});
    assert.equal(typeof receive, 'function', 'provider must register webview message handler');
    parseTask = receive({ type: 'webviewReady' });
    await waitFor(() => fs.existsSync(fixture.ready) && fs.existsSync(fixture.helperReady) && fs.existsSync(fixture.parentPid) && fs.existsSync(fixture.helperPid), 'parser parent/helper ready markers');
    const pids = [Number(fs.readFileSync(fixture.parentPid)), Number(fs.readFileSync(fixture.helperPid))];
    assert(pids.every(pid => Number.isInteger(pid) && pid > 0));
    await recordOwned();
    assert(pids.every(pid => [...owned.values()].some(row => row.pid === pid)), 'parent/helper PID start identities must be authenticated');
    shutdown = provider.shutdown(); let settled = false; shutdown.then(() => { settled = true; }, () => { settled = true; });
    await sleep(50);
    const earlySettlement = await survivors(pids);
    report.baseline = { shutdownSettled: settled, survivorsAtSettlement: earlySettlement };
    assert.equal(settled, false, 'provider.shutdown must remain pending while actual parse process tree drains');
    await shutdown;
    const atSettlement = await survivors(pids);
    assert.deepEqual(atSettlement, [], 'actual parser parent/helper must be gone exactly at shutdown settlement');
    fs.writeFileSync(fixture.gate, 'go');
    await Promise.allSettled([parseTask]);
    assert.equal(messages.filter(message => message.type === 'loadGds').length, 0, 'shutdown must not publish a late loadGds message');

    // Fresh-provider control: the same real parseGdsCore subprocess path must
    // still publish exact controlled geometry/provenance when allowed to run.
    fs.writeFileSync(fixture.script, "import json\nprint(json.dumps({'type':'FeatureCollection','features':[{'type':'Feature','geometry':{'type':'Polygon','coordinates':[[[0,0],[2,0],[2,1],[0,0]]]},'properties':{'layer':1,'data_type':0,'provenance':{'file':'control.py','line':11,'function':'control'}}}]}))\n");
    const control = new GdsEditorProvider({ extensionUri: { fsPath: extensionRoot }, globalStorageUri: { fsPath: path.join(temp, 'control-storage') }, workspaceState: { get: key => values.get(key), update: async (key, value) => values.set(key, value) } }, { ready: async () => {}, getPython: () => PYTHON }, output);
    const controlMessages = [];
    let controlReceive;
    const controlPanel = { active: true, webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: value => value.fsPath, postMessage: async message => { controlMessages.push(message); return true; }, onDidReceiveMessage: callback => { controlReceive = callback; return { dispose() {} }; } }, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }) };
    await control.resolveCustomEditor({ uri: { fsPath: gds } }, controlPanel, {});
    const controlTask = controlReceive({ type: 'webviewReady' }); await controlTask;
    const loaded = controlMessages.find(message => message.type === 'loadGds');
    assert(loaded && loaded.geojson.features.length === 1, 'normal provider load must publish one feature');
    assert.deepEqual(loaded.geojson.features[0].geometry, { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 1], [0, 0]]] });
    assert.equal(loaded.geojson.features[0].properties.provenance.file, 'control.py');
    assert.equal(loaded.geojson.features[0].properties.provenance.line, 11);
    await control.shutdown();
    report.status = 'passed'; report.cases.push({ name: 'actual-provider-loadGds-parser-tree-drained', status: 'passed', pids, atSettlement });
    report.cases.push({ name: 'fresh-provider-normal-real-parse-control', status: 'passed' });
  } catch (error) {
    report.error = String(error.stack || error); report.cases.push({ name: 'actual-provider-loadGds-parser-tree-drained', status: 'failed', error: report.error });
    throw error;
  } finally {
    try { fs.writeFileSync(fixture.gate, 'go'); } catch {}
    try { provider?.dispose(); shutdown ||= provider?.shutdown(); } catch (error) { report.cleanupError = String(error.stack || error); }
    try { await recordOwned(); await forceOwned(); } catch (error) { report.cleanupError = String(error.stack || error); }
    const cleanupPids = [...new Set([...owned.values()].map(row => row.pid))];
    let remaining = await survivors(cleanupPids); const deadline = Date.now() + 3000;
    while (remaining.length && Date.now() < deadline) { await sleep(25); remaining = await survivors(cleanupPids); }
    await Promise.allSettled([parseTask, shutdown]);
    remaining = await survivors(cleanupPids);
    report.cleanup = { verified: remaining.length === 0, survivors: remaining, ownedIdentities: [...owned.values()] };
    report.tempDir = temp; fs.writeFileSync(path.join(REPORT, 'report.json'), JSON.stringify(report, null, 2));
    Module._load = originalLoad;
    if (remaining.length === 0 && report.status === 'passed') fs.rmSync(temp, { recursive: true, force: true });
    if (remaining.length) throw new Error(`authenticated parser processes survived cleanup: ${remaining.join(', ')}`);
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
