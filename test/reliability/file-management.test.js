#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const esbuild = require('esbuild');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

const ROOT = path.resolve(__dirname, '../..');
const python = process.platform === 'win32' ? path.join(ROOT, '.venv-fork', 'Scripts', 'python.exe') : path.join(ROOT, '.venv-fork', 'bin', 'python');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-files-'));
const bundle = path.join(temp, 'editor.cjs');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function main() {
  if (!fs.existsSync(python)) { console.log(JSON.stringify({ status: 'skipped', reason: 'fork Python unavailable' })); return; }
  esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src/gdsEditor.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle });
  const originalLoad = Module._load;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-project-'));
  const calls = { opened: [], commands: [], picks: [], warnings: [], builds: 0 };
  let childProcess;
  let realSpawn;
  const values = new Map();
  const memento = { keys: [], get: (key) => values.get(key), update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); memento.keys = [...values.keys()]; } };
  const vscode = {
    window: {
      createTextEditorDecorationType: () => ({}),
      showErrorMessage() {}, showWarningMessage(message) { calls.warnings.push(message); }, showInformationMessage() {},
      showTextDocument: async (uri) => { calls.opened.push(uri.fsPath); },
      showQuickPick: async (items) => { calls.picks.push(items); return items?.[items.length - 1]; },
      withProgress: async (_opts, task) => task({}, { onCancellationRequested() { return { dispose() {} }; } }),
      activeTextEditor: undefined,
    },
    commands: { executeCommand: async (command, uri) => { calls.commands.push({ command, path: uri?.fsPath }); } },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspace } }],
      getWorkspaceFolder: () => ({ uri: { fsPath: workspace } }),
      getConfiguration: () => ({ get: () => 120 }),
      createFileSystemWatcher: () => ({ dispose() {}, onDidChange() {}, onDidCreate() {}, onDidDelete() {} }),
      fs: { readFile: async (uri) => fs.promises.readFile(uri.fsPath) },
    },
    Uri: { file: (fsPath) => ({ fsPath }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
    RelativePattern: function (base, pattern) { this.base = base; this.pattern = pattern; },
    ProgressLocation: { Notification: 15 }, ViewColumn: { Beside: 2 }, OverviewRulerLane: { Right: 4 },
  };
  try {
    childProcess = require('child_process');
    realSpawn = childProcess.spawn;
    childProcess.spawn = (executable, args, options) => {
      const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => proc.emit('close', null);
      process.nextTick(() => {
        if (args.length === 2) {
          proc.stdout.emit('data', Buffer.from(JSON.stringify({ executable, pythonVersion: 'test', gdsfactory: {} }) + '\n')); proc.emit('close', 0); return;
        }
        const source = fs.readFileSync(args[2], 'utf8');
        for (const match of source.matchAll(/open\(("(?:\\.|[^"])*"),\s*['"]w['"]\)/g)) {
          const file = JSON.parse(match[1]); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'mock-build');
        }
        proc.emit('close', 0);
      });
      return proc;
    };
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    const { GdsEditorProvider } = require(bundle);
    const provider = new GdsEditorProvider({ extensionUri: { fsPath: ROOT }, workspaceState: memento }, { getPython: () => python }, { appendLine() {}, show() {} });
    const entry = (gdsPath) => ({ gdsPath, ready: true, loading: false, disposed: false, images: new Map(), imageRevisions: new Map(), saveQueue: Promise.resolve(), panel: { webview: { postMessage: async () => true } } });
    const script = path.join(workspace, 'layout.py');
    const gds = path.join(workspace, 'layout.gds');
    fs.writeFileSync(script, `open(${JSON.stringify(gds)}, 'w').write('cycle')\n`);
    await provider.runScriptFor(script, gds);
    assert(samePath(provider.getAssociatedScript(gds), script), 'successful build must create exact script-to-GDS link');
    await provider.commandOpenPython(entry(gds));
    assert(samePath(calls.opened.at(-1), script), 'open Python must use the exact generating script');

    const noOutput = path.join(workspace, 'none.py'); fs.writeFileSync(noOutput, 'print("old.gds")\n');
    const beforeNoOutput = provider.getAssociatedScript(path.join(workspace, 'none.gds'));
    await provider.runScriptFor(noOutput, path.join(workspace, 'none.gds'));
    assert.equal(provider.getAssociatedScript(path.join(workspace, 'none.gds')), beforeNoOutput, 'no-output build must not create a link');

    const a = path.join(workspace, 'a.gds'), b = path.join(workspace, 'b.gds'), many = path.join(workspace, 'many.py');
    fs.writeFileSync(many, `open(${JSON.stringify(a)}, 'w').write('a')\nopen(${JSON.stringify(b)}, 'w').write('b')\n`);
    await provider.runScriptFor(many, path.join(workspace, 'missing.gds'));
    assert(samePath(provider.getAssociatedScript(a), many)); assert(samePath(provider.getAssociatedScript(b), many));
    const beforePick = calls.commands.length; await provider.runScriptFor(many, path.join(workspace, 'missing.gds'));
    assert(calls.commands.length > beforePick, 'multiple candidates must offer an explicit link/open choice');

    provider.activeGdsPath = gds;
    const beforeAssociate = calls.opened.length + calls.commands.length;
    vscode.window.showOpenDialog = async () => [{ fsPath: script }];
    await provider.commandAssociate();
    assert.equal(calls.opened.length + calls.commands.length, beforeAssociate, 'explicit association must not run a build');

    await provider.commandRelatedFiles(entry(gds));
    const related = calls.picks.at(-1).map((item) => item.detail);
    assert(related.some((file) => samePath(file, script)) && related.some((file) => samePath(file, gds)), 'related files must include exact Python and layout');

    for (let i = 0; i < 20; i++) {
      const cycleScript = path.join(workspace, `cycle-${i}.py`), cycleGds = path.join(workspace, `cycle-${i}.gds`);
      fs.writeFileSync(cycleScript, `open(${JSON.stringify(cycleGds)}, 'w').write(${JSON.stringify(String(i))})\n`);
      await provider.runScriptFor(cycleScript, cycleGds);
      assert(samePath(provider.getAssociatedScript(cycleGds), cycleScript), `cycle ${i} link mismatch`);
      assert(samePath(provider.getAssociatedScript(gds), script), `cycle ${i} mixed the original link`);
    }
    provider.dispose();
    console.log(JSON.stringify({ status: 'passed', successful: true, noOutput: true, multiple: true, associationNoBuild: true, relatedFiles: true, cycles: 20 }));
  } finally {
    if (childProcess && realSpawn) childProcess.spawn = realSpawn;
    Module._load = originalLoad;
    fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
