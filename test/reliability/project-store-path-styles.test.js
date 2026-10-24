#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const REPORT_DIR = path.resolve(process.env.GDS_STORE_PATH_STYLE_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'project-store-path-styles'));
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-path-styles-')));
const projectRoot = path.join(fixture, 'Private Project Root');
const movedRoot = path.join(fixture, 'Private Project Moved');
const bundle = path.join(fixture, 'project-store.cjs');
const linksBundle = path.join(fixture, 'file-links.cjs');
const priorCwd = process.cwd();
const legacyMap = new Map();
const legacy = { keys: [], get: (key, fallback) => legacyMap.has(key) ? legacyMap.get(key) : fallback, update: async (key, value) => legacyMap.set(key, value) };
const foreign = {
  win: 'D:\\Design\\Chip.GDS',
  slash: 'D:/Design/Chip.GDS',
  unc: '\\\\server\\share\\Chip.GDS',
  script: 'D:\\Design\\Build.PY',
  image: 'D:/Design\\Photo.PNG',
};
const reportFile = path.join(REPORT_DIR, 'report.json');
function report(name, body) { fs.mkdirSync(REPORT_DIR, { recursive: true }); fs.writeFileSync(path.join(REPORT_DIR, name), `${JSON.stringify(body, null, 2)}\n`); }

let passed = false;
let result;
let observedDisk;
(async () => {
  try {
    fs.mkdirSync(projectRoot, { recursive: true });
    require('esbuild').buildSync({ entryPoints: [path.join(ROOT, 'src/projectStore.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
    require('esbuild').buildSync({ entryPoints: [path.join(ROOT, 'src/fileLinks.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: linksBundle });
    const { ProjectStore } = require(bundle);
    const links = require(linksBundle);
    process.chdir(projectRoot);
    assert.equal(process.cwd(), projectRoot, 'fixture cwd was not canonicalized');
    const posixNativeFilename = process.platform !== 'win32';
    const nativeRoot = path.join(projectRoot, 'Native');
    const nativeGds = path.join(nativeRoot, 'Chip.GDS');
    const nativeScript = path.join(nativeRoot, 'Build.PY');
    const nativeImage = path.join(nativeRoot, 'Photo.PNG');
    const nativeOdd = path.join(projectRoot, 'D:\\Design\\Chip.GDS');
    const ambiguous = process.platform === 'win32' ? path.join(path.sep, 'Project', 'Opaque.GDS') : '/' + path.join(projectRoot, 'Opaque.GDS');
    const externalNative = path.join(fixture, 'Outside', 'Outside.GDS');
    if (posixNativeFilename) fs.writeFileSync(nativeOdd, 'native-odd-fixture');
    const graph = links.linkScript(links.updateBuildLinks(undefined, foreign.script, [foreign.win, foreign.slash, foreign.unc]), foreign.win, foreign.script);
    const store = new ProjectStore(projectRoot, legacy);
    await store.ready();
    await store.update(`gdsNavigator.assoc:${foreign.win}`, foreign.script);
    await store.update('gdsNavigator.annotations.v1:foreign', { file: foreign.win, gdsPath: foreign.slash, imagePath: foreign.image, script: foreign.script, outputs: [foreign.unc] });
    await store.update(`gdsNavigator.opaque:${foreign.unc}`, { [foreign.win]: { opaque: foreign.unc } });
    await store.update('gdsNavigator.fileLinks.v1', graph);
    await store.update('gdsNavigator.native', { gdsPath: nativeGds, imagePath: nativeImage, geometry: { x: 4 }, pose: { angle: 7 }, metadata: { keep: true } });
    if (posixNativeFilename) await store.update('gdsNavigator.nativeOdd', { gdsPath: nativeOdd });
    await store.update('gdsNavigator.ambiguous', { imagePath: ambiguous });
    await store.update('gdsNavigator.externalNative', { gdsPath: externalNative });

    const projectFile = path.join(projectRoot, '.gds-navigator', 'project.json');
    const disk = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    observedDisk = disk;
    const annotations = disk.entries['gdsNavigator.annotations.v1:foreign'];
    assert.deepEqual(annotations, { file: foreign.win, gdsPath: foreign.slash, imagePath: foreign.image, script: foreign.script, outputs: [foreign.unc] }, 'foreign path fields were rewritten');
    assert(Object.prototype.hasOwnProperty.call(disk.entries, `gdsNavigator.assoc:${foreign.win}`), 'foreign association key was rewritten');
    assert(Object.prototype.hasOwnProperty.call(disk.entries, `gdsNavigator.opaque:${foreign.unc}`), 'opaque foreign key was rewritten');
    assert.deepEqual(disk.entries['gdsNavigator.fileLinks.v1'], graph, 'fileLinks graph was rewritten');
    assert.deepEqual(disk.entries['gdsNavigator.ambiguous'], { imagePath: ambiguous }, 'ambiguous rooted path was rewritten');
    assert.deepEqual(disk.entries['gdsNavigator.native'], { gdsPath: { $projectRelative: 'Native/Chip.GDS' }, imagePath: { $projectRelative: 'Native/Photo.PNG' }, geometry: { x: 4 }, pose: { angle: 7 }, metadata: { keep: true } }, 'native control was not encoded as a relative tag');

    const legacyDisk = { version: 1, entries: {
      ...disk.entries,
      'gdsNavigator.legacyForeign': { file: { $projectRelative: 'D:\\Design\\Chip.GDS' }, normal: { $projectRelative: 'Native/Chip.GDS' } },
      'gdsNavigator.assoc:@projectRelative/D:\\Design\\Chip.GDS': foreign.script,
    } };
    fs.writeFileSync(projectFile, `${JSON.stringify(legacyDisk, null, 2)}\n`);
    process.chdir(priorCwd);
    fs.renameSync(projectRoot, movedRoot);
    const movedNativeGds = path.join(movedRoot, 'Native', 'Chip.GDS');
    const movedNativeImage = path.join(movedRoot, 'Native', 'Photo.PNG');
    const reloaded = new ProjectStore(movedRoot, legacy);
    await reloaded.ready();
    assert.deepEqual(reloaded.get('gdsNavigator.annotations.v1:foreign'), annotations, 'foreign fields changed after reload');
    assert.equal(reloaded.get(`gdsNavigator.assoc:${foreign.win}`), foreign.script, 'foreign association changed after reload');
    assert.deepEqual(reloaded.get('gdsNavigator.fileLinks.v1'), graph, 'foreign fileLinks changed after reload');
    assert.deepEqual(reloaded.get('gdsNavigator.legacyForeign'), { file: path.resolve(movedRoot, 'D:\\Design\\Chip.GDS'), normal: path.join(movedRoot, 'Native/Chip.GDS') }, 'legacy relative tags changed');
    assert.equal(reloaded.get(`gdsNavigator.assoc:${path.resolve(movedRoot, 'D:\\Design\\Chip.GDS')}`), foreign.script, 'legacy @projectRelative key changed');
    assert.deepEqual(reloaded.get('gdsNavigator.native'), { gdsPath: movedNativeGds, imagePath: movedNativeImage, geometry: { x: 4 }, pose: { angle: 7 }, metadata: { keep: true } });
    if (posixNativeFilename) {
      const movedOdd = path.join(movedRoot, 'D:\\Design\\Chip.GDS');
      assert.equal(reloaded.get('gdsNavigator.nativeOdd').gdsPath, movedOdd, 'native POSIX filename did not relocate');
      assert.equal(fs.readFileSync(movedOdd, 'utf8'), 'native-odd-fixture', 'native POSIX filename fixture changed');
    }
    assert.equal(reloaded.get('gdsNavigator.externalNative').gdsPath, externalNative, 'native external path was relocated');
    assert.deepEqual(reloaded.get('gdsNavigator.ambiguous'), { imagePath: ambiguous }, 'ambiguous path changed after relocation');
    result = { status: 'passed', foreignPathStyles: ['drive-backslash', 'drive-slash', 'UNC'], publicFileLinks: true, nativeRelocation: true, externalNativePreserved: true, ambiguousPathPreserved: true, windowsExecution: process.platform === 'win32' ? 'native' : 'not-run', skipped: posixNativeFilename ? [] : ['POSIX-only native filename boundary'] };
    passed = true;
  } catch (error) {
    report('failure.json', { status: 'failed', error: String(error && error.stack || error), fixture, observedDisk, fixtureRetained: true });
    throw error;
  } finally {
    process.chdir(priorCwd);
    if (passed) {
      try { fs.rmSync(fixture, { recursive: true, force: true }); report('report.json', result); console.log(JSON.stringify({ ...result, report: reportFile })); }
      catch (error) { report('failure.json', { status: 'failed', error: `Owned cleanup failed: ${error.stack || error}`, fixture, fixtureRetained: true }); throw error; }
    }
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
