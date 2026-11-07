#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function scenario(failure) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-extension-environment-'));
  const h = { env: gate(), editor: gate(), envStops: 0, editorStops: 0 };
  globalThis.__gdsEnvironmentShutdown = h;
  const originalLoad = Module._load;
  let stopping;
  try {
    const bundle = path.join(temp, 'extension.cjs');
    await esbuild.build({ entryPoints: [path.join(root, 'src/extension.ts')], outfile: bundle,
      bundle: true, platform: 'node', format: 'cjs', external: ['vscode'],
      plugins: [{ name: 'environment-lifecycle-leaves', setup(build) {
        build.onResolve({ filter: /^\.\/(envProvider|gdsEditor|gdsSidebar|starterProject)$/ }, args => ({ path: args.path, namespace: 'lifecycle' }));
        build.onLoad({ filter: /.*/, namespace: 'lifecycle' }, args => ({ loader: 'js', contents: {
          './envProvider': `exports.EnvProvider=class { constructor(){globalThis.__gdsEnvironmentShutdown.environment=this} ready(){return Promise.resolve()} shutdown(){const h=globalThis.__gdsEnvironmentShutdown;h.envStops++;return h.env.promise} dispose(){this.shutdown()} };`,
          './gdsEditor': `exports.GdsEditorProvider=class { static viewType='gds'; shutdown(){const h=globalThis.__gdsEnvironmentShutdown;h.editorStops++;return h.editor.promise} };`,
          './gdsSidebar': 'exports.GdsSidebarProvider=class {};',
          './starterProject': 'module.exports={};',
        }[args.path] }));
      } }],
    });
    const disposable = () => ({ dispose() {} });
    const vscode = { window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      registerCustomEditorProvider: disposable, registerTreeDataProvider: disposable },
      commands: { registerCommand: disposable } };
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    const extension = require(bundle);
    const context = { subscriptions: [] };
    extension.activate(context);
    stopping = extension.deactivate();
    void stopping.catch(() => {});
    assert.equal(h.envStops, 1, 'deactivation must start environment shutdown');
    assert.equal(h.editorStops, 1, 'deactivation must start editor shutdown without waiting for environment cleanup');
    if (failure === 'editor') h.editor.reject(new Error('editor cleanup failed'));
    else h.editor.resolve();
    let settled = false;
    stopping.then(() => { settled = true; }, () => { settled = true; });
    await tick();
    assert.equal(settled, false, 'deactivation must drain environment discovery even when editor shutdown fails');
    if (failure === 'environment') h.env.reject(new Error('environment cleanup failed'));
    else h.env.resolve();
    if (failure) await assert.rejects(stopping, new RegExp(`${failure} cleanup failed`));
    else await stopping;
    await extension.deactivate();
    assert.equal(h.envStops, 1, 'deactivated environment must be released');
    assert.equal(h.editorStops, 1, 'deactivated editor must be released');
    assert(context.subscriptions.includes(h.environment), 'synchronous disposal must also own the environment');
  } finally {
    h.env.resolve(); h.editor.resolve();
    await stopping?.catch(() => {});
    Module._load = originalLoad;
    delete globalThis.__gdsEnvironmentShutdown;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

(async () => {
  for (const failure of [undefined, 'environment', 'editor']) await scenario(failure);
  console.log(JSON.stringify({ status: 'passed', parallelDrain: true, bothFailurePaths: true, terminal: true, disposal: true }));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
