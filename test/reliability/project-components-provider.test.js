#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const esbuild = require('esbuild');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const python = process.env.GDS_TEST_PYTHON || path.join(ROOT, '.venv-fork', 'Scripts', 'python.exe');
if (!fs.existsSync(python)) {
  console.log(JSON.stringify({ status: 'skipped', reason: 'fork Python unavailable' }));
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(ROOT, '.provider-components-'));
const workspace = path.join(temp, 'workspace');
const otherRoot = path.join(temp, 'other-root');
const standalone = path.join(temp, 'standalone');
const bundle = path.join(temp, 'gds-editor.cjs');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(otherRoot, { recursive: true });
fs.mkdirSync(standalone, { recursive: true });
const gdsPath = path.join(workspace, 'chip.gds');
const sentinel = path.join(workspace, 'untrusted-import.sentinel');
fs.writeFileSync(gdsPath, 'placeholder');
const registry = (marker, length) => [
  `from pathlib import Path`,
  `Path(${JSON.stringify(marker)}).write_text('imported', encoding='utf-8')`,
  `import gdsfactory as gf`,
  `def demo(length=${length}, width=1):`,
  `    return gf.components.straight(length=length, width=width)`,
  `COMPONENTS = {'demo': demo}`,
].join('\n');
fs.writeFileSync(path.join(workspace, 'gds_components.py'), registry(sentinel, 7));
fs.writeFileSync(path.join(otherRoot, 'gds_components.py'), registry(path.join(otherRoot, 'forged.sentinel'), 99));

let trusted = false;
let workspaceRoot;
const values = new Map();
const watcherObjects = [];
const vscode = {
  window: { createTextEditorDecorationType: () => ({}), showErrorMessage() {}, showWarningMessage() {} },
  OverviewRulerLane: { Right: 4 },
  workspace: {
    get isTrusted() { return trusted; },
    workspaceFolders: [],
    createFileSystemWatcher: () => { const watcher = { disposed: false, dispose() { this.disposed = true; } }; watcherObjects.push(watcher); return watcher; },
    getConfiguration: () => ({ get: () => true }),
    getWorkspaceFolder: (uri) => workspaceRoot && path.resolve(uri.fsPath).toLowerCase().startsWith((path.resolve(workspaceRoot) + path.sep).toLowerCase()) ? { uri: { fsPath: workspaceRoot } } : undefined,
  },
  Uri: { file: (fsPath) => ({ fsPath }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
  RelativePattern: function (base, pattern) { this.base = base; this.pattern = pattern; },
};

async function main() {
  esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src', 'gdsEditor.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle });
  const originalLoad = Module._load;
  try {
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    const { GdsEditorProvider } = require(bundle);
    const env = { ready: async () => {}, getPython: () => python, setActiveFile() {} };
    const context = { extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(temp, 'storage') }, workspaceState: { get: (key) => values.get(key), update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); } } };
    const provider = new GdsEditorProvider(context, env, { appendLine() {}, show() {} });
    const messages = [];
    const entry = { gdsPath, gdsHash: 'layout-hash', loading: false, disposed: false, lastSelection: [], panel: { webview: { postMessage: async (message) => { messages.push(message); return true; } } } };

    workspaceRoot = workspace;
    trusted = false;
    await provider.onMessage(entry, { type: 'requestComponentCatalog', requestId: 'untrusted' });
    const untrusted = messages.pop();
    assert.equal(untrusted.type, 'componentCatalog');
    assert(!untrusted.result.components.some((item) => item.name === 'project:demo'), 'untrusted catalog imported a project registry');
    assert(untrusted.result.warnings.some((warning) => /Trust this workspace/.test(warning)), 'untrusted catalog warning missing');
    assert(!fs.existsSync(sentinel), 'untrusted catalog executed the project registry');

    trusted = true;
    await provider.onMessage(entry, { type: 'requestComponentCatalog', requestId: 'trusted', projectRoot: otherRoot });
    const catalog = messages.pop();
    assert(catalog.result.components.some((item) => item.name === 'project:demo'), 'trusted catalog did not load the workspace registry');
    assert(!fs.existsSync(path.join(otherRoot, 'forged.sentinel')), 'catalog trusted a forged webview projectRoot');
    assert(fs.existsSync(sentinel), 'trusted catalog did not load the workspace registry');

    await provider.onMessage(entry, { type: 'previewComponent', requestId: 'preview', name: 'project:demo', settings: { length: 12, width: 2 }, projectRoot: otherRoot });
    const preview = messages.pop();
    assert.equal(preview.type, 'componentPreview');
    assert.equal(preview.result.library.exportName, 'demo');
    assert.equal(preview.result.name, 'project:demo');
    assert.deepEqual(preview.result.settings, { length: 12, width: 2 });
    assert(Array.isArray(preview.result.ports) && preview.result.ports.length >= 2, 'custom preview ports missing');

    await provider.onMessage(entry, { type: 'previewComponent', requestId: 'forged', name: 'project:forged', settings: {} , projectRoot: otherRoot });
    assert.equal(messages.pop().type, 'componentError', 'forged root unexpectedly supplied a component');

    workspaceRoot = undefined;
    await provider.onMessage({ ...entry, gdsPath: path.join(standalone, 'standalone.gds') }, { type: 'requestComponentCatalog', requestId: 'standalone' });
    const standaloneCatalog = messages.pop();
    assert(!standaloneCatalog.result.components.some((item) => item.name.startsWith('project:')), 'standalone catalog loaded project components');
    console.log(JSON.stringify({ status: 'passed', trustGate: true, workspaceRootBound: true, forgedRootIgnored: true, standaloneBuiltinOnly: true, previewPayload: true }));
  } finally {
    Module._load = originalLoad;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
