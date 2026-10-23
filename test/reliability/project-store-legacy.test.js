#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const reportDir = path.resolve(process.env.GDS_STORE_LEGACY_REPORT_DIR || path.join(root, 'logs', 'reliability', 'project-store-legacy'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-store-legacy-'));
const bundle = path.join(temp, 'project-store.cjs');
const source = process.env.GDS_STORE_LEGACY_BASELINE || path.join(root, 'src', 'projectStore.ts');
require('esbuild').buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { ProjectStore } = require(bundle);

const legacyMap = new Map();
const legacy = {
  keys: () => [...legacyMap.keys()],
  get: (key, fallback) => legacyMap.has(key) ? legacyMap.get(key) : fallback,
  update: async (key, value) => legacyMap.set(key, value),
};
const reportFile = path.join(reportDir, 'report.json');
function writeReport(name, value) { fs.mkdirSync(reportDir, { recursive: true }); fs.writeFileSync(path.join(reportDir, name), `${JSON.stringify(value, null, 2)}\n`); }

let passed = false;
let fixture;
let result;
(async () => {
  try {
    fixture = fs.mkdtempSync(path.join(temp, 'fixture-'));
    const projectRoot = path.join(fixture, 'MixedRootİΩ');
    const layout = path.join(projectRoot, 'CaseDir', 'Layout.GDS');
    const oldScript = path.join(projectRoot, 'Scripts', 'Old.PY');
    const newScript = path.join(projectRoot, 'Scripts', 'New.PY');
    fs.mkdirSync(path.dirname(layout), { recursive: true });
    fs.mkdirSync(path.dirname(newScript), { recursive: true });
    const lowerLayout = layout.toLowerCase();
    const assoc = `gdsNavigator.assoc:${lowerLayout}`;
    legacyMap.set(assoc, oldScript);
    legacyMap.set('gdsNavigator.legacyOnly', { retained: true });
    const legacyBefore = new Map(legacyMap);

    const store = new ProjectStore(projectRoot, legacy);
    await store.ready();
    await store.update(assoc, newScript);
    const reloaded = new ProjectStore(projectRoot, legacy);
    await reloaded.ready();
    assert.equal(reloaded.get(assoc), newScript, 'new disk association lost to stale exact legacy key');
    await reloaded.update('gdsNavigator.unrelated', 1);
    const afterUnrelated = new ProjectStore(projectRoot, legacy);
    await afterUnrelated.ready();
    assert.equal(afterUnrelated.get(assoc), newScript, 'unrelated save resurrected stale legacy association');
    assert.deepEqual(legacyMap, legacyBefore, 'legacy memento was mutated during project-store migration');
    assert.deepEqual(afterUnrelated.get('gdsNavigator.legacyOnly'), { retained: true }, 'missing legacy fallback stopped working');

    const duplicateRoot = path.join(fixture, 'DuplicateRootİΩ');
    const duplicateLayout = path.join(duplicateRoot, 'CaseDir', 'Layout.GDS');
    const duplicateLower = duplicateLayout.toLowerCase();
    const duplicateMixed = path.join(duplicateRoot, 'casedir', 'layout.gds');
    fs.mkdirSync(duplicateRoot, { recursive: true });
    const duplicateFile = path.join(duplicateRoot, '.gds-navigator', 'project.json');
    const duplicatePayload = { version: 1, entries: {
      [`gdsNavigator.assoc:${duplicateLower}`]: 'lower-conflict',
      [`gdsNavigator.assoc:${duplicateMixed}`]: 'mixed-conflict',
    } };
    fs.mkdirSync(path.dirname(duplicateFile), { recursive: true });
    const duplicateBytes = `${JSON.stringify(duplicatePayload, null, 2)}\n`;
    fs.writeFileSync(duplicateFile, duplicateBytes);
    const duplicateStore = new ProjectStore(duplicateRoot, legacy);
    await duplicateStore.ready();
    await assert.rejects(duplicateStore.update('gdsNavigator.unrelated', 2), /duplicate|conflict|ambiguous/i);
    assert.equal(fs.readFileSync(duplicateFile, 'utf8'), duplicateBytes, 'duplicate top-level conflict changed disk bytes');
    assert.equal(duplicateStore.get('gdsNavigator.unrelated'), undefined, 'failed duplicate save changed in-memory snapshot');

    const linksRoot = path.join(fixture, 'FileLinksRootİΩ');
    const linksScript = path.join(linksRoot, 'Scripts', 'Build.PY');
    const linksLower = linksScript.toLowerCase();
    const linksMixed = path.join(linksRoot, 'scripts', 'build.py');
    fs.mkdirSync(linksRoot, { recursive: true });
    const linksStore = new ProjectStore(linksRoot, legacy);
    await linksStore.ready();
    await linksStore.update('gdsNavigator.seed', true);
    const linksFile = path.join(linksRoot, '.gds-navigator', 'project.json');
    const linksBefore = fs.readFileSync(linksFile, 'utf8');
    const duplicateLinks = { builds: {
      [linksLower]: { script: linksScript, inputHash: 'hash-a' },
      [linksMixed]: { script: linksScript, inputHash: 'hash-b' },
    } };
    await assert.rejects(linksStore.update('gdsNavigator.fileLinks.v1', duplicateLinks), /duplicate|conflict|ambiguous/i);
    assert.equal(fs.readFileSync(linksFile, 'utf8'), linksBefore, 'duplicate fileLinks conflict changed disk bytes');
    assert.equal(linksStore.get('gdsNavigator.fileLinks.v1'), undefined, 'failed fileLinks save changed in-memory snapshot');

    passed = true;
    result = { status: 'passed', legacyPrecedence: true, legacyFallback: true, duplicateTopLevelGuard: true, duplicateFileLinksGuard: true, source };
  } catch (error) {
    writeReport('failure.json', { status: 'failed', error: String(error && error.stack || error), fixture, retained: true, source });
    throw error;
  } finally {
    if (passed) {
      try {
        fs.rmSync(temp, { recursive: true, force: true });
        writeReport('report.json', result);
        console.log(JSON.stringify({ ...result, report: reportFile }));
      } catch (error) {
        writeReport('failure.json', { status: 'failed', error: `Owned cleanup failed: ${error && error.stack || error}`, fixture, retained: true, source });
        throw error;
      }
    }
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
