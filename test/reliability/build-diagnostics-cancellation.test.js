#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const REPORT_DIR = path.resolve(process.env.GDS_BUILD_DIAGNOSTICS_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'build-diagnostics-cancellation'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-build-diagnostics-'));
  const bundle = path.join(temp, 'editor.cjs');
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(workspace);
  const script = path.join(workspace, 'layout.py');
  fs.writeFileSync(script, '# must never execute after diagnostics cancellation\n');
  const gds = path.join(workspace, 'layout.gds');
  const values = new Map();
  const memento = { get: key => values.get(key), update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); } };
  const calls = { refreshes: [], commands: [], warnings: [], diagnostics: 0, layoutSpawns: 0 };
  let progressCancel;
  let releaseDiagnostics;
  let diagnosticArgs;
  let provider;
  let run;
  let originalLoad;
  let originalSpawn;
  let failure;
  let passed = false;

  const uri = fsPath => ({ fsPath, scheme: 'file' });
  const vscode = {
    window: {
      createTextEditorDecorationType: () => ({}),
      showErrorMessage: () => {},
      showWarningMessage: message => calls.warnings.push(String(message)),
      showInformationMessage: () => {},
      showQuickPick: async () => undefined,
      showTextDocument: async () => {},
      withProgress: async (_options, task) => task({}, {
        onCancellationRequested: callback => { progressCancel = callback; return { dispose() {} }; },
      }),
      activeTextEditor: undefined,
    },
    commands: { executeCommand: async (command, value) => calls.commands.push({ command, path: value?.fsPath }) },
    workspace: {
      workspaceFolders: [{ uri: uri(workspace) }],
      getWorkspaceFolder: () => ({ uri: uri(workspace) }),
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      createFileSystemWatcher: () => ({ dispose() {}, onDidChange() {}, onDidCreate() {}, onDidDelete() {} }),
      fs: { readFile: async file => fs.promises.readFile(file.fsPath) },
    },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    RelativePattern: function (base, pattern) { this.base = base; this.pattern = pattern; },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { Beside: 2 },
    OverviewRulerLane: { Right: 4 },
  };

  try {
    await esbuild.build({
      entryPoints: [path.join(ROOT, 'src', 'gdsEditor.ts')], bundle: true,
      platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle,
      plugins: [{
        name: 'diagnostics-contract-env-provider',
        setup(build) {
          build.onResolve({ filter: /^\.\/envProvider$/ }, () => ({ path: 'env-provider-contract', namespace: 'diagnostics-contract' }));
          build.onLoad({ filter: /.*/, namespace: 'diagnostics-contract' }, () => ({
            loader: 'js',
            contents: `
              class EnvProvider {}
              function inspectPython(python, timeoutMs, signal) {
                globalThis.__diagnosticsArgs = { python, timeoutMs, signal };
                return new Promise(resolve => {
                  globalThis.__releaseDiagnostics = () => resolve({ executable: python, pythonVersion: 'late-success' });
                  signal?.addEventListener('abort', () => { globalThis.__diagnosticsCancelled = true; }, { once: true });
                });
              }
              module.exports = { EnvProvider, inspectPython };
            `,
          }));
        },
      }],
    });
    originalLoad = Module._load;
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    const childProcess = require('node:child_process');
    originalSpawn = childProcess.spawn;
    childProcess.spawn = (executable, args, options) => {
      if (args.length === 3) {
        calls.layoutSpawns++;
        throw new Error('layout execution must be suppressed after diagnostics cancellation');
      }
      return originalSpawn(executable, args, options);
    };

    const { GdsEditorProvider } = require(bundle);
    provider = new GdsEditorProvider(
      { extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(temp, 'storage') }, workspaceState: memento },
      { ready: async () => {}, getPython: () => 'diagnostics-test-executable' },
      { appendLine() {}, show() {} },
    );
    provider.refresh = async gdsPath => calls.refreshes.push(gdsPath);

    run = provider.runScriptFor(script, gds);
    const deadline = Date.now() + 3000;
    while (!globalThis.__diagnosticsArgs && Date.now() < deadline) await sleep(5);
    diagnosticArgs = globalThis.__diagnosticsArgs;
    releaseDiagnostics = globalThis.__releaseDiagnostics;
    assert(diagnosticArgs, 'inspectPython was not called');
    assert.equal(diagnosticArgs.python, 'diagnostics-test-executable');
    assert(diagnosticArgs.signal instanceof AbortSignal, 'provider must pass a live AbortSignal to inspectPython');
    assert.equal(typeof releaseDiagnostics, 'function');
    assert.equal(typeof progressCancel, 'function', 'withProgress must expose cancellation');

    let settled = false;
    run.then(() => { settled = true; }, () => { settled = true; });
    progressCancel();
    await sleep(30);
    assert.equal(settled, false, 'build must remain pending until diagnostics tree termination is verified');
    assert.equal(diagnosticArgs.signal.aborted, true, 'progress cancellation must abort the diagnostics signal');
    assert.equal(globalThis.__diagnosticsCancelled, true, 'inspectPython must observe the diagnostics cancellation');
    assert.equal(calls.layoutSpawns, 0, 'layout Python must not start during diagnostics cancellation');

    // A successful result arriving after cancellation must not revive the build.
    releaseDiagnostics();
    await run;
    assert.equal(calls.layoutSpawns, 0);
    assert.deepEqual(calls.refreshes, [], 'cancelled build must not refresh a viewer');
    assert.deepEqual(calls.commands, [], 'cancelled build must not open a produced GDS');
    assert.equal(values.has('gdsNavigator.fileLinks.v1'), false, 'cancelled build must not persist output links');
    passed = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (provider) { try { provider.dispose(); } catch (error) { failure ||= error; } }
    (releaseDiagnostics || globalThis.__releaseDiagnostics)?.();
    if (run) await run.catch(() => {});
    if (originalSpawn) require('node:child_process').spawn = originalSpawn;
    if (originalLoad) Module._load = originalLoad;
    if (provider) await provider.shutdownUsage();
    delete globalThis.__diagnosticsArgs;
    delete globalThis.__releaseDiagnostics;
    delete globalThis.__diagnosticsCancelled;
    if (!failure && passed) fs.rmSync(temp, { recursive: true, force: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify({
      status: failure ? 'failed' : 'passed',
      diagnosticsCancellation: passed && !failure,
      noLayoutSpawn: passed && !failure,
      noLatePublication: passed && !failure,
      error: failure ? String(failure.stack || failure) : undefined,
      retainedFixtures: !!failure && fs.existsSync(temp),
    }, null, 2) + '\n');
  }
}

main().then(() => console.log(JSON.stringify({ status: 'passed', diagnosticsCancellation: true, noLayoutSpawn: true, noLatePublication: true }))).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
