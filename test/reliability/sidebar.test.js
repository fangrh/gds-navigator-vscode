#!/usr/bin/env node
'use strict';

// Contract-level tests for the Activity Bar provider.  The vscode host is
// intentionally replaced with a small mock so this remains runnable on CI.
const assert = require('assert/strict');
const esbuild = require('esbuild');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-sidebar-'));
const bundle = path.join(temp, 'sidebar.cjs');

class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

function uri(fsPath) { return { fsPath, path: fsPath.replaceAll(path.sep, '/'), toString: () => fsPath }; }

function allFiles(root) {
  const result = [];
  for (const name of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, name.name);
    if (name.isDirectory()) result.push(...allFiles(full));
    else result.push(full);
  }
  return result;
}

async function main() {
  fs.mkdirSync(path.join(temp, 'cells'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'top.gds'), 'top');
  fs.writeFileSync(path.join(temp, 'cells', 'nested.gds'), 'nested');
  for (let i = 0; i < 525; i += 1) fs.writeFileSync(path.join(temp, `layout-${i}.gds`), 'layout');

  const watcherCreate = new EventEmitter();
  const watcherDelete = new EventEmitter();
  const watcher = { onDidCreate: (listener) => watcherCreate.event(listener), onDidDelete: (listener) => watcherDelete.event(listener), dispose() { this.disposed = true; } };
  const changed = new EventEmitter();
  let findFilesCalls = 0;
  let deferNextFindFiles = false;
  let releaseDeferredFindFiles;
  let rejectNextFindFiles = false;
  const vscode = {
    EventEmitter,
    TreeItem: class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    FileType: { File: 1, Directory: 2 },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    workspace: {
      workspaceFolders: [{ uri: uri(temp) }],
      createFileSystemWatcher: () => watcher,
      findFiles: async (_include, _exclude, maxResults) => {
        findFilesCalls += 1;
        if (rejectNextFindFiles) {
          rejectNextFindFiles = false;
          throw new Error('synthetic findFiles failure');
        }
        const result = allFiles(temp).filter((file) => file.toLowerCase().endsWith('.gds')).slice(0, maxResults).map(uri);
        if (deferNextFindFiles) {
          deferNextFindFiles = false;
          return new Promise((resolve) => { releaseDeferredFindFiles = () => resolve(result); });
        }
        return result;
      },
      asRelativePath: (value) => path.relative(temp, value.fsPath),
      onDidChangeWorkspaceFolders: (listener) => changed.event(listener),
      fs: { readDirectory: async (folder) => fs.readdirSync(folder.fsPath, { withFileTypes: true }).map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]) },
    },
    commands: { executeCommand: async (...args) => { vscode.executed.push(args); }, registerCommand: () => ({ dispose() {} }) },
    executed: [],
  };

  esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src/gdsSidebar.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle });
  const originalLoad = Module._load;
  try {
    Module._load = function load(name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    const { GdsSidebarProvider } = require(bundle);
    assert.equal(typeof GdsSidebarProvider, 'function');
    const provider = new GdsSidebarProvider();
    const roots = await provider.getChildren();
    assert(roots.length > 0, 'sidebar should expose workspace actions');
    const filesRoot = roots.find((item) => String(item.label) === 'GDS Files');
    assert(filesRoot, 'sidebar should expose a GDS files group');
    const files = await provider.getChildren(filesRoot);
    assert(files.length <= 501, 'file listing must remain bounded and may include one truncation row');
    assert(files.some(item => String(item.label).includes('Showing first 500')), 'truncated projects should be disclosed');
    assert.equal(findFilesCalls, 1, 'initial file query should scan the workspace once');
    const repeatedFiles = await provider.getChildren(filesRoot);
    assert.strictEqual(repeatedFiles, files, 'repeated file queries should reuse the cached tree nodes');
    assert.equal(findFilesCalls, 1, 'repeated file queries should not rescan the workspace');
    const nested = files.find((item) => /nested\.gds$/i.test(String(item.label)));
    assert(nested && /cells/i.test(String(nested.description)), 'file nodes should preserve folder context');

    const file = files.find((item) => /\.gds$/i.test(String(item.label)));
    assert(file, 'sidebar should expose a GDS file node');
    const treeItem = provider.getTreeItem(file);
    assert(treeItem.command, 'GDS file node should be actionable');
    assert.equal(treeItem.command.command, 'vscode.openWith');
    assert(treeItem.command.arguments?.some((argument) => /gdsNavigator\.viewer/.test(String(argument))), 'file action should target the custom editor');

    let refreshes = 0;
    const subscription = provider.onDidChangeTreeData?.(() => { refreshes += 1; });
    watcherCreate.fire(uri(path.join(temp, 'top.gds')));
    assert(refreshes > 0, 'GDS watcher changes should refresh the tree');
    const refreshedFiles = await provider.getChildren(filesRoot);
    assert.notStrictEqual(refreshedFiles, files, 'watcher refresh should invalidate cached file nodes');
    assert.equal(findFilesCalls, 2, 'watcher refresh should trigger one new workspace scan');

    deferNextFindFiles = true;
    provider.refresh();
    const staleScan = provider.getChildren(filesRoot);
    provider.refresh();
    releaseDeferredFindFiles();
    await staleScan;
    await provider.getChildren(filesRoot);
    assert.equal(findFilesCalls, 4, 'a stale in-flight scan must not repopulate the post-refresh cache');

    provider.refresh();
    rejectNextFindFiles = true;
    await assert.rejects(() => provider.getChildren(filesRoot), /synthetic findFiles failure/);
    await provider.getChildren(filesRoot);
    assert.equal(findFilesCalls, 6, 'a rejected scan must be cleared so the next query can retry');
    subscription?.dispose();

    const hasSetupAction = roots.some((item) => /setup|initialize/i.test(String(item.label)) || /setup|initialize/i.test(String(item.command?.command || '')));
    assert(hasSetupAction, 'sidebar should expose a setup or initialize action');
    provider.dispose();
    assert.equal(watcher.disposed, true, 'dispose should release the file watcher');
    console.log(JSON.stringify({ status: 'passed', bounded: true, cachedQueries: true, folderContext: true, customEditorCommand: true, watcherRefresh: true, setupAction: true }));
  } finally {
    Module._load = originalLoad;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
