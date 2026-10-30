'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const esbuild = require('esbuild');
const ROOT = path.resolve(__dirname, '../..');
const REPORT = path.resolve(process.env.GDS_PROVIDER_SHUTDOWN_REPORT_DIR || path.join(ROOT, 'logs/reliability/build-provider-shutdown'));
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('lifecycle gate timed out')), 2500); })]); }
  finally { clearTimeout(timer); }
}
async function until(test) { await bounded((async () => { while (!test()) await tick(); })()); }
async function pending(promise) {
  let settled = false; promise.then(() => { settled = true; }, () => { settled = true; });
  await tick(); await tick(); assert.equal(settled, false, 'shutdown must wait for its owned build');
}
class CancellationTokenSource {
  constructor() {
    this.listeners = new Set();
    this.token = { isCancellationRequested: false, onCancellationRequested: callback => {
      this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) };
    } };
  }
  cancel() { if (!this.token.isCancellationRequested) { this.token.isCancellationRequested = true; for (const callback of this.listeners) callback(); } }
  dispose() { this.listeners.clear(); }
}
function mockVscode(root, f) {
  const uri = fsPath => ({ fsPath, scheme: 'file' });
  const disposable = () => ({ dispose() {} });
  return {
    CancellationTokenSource,
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createTextEditorDecorationType: disposable,
      registerCustomEditorProvider: (_type, provider) => { f.provider = provider; return disposable(); },
      registerTreeDataProvider: disposable,
      showWarningMessage: message => f.warnings.push(message), showErrorMessage: message => f.errors.push(message),
      showInformationMessage() {}, showTextDocument: async () => {}, showOpenDialog: async () => [],
      showQuickPick: async (_items, _options, token) => {
        f.pickerToken = token; f.pickerStarted = true;
        if (f.phase !== 'picker') return;
        token?.onCancellationRequested(() => f.choice.release(undefined));
        return f.choice.promise;
      },
      withProgress: async (_options, task) => task({}, { onCancellationRequested: disposable }),
    },
    commands: {
      registerCommand: (name, callback) => { f.commands.set(name, callback); return disposable(); },
      executeCommand: async (command, value) => f.opened.push({ command, file: value?.fsPath }),
    },
    workspace: {
      workspaceFolders: [{ name: 'owned-test', uri: uri(root) }], getWorkspaceFolder: () => ({ uri: uri(root) }),
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      createFileSystemWatcher: () => ({ dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable }),
      onDidChangeWorkspaceFolders: disposable, findFiles: async () => [], asRelativePath: value => value.fsPath,
      fs: { readFile: file => fs.promises.readFile(file.fsPath) },
    },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    RelativePattern: function () {}, ProgressLocation: { Notification: 15 }, OverviewRulerLane: { Right: 4 },
    ViewColumn: { Beside: 2 }, TreeItem: class {}, TreeItemCollapsibleState: { None: 0, Expanded: 1 },
    EventEmitter: class { constructor() { this.event = disposable; } fire() {} dispose() {} },
  };
}
async function scenario(phase) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-provider-shutdown-')));
  const script = path.join(temp, 'layout.py'), output = path.join(temp, 'layout.gds');
  fs.writeFileSync(script, '# private lifecycle fixture\n'); fs.writeFileSync(output, 'gds');
  const f = { phase, commands: new Map(), opened: [], warnings: [], errors: [], diagCount: 0, runCount: 0,
    state: gate(), env: gate(), diag: gate(), run: gate(), write: gate(), choice: gate() };
  globalThis.__gdsShutdownHarness = f;
  let extension, run, stopped, passed = false;
  const originalLoad = Module._load;
  try {
    const bundle = path.join(temp, 'extension.cjs');
    await esbuild.build({ entryPoints: [path.join(ROOT, 'src/extension.ts')], outfile: bundle,
      bundle: true, platform: 'node', format: 'cjs', external: ['vscode'],
      plugins: [{ name: 'controlled-build-leaves', setup(build) {
        build.onResolve({ filter: /^\.\/(envProvider|pythonRunner)$/ }, args => ({ path: args.path, namespace: 'lifecycle' }));
        build.onLoad({ filter: /.*/, namespace: 'lifecycle' }, args => ({ loader: 'js', contents: args.path.endsWith('envProvider') ? `
          class EnvProvider { ready() { const f=globalThis.__gdsShutdownHarness; return f.holdEnv ? f.env.promise : Promise.resolve(); } getPython() { return 'controlled-python'; } }
          async function inspectPython(python, timeout, signal) { const f=globalThis.__gdsShutdownHarness; f.diagCount++; f.diagSignal=signal; if(['diagnostics','unverified-diagnostics'].includes(f.phase)) await f.diag.promise; return f.phase==='unverified-diagnostics' ? {executable:python,error:'shutdown unverified',shutdownError:'shutdown unverified'} : {executable:python}; }
          module.exports={EnvProvider,inspectPython};` : `
          async function runPythonScript(python, script, cwd, output, options) { const f=globalThis.__gdsShutdownHarness; f.runCount++; f.runSignal=options.signal; if(['running','unverified-run','watcher-error'].includes(f.phase)) await f.run.promise; if(f.phase==='unverified-run') return {ok:false,reason:'shutdown unverified',shutdownError:'shutdown unverified'}; if(options.signal.aborted) return {ok:false,reason:'cancelled'}; return f.result; }
          module.exports={runPythonScript};` }));
      } }],
    });
    const vscode = mockVscode(temp, f);
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    extension = require(bundle);
    const context = { subscriptions: [], extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(temp, 'storage') },
      workspaceState: { get() {}, update: async () => {} } };
    extension.activate(context);
    f.result = phase === 'picker' ? { ok: false, candidates: [output, path.join(temp, 'other.gds')] }
      : { ok: true, gdsPath: output, candidates: [output] };
    const command = f.commands.get('gdsNavigator.runScript'); assert(command && f.provider);
    if (phase === 'after-stop') {
      const controls = [new AbortController(), new AbortController(), new AbortController()];
      const viewer = { parseController: controls[0], catalogController: controls[1], thumbnailController: controls[2] };
      f.provider.viewers.set(output, [viewer]);
      await extension.deactivate(); run = command({ fsPath: script }); await bounded(run);
      assert.equal(viewer.disposed, true); assert(controls.every(controller => controller.signal.aborted));
      assert.equal(f.diagCount, 0, 'a command after deactivation must not start diagnostics');
      assert.equal(f.runCount, 0);
    } else {
      const expectedFailure = ['unverified-diagnostics', 'unverified-run', 'watcher-error'].includes(phase);
      if (phase === 'watcher-error') f.provider.instructionWatchers.set('test', () => { throw new Error('watcher disposal failed'); });
      if (phase === 'state') f.provider.state.ready = () => f.state.promise;
      if (phase === 'environment') f.holdEnv = true;
      if (phase === 'persistence') {
        const save = f.provider.enqueueWorkspaceUpdate.bind(f.provider);
        f.provider.enqueueWorkspaceUpdate = async (key, value) => { f.writeStarted = true; await f.write.promise; return save(key, value); };
      }
      run = command({ fsPath: script });
      void run.catch(() => {});
      if (phase === 'state') await tick();
      else if (phase === 'environment') await until(() => f.provider.builds.size === 1);
      else if (['diagnostics', 'unverified-diagnostics'].includes(phase)) await until(() => f.diagCount === 1);
      else if (['running', 'unverified-run', 'watcher-error'].includes(phase)) await until(() => f.runCount === 1);
      else if (phase === 'persistence') await until(() => f.writeStarted);
      else if (phase === 'picker') await until(() => f.pickerStarted);
      else await bounded(run);
      stopped = extension.deactivate();
      if (phase !== 'normal' && phase !== 'picker') await pending(stopped);
      if (phase === 'diagnostics') assert.equal(f.diagSignal.aborted, true);
      if (phase === 'running') assert.equal(f.runSignal.aborted, true);
      if (phase === 'picker') { await until(() => f.pickerToken?.isCancellationRequested); }
      f.state.release(); f.env.release(); f.diag.release(); f.run.release(); f.write.release(); f.choice.release();
      if (expectedFailure) await assert.rejects(bounded(stopped), /Could not complete GDS build shutdown/);
      else await bounded(stopped);
      if (['unverified-diagnostics', 'unverified-run'].includes(phase)) await assert.rejects(bounded(run), /shutdown unverified/);
      else await bounded(run);
      if (phase === 'normal') {
        assert.equal(f.opened.length, 1); assert.equal(f.provider.getAssociatedScript(output), script);
      } else {
        assert.deepEqual(f.opened, [], 'shutdown must not reopen output');
        assert.deepEqual(f.warnings, [], 'shutdown must not publish late build errors');
        if (phase === 'persistence') assert.equal(f.provider.getAssociatedScript(output), script, 'accepted persistence must finish');
      }
      assert.equal(f.provider.shutdown(), f.provider.shutdown(), 'shutdown promise must be idempotent');
      f.provider.dispose(); f.provider.dispose();
    }
    assert.deepEqual(f.errors, []); passed = true;
    return { phase, status: 'passed', diagnostics: f.diagCount, runs: f.runCount };
  } finally {
    f.provider?.dispose();
    for (const key of ['state', 'env', 'diag', 'run', 'write', 'choice']) f[key].release();
    if (run) await bounded(run.catch(() => {}));
    if (stopped) await bounded(stopped.catch(() => {}));
    if (f.provider) await (f.provider.shutdown?.() || f.provider.shutdownUsage()).catch(() => {});
    Module._load = originalLoad; delete globalThis.__gdsShutdownHarness;
    if (passed) fs.rmSync(temp, { recursive: true, force: true });
  }
}
(async () => {
  fs.mkdirSync(REPORT, { recursive: true }); const cases = [];
  try {
    for (const phase of ['after-stop', 'state', 'environment', 'diagnostics', 'running', 'persistence', 'picker', 'normal', 'unverified-diagnostics', 'unverified-run', 'watcher-error']) cases.push(await scenario(phase));
    fs.writeFileSync(path.join(REPORT, 'report.json'), JSON.stringify({ status: 'passed', cases }, null, 2));
    console.log(JSON.stringify({ status: 'passed', cases: cases.length }));
  } catch (error) {
    fs.writeFileSync(path.join(REPORT, 'report.json'), JSON.stringify({ status: 'failed', cases, error: String(error.stack || error) }, null, 2));
    throw error;
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
