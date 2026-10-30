#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const esbuild = require('esbuild');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { inventoryProcesses } = require('../../scripts/process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '../..');
const python = process.env.GDS_TEST_PYTHON || process.env.GDS_PYTHON || (process.platform === 'win32' ? path.join(ROOT, '.venv-fork', 'Scripts', 'python.exe') : path.join(ROOT, '.venv-fork', 'bin', 'python'));
const reportDir = process.env.GDS_OUTPUT_ALIAS_PROVIDER_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'output-alias-provider');

async function main() {
  if (!fs.existsSync(python)) throw new Error(`required Python interpreter does not exist: ${python}`);
  let temp; let canonical; let alias; let provider; let originalLoad; let passed = false; let failure;
  try {
    temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-alias-provider-')));
    canonical = path.join(temp, 'project'); alias = path.join(temp, 'workspace-alias'); fs.mkdirSync(canonical);
    try { fs.symlinkSync(canonical, alias, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { throw new Error(`workspace alias creation failed: ${error.message}`); }
    const bundle = path.join(temp, 'editor.cjs');
    esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src', 'gdsEditor.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle });
    const values = new Map();
    const memento = { keys: [], get: key => values.get(key), update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); memento.keys = [...values.keys()]; } };
    const calls = { commands: [], picks: [], refreshes: [] };
    const vscode = {
      window: { createTextEditorDecorationType: () => ({}), showErrorMessage() {}, showWarningMessage() {}, showInformationMessage() {}, showTextDocument: async () => {}, showQuickPick: async items => { calls.picks.push(items); return undefined; }, withProgress: async (_opts, task) => task({}, { onCancellationRequested() { return { dispose() {} }; } }), activeTextEditor: undefined },
      commands: { executeCommand: async (command, uri) => calls.commands.push({ command, path: uri?.fsPath }) },
      workspace: { workspaceFolders: [{ uri: { fsPath: alias } }], getWorkspaceFolder: () => ({ uri: { fsPath: alias } }), getConfiguration: () => ({ get: () => 120 }), createFileSystemWatcher: () => ({ dispose() {}, onDidChange() {}, onDidCreate() {}, onDidDelete() {} }), fs: { readFile: async uri => fs.promises.readFile(uri.fsPath) } },
      Uri: { file: fsPath => ({ fsPath }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) }, RelativePattern: function (base, pattern) { this.base = base; this.pattern = pattern; }, ProgressLocation: { Notification: 15 }, ViewColumn: { Beside: 2 }, OverviewRulerLane: { Right: 4 },
    };
    originalLoad = Module._load; Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    const { GdsEditorProvider } = require(bundle);
    provider = new GdsEditorProvider({ extensionUri: { fsPath: ROOT }, workspaceState: memento }, { getPython: () => python }, { appendLine() {}, show() {} });
    const script = path.join(alias, 'layout.py'); const output = path.join(alias, 'alias-output.gds'); fs.writeFileSync(script, "open('alias-output.gds', 'w').write('one')\n");
    const unrelatedPath = path.join(alias, 'unrelated.gds');
    const unrelatedViewer = { gdsPath: unrelatedPath, panel: { webview: { postMessage: async () => true } } };
    provider.viewers.set(unrelatedPath, [unrelatedViewer]);
    provider.viewers.set(output, [{ gdsPath: output, disposed: false, panel: { webview: { postMessage: async () => true } } }]); provider.refresh = async gdsPath => calls.refreshes.push(gdsPath);
    await provider.runScriptFor(script, output);
    assert.deepEqual(calls.picks, [], 'a workspace/audit alias must not trigger output selection'); assert.deepEqual(calls.commands, [], 'an existing aliased viewer must not open another editor'); assert.deepEqual(calls.refreshes, [output], 'the existing viewer must refresh using the workspace alias'); assert.equal(path.resolve(provider.getAssociatedScript(output)), path.resolve(script), 'the output must link to its generating script'); assert.equal(provider.viewers.get(output).length, 1, 'output viewer inventory must remain intact');
    assert.deepEqual(provider.viewers.get(unrelatedPath), [unrelatedViewer], 'unrelated viewer inventory must remain intact');
    passed = true;
  } catch (error) { failure = error; throw error; }
  finally {
    if (provider) { try { await provider.shutdown(); } catch (error) { failure ||= error; } }
    if (originalLoad) Module._load = originalLoad;
    const markers = [temp, canonical, alias].filter(Boolean); let survivors; let cleanupVerified = false;
    try {
      survivors = (await inventoryProcesses()).filter(row => markers.some(marker => row.command.includes(marker)));
      cleanupVerified = survivors.length === 0;
    } catch (error) { failure ||= error; survivors = null; }
    if (survivors?.length) failure ||= new Error(`processes still reference test fixtures: ${survivors.map(row => row.pid).join(', ')}`);
    if (passed && !failure) { try { fs.rmSync(temp, { recursive: true, force: true }); } catch (error) { failure = error; } if (temp && fs.existsSync(temp)) failure ||= new Error(`temporary fixture survived cleanup: ${temp}`); }
    fs.mkdirSync(reportDir, { recursive: true }); fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', aliasDedup: passed && !failure, existingViewerRefresh: passed && !failure, noOpenWith: passed && !failure, cleanup: { verified: cleanupVerified, survivors }, retainedFixtures: !!failure && !!temp && fs.existsSync(temp) }, null, 2) + '\n');
    if (failure && !passed) throw failure;
    if (failure) throw failure;
  }
}

main().then(() => console.log(JSON.stringify({ status: 'passed', aliasDedup: true, existingViewerRefresh: true, noOpenWith: true }))).catch(error => { console.error(error.stack); process.exitCode = 1; });
