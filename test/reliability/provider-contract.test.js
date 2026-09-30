#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const esbuild = require('esbuild');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-nav-provider-'));
const bundle = path.join(temp, 'provider.cjs');

async function main() {
  esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src/gdsEditor.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle });
  const originalLoad = Module._load;
  const watcherObjects = [];
  try {
    Module._load = function (name, ...args) {
      if (name === 'vscode') return {
        window: { createTextEditorDecorationType: () => ({}), showErrorMessage() {} },
        OverviewRulerLane: { Right: 4 },
        workspace: {
          createFileSystemWatcher: () => { const watcher = { disposed: false, dispose() { this.disposed = true; } , onDidChange() {}, onDidCreate() {}, onDidDelete() {} }; watcherObjects.push(watcher); return watcher; },
          getConfiguration: () => ({ get: () => 120 }),
        },
        Uri: { file: (fsPath) => ({ fsPath }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
        RelativePattern: function (base, pattern) { this.base = base; this.pattern = pattern; },
      };
      return originalLoad.call(this, name, ...args);
    };
    const { GdsEditorProvider } = require(bundle);
    const values = new Map();
    const messages = [];
    const context = { extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(temp, 'storage') }, workspaceState: { get: (key) => values.get(key), update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); } } };
    const provider = new GdsEditorProvider(context, {}, { appendLine() {}, show() {} });
    const entry = { gdsPath: path.join(temp, 'chip.gds'), gdsHash: 'hash-a', loading: false, disposed: false, lastSelection: [], panel: { webview: { postMessage: async (message) => { messages.push(message); return true; } } } };
    const valid = [{ id: 'a', geometry: { type: 'Point', coordinates: [1, 2] } }];
    await provider.onMessage(entry, { type: 'saveAnnotations', layoutHash: 'hash-a', annotations: valid });
    assert.deepEqual(values.get('gdsNavigator.annotations.v1:' + entry.gdsPath.toLowerCase()), valid);
    assert(messages.some((m) => m.type === 'annotationsSaved'));
    messages.length = 0;
    await provider.onMessage(entry, { type: 'saveAnnotations', layoutHash: 'hash-a', annotations: [{ id: 'bad', geometry: { type: 'Point', coordinates: [NaN, 2] } }] });
    assert.deepEqual(values.get('gdsNavigator.annotations.v1:' + entry.gdsPath.toLowerCase()), valid);
    assert(messages.some((m) => m.type === 'annotationsSaveFailed'));
    messages.length = 0;
    await provider.onMessage(entry, { type: 'saveAnnotations', layoutHash: 'old-hash', annotations: [] });
    assert.deepEqual(values.get('gdsNavigator.annotations.v1:' + entry.gdsPath.toLowerCase()), valid);
    assert(messages.some((m) => m.type === 'annotationsSaveFailed'));
    messages.length = 0;
    entry.loading = true; entry.lastSelection = [{ provId: 'a', layer: '1/0', bbox: [0, 0, 1, 1], provenance: {} }];
    await provider.onMessage(entry, { type: 'exportYaml', layoutHash: 'hash-a', components: entry.lastSelection });
    assert(messages.some((m) => m.type === 'copyResult' && m.ok === false && /loading/.test(m.error)));
    provider.watchFile({ fsPath: entry.gdsPath });
    assert.equal(watcherObjects.length, 3);
    provider.dispose();
    assert(watcherObjects.every((watcher) => watcher.disposed), 'provider.dispose must release all file watchers');
    console.log(JSON.stringify({ status: 'passed', annotationSave: true, failurePreservesStore: true, staleCopyRejected: true, watchersDisposed: true }));
  } finally {
    Module._load = originalLoad;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
