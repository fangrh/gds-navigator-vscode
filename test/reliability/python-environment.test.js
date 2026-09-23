#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const esbuild = require('esbuild');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.resolve(__dirname, '../..');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-env-')), 'env.cjs');
const config = { gdsNavigator: '', python: '' };
const subscriptions = [];
const vscode = {
  StatusBarAlignment: { Left: 1 }, ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3 }, Uri:{file:fsPath=>({fsPath})},
  window: { createStatusBarItem() { return { show() {}, dispose() {} }; }, showQuickPick: async () => undefined, showInformationMessage() {}, showErrorMessage() {} },
  workspace: { workspaceFolders: [{ uri: { fsPath: path.join(root, '.missing-workspace') } }], getConfiguration(section) { return { get: (_k, fallback) => config[section] || fallback, update: async (_k, v) => { config[section] = v || ''; } }; }, onDidChangeConfiguration() { const x = { dispose() {} }; subscriptions.push(x); return x; } },
};
esbuild.buildSync({ entryPoints: [path.join(root, 'src/envProvider.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: out });
const load = Module._load; Module._load = (name, ...args) => name === 'vscode' ? vscode : load.call(Module, name, ...args);
const { EnvProvider, pythonInPrefix, inspectPython } = require(out); Module._load = load;
const values = new Map();
const context = { workspaceState: { get: (k) => values.get(k), update: async (k, v) => { if (v === undefined) values.delete(k); else values.set(k, v); } }, subscriptions };
async function main() {
  let probes = 0;
  const provider = new EnvProvider(context, { discover: async () => ['bad', 'good'], probe: async (p) => { probes++; await new Promise(r => setTimeout(r, 2)); return p === 'good' ? { executable: p, gdsfactory: { path: '/fork/gdsfactory/__init__.py' }, klayout: { path: '/klayout/db.py' }, provenance: { available: true } } : { executable: p, error: 'broken' }; } });
  const a = provider.ready(); const b = provider.ready(); assert.strictEqual(a, b, 'ready must be single-flight'); await a; assert.equal(provider.getPython(), 'good'); assert.equal(probes, 2);
  await provider.ready(); assert.equal(probes, 2, 'completed discovery must be cached');
  values.set('gdsNavigator.pythonPath', 'manual'); assert.equal(provider.getPython(), 'manual', 'picked path overrides automatic');
  config.gdsNavigator = 'configured'; assert.equal(provider.getPython(), 'configured', 'configuration overrides picked path');
  await provider.setPython('new-manual'); assert.equal(provider.getPython(), 'new-manual', 'new manual choice overrides existing configuration');
  assert.equal(config.gdsNavigator, 'new-manual');
  await provider.clearManualSelection(); assert.equal(provider.getPython(), 'good', 'automatic picker restores detection');
  let release;
  const delayed = new EnvProvider(context, { discover: async()=>['late'], probe:()=>new Promise(r=>release=r) });
  const pending=delayed.ready(); await new Promise(r=>setImmediate(r));
  await delayed.setPython('user-choice');
  release({executable:'late',gdsfactory:{path:'gf'},klayout:{path:'db'},provenance:{available:true}});
  await pending; assert.equal(delayed.getPython(),'user-choice','late auto must not replace manual choice');
  config.gdsNavigator=''; values.clear();
  let failures=0;
  const unavailable=new EnvProvider(context,{discover:async()=>['broken'],probe:async()=>{failures++;return {executable:'broken',error:'bad'};}});
  await unavailable.ready(); await unavailable.ready(); assert.equal(failures,1,'failed scan is bounded and cached');
  const fallback=new EnvProvider(context,{discover:async()=>['viewer'],probe:async()=>({executable:'viewer',klayout:{path:'db'},provenance:{available:false}})});
  await fallback.ready(); assert.equal(fallback.getPython(),'viewer','KLayout-only viewing remains possible');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'gds-prefix-'));
  if(process.platform==='win32') {
    fs.mkdirSync(path.join(temp,'Scripts'));fs.writeFileSync(path.join(temp,'Scripts/python.exe'),'');
    assert.equal(pythonInPrefix(temp),path.join(temp,'Scripts/python.exe'));
  }
  const real=path.join(root,'.venv-fork',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(fs.existsSync(real)) { const d=await inspectPython(real); assert.equal(d.provenance?.available,true);assert(d.klayout?.path);assert(!d.error); }
  const missing=await inspectPython(path.join(temp,'missing-python'));assert(missing.error);
  // First GDS open: accept checked runtime once; subsequent opens retain folder default.
  values.clear();config.gdsNavigator='';
  const project=fs.mkdtempSync(path.join(os.tmpdir(),'gds-onboarding-')),file=path.join(project,'chip.gds');
  const scoped=new Map();
  vscode.workspace.workspaceFolders=[{uri:{fsPath:project}}];
  vscode.workspace.getWorkspaceFolder=uri=>uri.fsPath.startsWith(project)?{uri:{fsPath:project}}:undefined;
  vscode.workspace.getConfiguration=(section,resource)=>({inspect:()=>({}),get:(key,fallback)=>scoped.get(section+':'+key+':'+(resource?project:''))??fallback,update:async(key,v)=>scoped.set(section+':'+key+':'+(resource?project:''),v)});
  let prompts=0;
  vscode.window.showInformationMessage=async text=>{if(text.startsWith('Set up GDS Python')){prompts++;return 'Use this environment';}};
  const checked={executable:process.execPath,gdsfactory:{path:'checked/fork'},klayout:{path:'checked/db'},provenance:{available:true}};
  const onboarding=new EnvProvider(context,{discover:async()=>[process.execPath],probe:async()=>checked});
  await Promise.all([onboarding.setupProject(file),onboarding.setupProject(file)]);
  assert.equal(prompts,1);assert.equal(onboarding.getPython(file),process.execPath);
  assert(fs.existsSync(path.join(project,'gds-python.cmd')));assert(fs.existsSync(path.join(project,'AGENTS.md')));
  assert.equal(scoped.get('gdsNavigator:pythonPath:'+project),process.execPath);
  assert.equal(scoped.get('python:defaultInterpreterPath:'+project),process.execPath);
  const reopened=new EnvProvider(context,{discover:async()=>[],probe:async()=>checked});
  await reopened.setupProject(file);assert.equal(prompts,1,'valid saved setup must not prompt on reopen');
  const setupMenus=[];
  vscode.window.showQuickPick=async items=>{setupMenus.push(items.map(item=>item.action));return items.find(item=>item.action==='current'||item.action==='none');};
  await reopened.setupProject(file,true);
  assert.deepEqual(setupMenus.map(menu=>menu.includes('current')||menu.includes('none')),[true,true]);
  assert.equal(require(path.join(project,'.gds-navigator/environment.json')).version,2);
  const otherProject=fs.mkdtempSync(path.join(os.tmpdir(),'gds-onboarding-declined-'));
  vscode.window.showInformationMessage=async()=> 'Not now';
  await reopened.setupProject(path.join(otherProject,'chip.gds'));
  assert(!fs.existsSync(path.join(otherProject,'AGENTS.md')),'declined setup must not write agent files');
  console.log(JSON.stringify({ status: 'passed', singleFlight: true, priority: true, autoRestore: true, manualRace:true, cache:true, windowsVenv:true, diagnostics:true }));
}
main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
