#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '../..');
const reportDir = path.resolve(process.env.GDS_STORE_WIN_PATH_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'project-store-win-paths'));
const bundle = esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src', 'projectStore.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;

function virtualStore() {
  const files = new Map();
  const vfs = { promises: {
    readFile: async (file, encoding) => { if (!files.has(file)) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; } return encoding ? files.get(file) : Buffer.from(files.get(file)); },
    writeFile: async (file, value) => files.set(file, String(value)),
    mkdir: async () => undefined,
    rename: async (from, to) => { if (!files.has(from)) throw new Error('missing temp'); files.set(to, files.get(from)); files.delete(from); },
    unlink: async (file) => { files.delete(file); },
  } };
  const module = { exports: {} };
  vm.runInNewContext(bundle, { module, exports: module.exports, require: (id) => id === 'fs' ? vfs : id === 'path' ? path.win32 : id === 'crypto' ? crypto : require(id), process: { ...process, cwd: () => 'C:\\Host' }, console, Buffer, setTimeout, clearTimeout });
  return { ProjectStore: module.exports.ProjectStore, files };
}

function legacy() { return { keys: [], get: (_key, fallback) => fallback, update: async () => undefined }; }
function disk(files, root) { return JSON.parse(files.get(path.win32.join(root, '.gds-navigator', 'project.json'))); }
function writeReport(result) { fs.mkdirSync(reportDir, { recursive: true }); fs.writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`); }

(async () => {
  const { ProjectStore, files } = virtualStore();
  const root = 'C:\\Project';
  const store = new ProjectStore(root, legacy()); await store.ready();
  await store.update('gdsNavigator.paths', { gdsPath: 'C:\\Project\\Layouts\\x.gds', imagePath: 'D:\\External\\image.png', outputs: ['D:\\External\\x.gds', '\\\\other\\share\\x.gds', '/Project/match.gds', '\\Project\\rooted.gds', 'D:foo'], external: 'D:\\External\\x.gds', unc: '\\\\other\\share\\x.gds', posix: '/Volumes/x', rooted: '\\Folder\\x', driveRelative: 'D:foo', unknown: { path: 'C:\\Project\\unknown' } });
  await store.update('gdsNavigator.assoc:C:\\Project\\Layouts\\x.gds', 'C:\\Project\\Build\\make.py');
  const saved = disk(files, root);
  assert.equal(saved.entries['gdsNavigator.paths'].gdsPath.$projectRelative, 'Layouts/x.gds');
  assert.equal(saved.entries['gdsNavigator.paths'].imagePath, 'D:\\External\\image.png');
  assert.deepEqual(saved.entries['gdsNavigator.paths'].outputs, ['D:\\External\\x.gds', '\\\\other\\share\\x.gds', '/Project/match.gds', '\\Project\\rooted.gds', 'D:foo']);
  assert.equal(saved.entries['gdsNavigator.paths'].external, 'D:\\External\\x.gds');
  assert.equal(saved.entries['gdsNavigator.paths'].unc, '\\\\other\\share\\x.gds');
  for (const key of ['posix', 'rooted', 'driveRelative']) assert.equal(saved.entries['gdsNavigator.paths'][key], { posix: '/Volumes/x', rooted: '\\Folder\\x', driveRelative: 'D:foo' }[key]);
  assert.equal(Object.keys(saved.entries).find((key) => key.includes('@projectRelative/Layouts/x.gds')), 'gdsNavigator.assoc:@projectRelative/Layouts/x.gds');
  await store.update('gdsNavigator.fileLinks.v1', { builds: { 'D:\\External\\make.py': { script: 'D:\\External\\make.py', outputs: ['D:\\External\\x.gds'] } } });
  assert.equal(disk(files, root).entries['gdsNavigator.fileLinks.v1'].builds['D:\\External\\make.py'].script, 'D:\\External\\make.py');
  const moved = 'C:\\Moved'; const oldFile = files.get(path.win32.join(root, '.gds-navigator', 'project.json')); files.delete(path.win32.join(root, '.gds-navigator', 'project.json')); files.set(path.win32.join(moved, '.gds-navigator', 'project.json'), oldFile);
  const reopened = new ProjectStore(moved, legacy()); await reopened.ready();
  assert.equal(reopened.get('gdsNavigator.paths').gdsPath, 'C:\\Moved\\Layouts\\x.gds');

  const uncRoot = '\\\\server\\share\\Project'; const uncStore = new ProjectStore(uncRoot, legacy()); await uncStore.ready();
  await uncStore.update('gdsNavigator.paths', { gdsPath: '\\\\server\\share\\Project\\x.gds', external: '\\\\other\\share\\x.gds' });
  const uncSaved = disk(files, uncRoot); assert.equal(uncSaved.entries['gdsNavigator.paths'].gdsPath.$projectRelative, 'x.gds'); assert.equal(uncSaved.entries['gdsNavigator.paths'].external, '\\\\other\\share\\x.gds');
  await uncStore.update('gdsNavigator.outputs', { outputs: ['\\\\server\\share\\Other\\outside.gds', '\\\\other\\share\\x.gds'] });
  assert.deepEqual(disk(files, uncRoot).entries['gdsNavigator.outputs'].outputs, ['\\\\server\\share\\Other\\outside.gds', '\\\\other\\share\\x.gds']);
  const legacyRoot = 'C:\\Legacy'; files.set(path.win32.join(legacyRoot, '.gds-navigator', 'project.json'), JSON.stringify({ version: 1, entries: { 'gdsNavigator.legacy': { $projectRelative: 'D:/x' } } }));
  const legacyStore = new ProjectStore(legacyRoot, legacy()); await legacyStore.ready(); assert.equal(legacyStore.get('gdsNavigator.legacy'), 'D:\\x');
  writeReport({ status: 'passed', virtualWindows: true, nativeDriveAndUNCRelocation: true, foreignAbsoluteOpacity: true, legacyTagDecode: 'unchanged-by-contract' });
  console.log(JSON.stringify({ status: 'passed', report: path.join(reportDir, 'report.json'), virtualWindows: true }));
})().catch((error) => { writeReport({ status: 'failed', error: String(error.stack || error), retained: true }); console.error(error.stack); process.exitCode = 1; });
