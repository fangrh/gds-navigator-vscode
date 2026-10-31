'use strict';

// Provider-level contract for parse work.  The parser is a controlled leaf,
// while the real GdsEditorProvider owns the entry, reload and shutdown paths.
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const REPORT = path.resolve(process.env.GDS_PARSE_PROVIDER_SHUTDOWN_REPORT_DIR || path.join(ROOT, 'logs/daily-20261031/parse-contract'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('parse contract timed out')), 2500); })]); }
  finally { clearTimeout(timer); }
}
async function until(test) { return bounded((async () => { while (!test()) await tick(); })()); }

function vscodeStub(root, harness) {
  const uri = fsPath => ({ fsPath, scheme: 'file' });
  const disposable = () => ({ dispose() {} });
  return {
    window: {
      createTextEditorDecorationType: disposable,
      showErrorMessage: message => harness.errors.push(String(message)),
      showWarningMessage: message => harness.warnings.push(String(message)),
      showInformationMessage() {},
      showTextDocument: async () => {},
    },
    OverviewRulerLane: { Right: 4 },
    workspace: {
      workspaceFolders: [{ uri: uri(root) }],
      isTrusted: true,
      getWorkspaceFolder: () => ({ uri: uri(root) }),
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      createFileSystemWatcher: () => ({ dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable }),
      fs: { readFile: file => fs.promises.readFile(file.fsPath) },
    },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    RelativePattern: function () {},
    ViewColumn: { Beside: 2 },
  };
}

async function main() {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-parse-provider-shutdown-')));
  const gdsPath = path.join(temp, 'tinyfixture.gds');
  const scriptPath = path.join(temp, 'tinyfixture.py');
  fs.writeFileSync(gdsPath, 'canonical tiny fixture');
  fs.writeFileSync(scriptPath, '# canonical provenance fixture\n');
  const bundle = path.join(temp, 'provider.cjs');
  const harness = { parseCalls: 0, parseGates: [], messages: [], errors: [], warnings: [] };
  const originalLoad = Module._load;
  let provider, provider2;
  const extraProviders = [];
  const tasks = [];
  const boundaryHolds = [];
  let passed = false;
  try {
    await esbuild.build({ entryPoints: [path.join(ROOT, 'src/gdsEditor.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle,
      plugins: [{ name: 'controlled-parse-leaf', setup(build) {
        build.onResolve({ filter: /^\.\/parseGds$/ }, args => ({ path: args.path, namespace: 'parse-contract' }));
        build.onLoad({ filter: /.*/, namespace: 'parse-contract' }, () => ({ loader: 'js', contents: `
          exports.parseGdsFile = async function (_python, gdsPath, _extension, signal) {
            const f = globalThis.__gdsParseProviderHarness; f.parseCalls++;
            const gate = f.parseGates[f.parseCalls - 1] || f.defaultGate;
            await gate.promise;
            if (f.failParse) { const error = new Error('parser shutdown failure'); error.shutdownError = 'parser shutdown failure'; throw error; }
            return { mode: 'controlled', warnings: [], geojson: { type: 'FeatureCollection', top_cell: 'TOP', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { layer: 1, data_type: 0, bbox: [1, 2, 1, 2], provenance: { file: ${JSON.stringify(scriptPath)}, line: 1, function: 'build' } } }], ports: [] } };
          };` }));
      } }], });
    const vscode = vscodeStub(temp, harness);
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.__gdsParseProviderHarness = harness;
    const { GdsEditorProvider } = require(bundle);
    const values = new Map();
    const context = { extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(temp, 'storage') }, workspaceState: { get: key => values.get(key), update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); } } };
    const env = { ready: async () => { harness.envReady = true; }, getPython: () => 'controlled-python', setActiveFile() {} };
    provider = new GdsEditorProvider(context, env, { appendLine: line => harness.output = (harness.output || []).concat(String(line)), show() {} });
    provider.state.ready = async () => { harness.stateReady = true; };
    const entry = { gdsPath, ready: true, loading: false, disposed: false, saveQueue: Promise.resolve(), images: new Map(), imageRevisions: new Map(), panel: { webview: { postMessage: async message => { harness.messages.push(message); return true; } } } };
    provider.viewers.set(gdsPath, [entry]);

    // Normal load is a payload/provenance contract, and a duplicate request
    // while loading coalesces into one queued reload.
    const first = gate(); const second = gate(); harness.parseGates.push(first, second);
    const load = provider.loadGds(entry); tasks.push(load); await until(() => harness.parseCalls === 1);
    const duplicate = provider.loadGds(entry); await tick();
    assert.equal(entry.reloadPending, true, 'duplicate load must queue one reload');
    tasks.push(duplicate); first.release(); await until(() => harness.parseCalls === 2); second.release(); await bounded(Promise.all([load, duplicate]));
    await until(() => harness.messages.filter(message => message.type === 'loadGds').length === 2);
    await until(() => entry.loading === false);
    const published = harness.messages.find(message => message.type === 'loadGds');
    assert.deepEqual(published.geojson.features[0].geometry, { type: 'Point', coordinates: [1, 2] });
    assert.equal(published.geojson.features[0].properties.provenance.function, 'build');
    assert.equal(published.geojson.features[0].properties.provenance.file, scriptPath);
    assert.equal(harness.messages.filter(message => message.type === 'loadGds').length, 2);

    // A standalone parse must keep shutdown pending until the parse leaf has
    // drained; after shutdown starts, no new load or late publication is legal.
    harness.messages.length = 0; entry.loadedGdsOnce = false; entry.loading = false; entry.reloadPending = false; entry.disposed = false;
    const blocked = gate(); harness.parseGates.push(blocked);
    const pendingLoad = provider.loadGds(entry); tasks.push(pendingLoad); await until(() => harness.parseCalls === 3);
    const stopped = provider.shutdown(); assert.equal(stopped, provider.shutdown(), 'shutdown promise must be idempotent');
    let settled = false; stopped.then(() => { settled = true; }, () => { settled = true; });
    await tick(); await tick();
    assert.equal(settled, false, 'shutdown must wait for an in-flight parse');
    const before = harness.parseCalls; await provider.loadGds(entry); assert.equal(harness.parseCalls, before, 'new loads must be blocked after shutdown');
    blocked.release(); await bounded(pendingLoad); await bounded(stopped);
    assert.equal(harness.messages.filter(message => message.type === 'loadGds').length, 0, 'shutdown must suppress late load publication');
    assert.equal(entry.disposed, true);

    // A parser termination failure is not silently converted into a clean
    // shutdown: the structured shutdownError marker must reach the owner.
    harness.failParse = true;
    provider2 = new GdsEditorProvider(context, env, { appendLine: line => harness.output = (harness.output || []).concat(String(line)), show() {} });
    provider2.state.ready = async () => {};
    const failedEntry = { gdsPath, ready: true, loading: false, disposed: false, saveQueue: Promise.resolve(), images: new Map(), imageRevisions: new Map(), panel: { webview: { postMessage: async message => { harness.messages.push(message); return true; } } } };
    provider2.viewers.set(gdsPath, [failedEntry]);
    const failedParse = gate(); harness.parseGates.push(failedParse);
    const failedLoad = provider2.loadGds(failedEntry); tasks.push(failedLoad); void failedLoad.catch(() => {}); await until(() => harness.parseCalls === 4);
    const failedStop = provider2.shutdown(); let failedSettled = false; failedStop.then(() => { failedSettled = true; }, () => { failedSettled = true; });
    await tick(); assert.equal(failedSettled, false, 'shutdown must wait for a parser failure to settle');
    failedParse.release(); await assert.rejects(bounded(failedLoad), /parser shutdown failure/);
    await assert.rejects(bounded(failedStop), /parser shutdown failure|Could not complete GDS build shutdown/);
    harness.failParse = false;
    harness.defaultGate = { promise: Promise.resolve() };

    // The tracked task must cover every await boundary in loadGds, not just
    // the parser itself: state hydration, the first webview publication, and
    // review snapshot persistence all suppress late publication on shutdown.
    const makeBoundaryProvider = () => {
      const p = new GdsEditorProvider(context, env, { appendLine() {}, show() {} });
      extraProviders.push(p);
      return p;
    };
    const boundaryLoadMessages = harness.messages.filter(message => message.type === 'loadGds').length;
    const makeBoundaryEntry = (postMessage = async message => { harness.messages.push(message); return true; }) => ({ gdsPath, ready: true, loading: false, disposed: false, saveQueue: Promise.resolve(), images: new Map(), imageRevisions: new Map(), panel: { webview: { postMessage } } });
    for (const boundary of ['state', 'layoutLoading', 'reviewSnapshot']) {
      const p = makeBoundaryProvider();
      const hold = gate();
      boundaryHolds.push(hold);
      let started = false;
      if (boundary === 'state') {
        p.state.ready = () => { started = true; return hold.promise; };
        const boundaryEntry = makeBoundaryEntry();
        p.viewers.set(gdsPath, [boundaryEntry]);
        const boundaryLoad = p.loadGds(boundaryEntry); tasks.push(boundaryLoad); void boundaryLoad.catch(() => {});
        await until(() => started);
        const boundaryStop = p.shutdown(); let boundarySettled = false; boundaryStop.then(() => { boundarySettled = true; }, () => { boundarySettled = true; });
        await tick(); assert.equal(boundarySettled, false, `${boundary} boundary must remain pending during shutdown`);
        hold.release(); await bounded(boundaryLoad); await bounded(boundaryStop);
        continue;
      } else if (boundary === 'layoutLoading') {
        p.state.ready = async () => {};
        const post = async message => { harness.messages.push(message); if (message.type === 'layoutLoading') { started = true; await hold.promise; } return true; };
        const boundaryEntry = makeBoundaryEntry(post);
        p.viewers.set(gdsPath, [boundaryEntry]);
        const boundaryLoad = p.loadGds(boundaryEntry); tasks.push(boundaryLoad); void boundaryLoad.catch(() => {});
        await until(() => started);
        const boundaryStop = p.shutdown(); let boundarySettled = false; boundaryStop.then(() => { boundarySettled = true; }, () => { boundarySettled = true; });
        await tick(); assert.equal(boundarySettled, false, `${boundary} boundary must remain pending during shutdown`);
        hold.release(); await bounded(boundaryLoad); await bounded(boundaryStop);
        continue;
      } else {
        p.state.ready = async () => {};
        const boundaryEntry = makeBoundaryEntry();
        const reviewParse = gate(); harness.parseGates.push(reviewParse);
        p.reviewSnapshots.record = async () => { started = true; await hold.promise; return { previousHash: undefined, features: [], status: 'new' }; };
        p.viewers.set(gdsPath, [boundaryEntry]);
        const boundaryLoad = p.loadGds(boundaryEntry); tasks.push(boundaryLoad); void boundaryLoad.catch(() => {});
        await until(() => harness.parseCalls >= 5); reviewParse.release(); await until(() => started);
        const boundaryStop = p.shutdown(); let boundarySettled = false; boundaryStop.then(() => { boundarySettled = true; }, () => { boundarySettled = true; });
        await tick(); assert.equal(boundarySettled, false, `${boundary} boundary must remain pending during shutdown`);
        hold.release(); await bounded(boundaryLoad); await bounded(boundaryStop);
        continue;
      }
    }
    assert.equal(harness.messages.filter(message => message.type === 'loadGds').length, boundaryLoadMessages, 'boundary shutdowns must suppress late load publication');

    const result = { status: 'passed', parseCalls: harness.parseCalls, duplicateReloads: 1, lateLoadMessages: 0 };
    fs.mkdirSync(REPORT, { recursive: true }); fs.writeFileSync(path.join(REPORT, 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    passed = true;
  } finally {
    provider?.dispose(); provider2?.dispose(); extraProviders.forEach(p => p.dispose());
    boundaryHolds.forEach(g => g.release());
    globalThis.__gdsParseProviderHarness?.parseGates?.forEach(g => g.release());
    await Promise.allSettled(tasks);
    await Promise.allSettled([provider?.shutdown?.(), provider2?.shutdown?.(), ...extraProviders.map(p => p.shutdown?.())]);
    Module._load = originalLoad; delete globalThis.__gdsParseProviderHarness;
    if (passed) fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
