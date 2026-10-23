#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const REPORT_DIR = path.resolve(process.env.GDS_STORE_RELOCATION_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'project-store-relocation'));
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-store-relocation-bundle-'));
const bundle = path.join(bundleDir, 'project-store.cjs');
require('esbuild').buildSync({ entryPoints: [path.join(ROOT, 'src/projectStore.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { ProjectStore } = require(bundle);

const legacyMap = new Map([['gdsNavigator.legacy', { retained: true }]]);
const legacy = {
  keys: ['gdsNavigator.legacy'],
  get: (key, fallback) => legacyMap.has(key) ? legacyMap.get(key) : fallback,
  update: async (key, value) => legacyMap.set(key, value),
};

const report = {
  status: 'running',
  capabilities: {
    mixedCaseUnicodeRoot: true,
    lowercasedLogicalAssociationKeys: true,
    annotationsV1: true,
    alignmentKeys: true,
    casePreservingRelativeTail: true,
    externalAbsoluteValuesAndKeys: true,
    legacyExactKeys: true,
    unknownFields: true,
    malformedAndConcurrentGuards: true,
  },
  skipped: [],
  limitations: ['Case-folded namespace identity cannot distinguish case-only sibling logical keys; this contract does not guess between them.'],
};

let fixture;
let retained = false;
let succeeded = false;
let originalRoot;
let movedRoot;
function writeReport(name, body) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, name), `${JSON.stringify(body, null, 2)}\n`);
}

(async () => {
  try {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'GDS-Δ-Project-'));
    originalRoot = path.join(fixture, 'Workspace-CaseİΩ');
    fs.mkdirSync(originalRoot, { recursive: true });
    const layout = path.join(originalRoot, 'CaseDir', 'Ünicode', 'Layout File.GDS');
    const image = path.join(originalRoot, 'Images', 'MicroScope.PNG');
    const script = path.join(originalRoot, 'Build Scripts', 'Make.PY');
    const mixedLayout = path.join(originalRoot, 'CaseDir', 'Ünicode', 'Mixed Layout.GDS');
    fs.mkdirSync(path.dirname(layout), { recursive: true });
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(layout, 'gds'); fs.writeFileSync(mixedLayout, 'gds'); fs.writeFileSync(image, 'image'); fs.writeFileSync(script, 'script');

    const lowerLayout = layout.toLowerCase();
    const lowerAssoc = `gdsNavigator.assoc:${lowerLayout}`;
    const lowerAnnotations = `gdsNavigator.annotations.v1:${lowerLayout}`;
    const lowerAlignment = `gdsNavigator.alignment:${lowerLayout}`;
    const mixedAssoc = `gdsNavigator.assoc:${mixedLayout}`;
    const externalRoot = `${originalRoot}-sibling`;
    const externalPath = path.join(externalRoot, 'Outside.GDS');
    const parentOutside = path.join(path.dirname(originalRoot), 'outside', 'Parent.GDS');
    const prefixSibling = path.join(path.dirname(originalRoot), `${path.basename(originalRoot)}2`, 'PrefixSibling.GDS');
    const nativeLexicalCaseDistinction = process.platform !== 'win32';
    const preservationRoot = nativeLexicalCaseDistinction ? originalRoot.toLowerCase() : `${originalRoot}-case-outside`;
    report.platform = { nativeLexicalCaseDistinction, posixCaseOnlyBranchCovered: nativeLexicalCaseDistinction };
    if (!nativeLexicalCaseDistinction) report.skipped.push('POSIX-only case-only outside branch is not covered on native Windows paths');
    const caseOnlyOutside = path.join(preservationRoot, 'CaseOnlyOther', 'Outside.GDS');
    const opaqueKey = `gdsNavigator.opaque:${path.join(preservationRoot, 'CaseOnlyOther', 'opaque.json')}`;
    const unknownNamespaceKey = `gdsNavigator.reviewState:${path.join(preservationRoot, 'Review', 'state.json')}`;
    const alignment = {
      version: 2,
      gdsHash: 'gds-hash',
      images: [{ imagePath: image, imageHash: 'image-hash', gdsHash: 'gds-hash', state: { cx: 12.5, cy: -3.25, umPerPx: 0.001, rotDeg: 17.5, opacity: 0.6, visible: true, unknown: 'state' } }],
    };
    const geometry = { type: 'Polygon', coordinates: [[[0.125, -2.5], [10.75, -2.5], [10.75, 4.625], [0.125, -2.5]]] };

    const store = new ProjectStore(originalRoot, legacy);
    await store.ready();
    await store.update(lowerAssoc, script);
    await store.update(mixedAssoc, script);
    await store.update(lowerAnnotations, [{
      gdsPath: layout,
      imagePath: image,
      geometry,
      unknownField: { preserved: true, sourcePath: layout },
    }]);
    await store.update(lowerAlignment, alignment);
    await store.update('gdsNavigator.externalValue', { gdsPath: externalPath, imagePath: parentOutside });
    await store.update(`gdsNavigator.assoc:${externalPath}`, script);
    await store.update(`gdsNavigator.assoc:${path.join(originalRoot, '..', 'outside', 'Parent.GDS')}`, script);
    await store.update(`gdsNavigator.assoc:${originalRoot}`, script);
    await store.update(`gdsNavigator.assoc:${prefixSibling}`, script);
    await store.update('gdsNavigator.caseOnlyExternalValue', { gdsPath: caseOnlyOutside });
    await store.update(opaqueKey, { opaque: true });
    await store.update(unknownNamespaceKey, { path: layout, retained: 'lexical' });

    const projectFile = path.join(originalRoot, '.gds-navigator', 'project.json');
    const onDisk = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    const entryKeys = Object.keys(onDisk.entries);
    assert(entryKeys.some((key) => key.includes('@projectRelative/CaseDir/Ünicode/Mixed Layout.GDS')), 'mixed-case key tail was not preserved');
    assert.equal(onDisk.entries[`gdsNavigator.assoc:${externalPath}`].$projectRelative, 'Build Scripts/Make.PY', 'sibling external key was rewritten');
    assert.equal(onDisk.entries[`gdsNavigator.assoc:${path.join(originalRoot, '..', 'outside', 'Parent.GDS')}`].$projectRelative, 'Build Scripts/Make.PY', 'parent external key was rewritten');
    assert.equal(onDisk.entries[`gdsNavigator.assoc:${originalRoot}`].$projectRelative, 'Build Scripts/Make.PY', 'root-equal key value was not encoded');
    assert.equal(onDisk.entries[`gdsNavigator.assoc:${prefixSibling}`].$projectRelative, 'Build Scripts/Make.PY', 'prefix sibling key value was not encoded');
    assert.equal(onDisk.entries['gdsNavigator.externalValue'].gdsPath, externalPath, 'external value was rewritten');
    assert.equal(onDisk.entries['gdsNavigator.caseOnlyExternalValue'].gdsPath, caseOnlyOutside, 'case-only external value was rewritten');
    assert.deepEqual(onDisk.entries[opaqueKey], { opaque: true }, 'opaque absolute property key was rewritten');
    assert.deepEqual(onDisk.entries[unknownNamespaceKey], { path: layout, retained: 'lexical' }, 'unknown namespace key was rewritten');

    // Exact-key documents written by older versions remain readable.
    onDisk.entries[`gdsNavigator.oldExact:${layout}`] = { retained: 'old-format' };
    fs.writeFileSync(projectFile, `${JSON.stringify(onDisk, null, 2)}\n`);
    const oldFormat = new ProjectStore(originalRoot, legacy);
    await oldFormat.ready();
    assert.deepEqual(oldFormat.get(`gdsNavigator.oldExact:${layout}`), { retained: 'old-format' });

    movedRoot = path.join(fixture, 'Workspace-MovedİΩ');
    fs.renameSync(originalRoot, movedRoot);
    const moved = new ProjectStore(movedRoot, legacy);
    await moved.ready();
    const movedLayout = path.join(movedRoot, 'CaseDir', 'Ünicode', 'Layout File.GDS');
    const movedMixedLayout = path.join(movedRoot, 'CaseDir', 'Ünicode', 'Mixed Layout.GDS');
    const movedImage = path.join(movedRoot, 'Images', 'MicroScope.PNG');
    const movedScript = path.join(movedRoot, 'Build Scripts', 'Make.PY');
    assert.equal(moved.get(`gdsNavigator.assoc:${movedLayout.toLowerCase()}`), movedScript);
    assert.equal(moved.get(`gdsNavigator.assoc:${movedMixedLayout}`), movedScript);
    assert.deepEqual(moved.get(`gdsNavigator.annotations.v1:${movedLayout.toLowerCase()}`), [{
      gdsPath: movedLayout,
      imagePath: movedImage,
      geometry,
      unknownField: { preserved: true, sourcePath: layout },
    }]);
    assert.deepEqual(moved.get(`gdsNavigator.alignment:${movedLayout.toLowerCase()}`), {
      ...alignment,
      images: [{ ...alignment.images[0], imagePath: movedImage }],
    });
    assert.equal(moved.get('gdsNavigator.externalValue').gdsPath, externalPath);
    assert.equal(moved.get(`gdsNavigator.assoc:${externalPath}`), movedScript);
    assert.equal(moved.get(`gdsNavigator.assoc:${path.join(originalRoot, '..', 'outside', 'Parent.GDS')}`), movedScript);
    assert.equal(moved.get(`gdsNavigator.assoc:${originalRoot}`), movedScript);
    assert.equal(moved.get(`gdsNavigator.assoc:${prefixSibling}`), movedScript);
    assert.equal(moved.get('gdsNavigator.caseOnlyExternalValue').gdsPath, caseOnlyOutside);
    assert.deepEqual(moved.get(opaqueKey), { opaque: true });
    assert.deepEqual(moved.get(unknownNamespaceKey), { path: layout, retained: 'lexical' });
    assert.deepEqual(moved.get('gdsNavigator.legacy'), { retained: true });

    // Preserve the existing concurrent-writer and malformed-document protections.
    const first = new ProjectStore(movedRoot, legacy); const second = new ProjectStore(movedRoot, legacy);
    await first.ready(); await second.ready();
    await first.update('gdsNavigator.concurrent.a', 1);
    await assert.rejects(second.update('gdsNavigator.concurrent.b', 2), /changed externally/);
    const malformedFile = path.join(movedRoot, '.gds-navigator', 'project.json');
    fs.writeFileSync(malformedFile, '{bad');
    const malformed = new ProjectStore(movedRoot, legacy);
    await malformed.ready();
    assert.equal(malformed.get('gdsNavigator.legacy').retained, true);
    await assert.rejects(malformed.update('gdsNavigator.malformed', 1), /malformed/);
    assert.match(malformed.warning, /malformed/);

    succeeded = true;
  } catch (error) {
    retained = true;
    report.status = 'failed';
    report.error = String(error && error.stack || error);
    report.fixture = { root: fixture, originalRoot, movedRoot, retained: true };
    writeReport('failure.json', report);
    console.error(JSON.stringify({ status: report.status, report: path.join(REPORT_DIR, 'failure.json'), fixture }, null, 2));
    throw error;
  } finally {
    if (succeeded && !retained) {
      try {
        if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
        fs.rmSync(bundleDir, { recursive: true, force: true });
        report.status = 'passed';
        report.fixture = { originalRoot, movedRoot, retained: false };
        writeReport('report.json', report);
        console.log(JSON.stringify({ status: report.status, report: path.join(REPORT_DIR, 'report.json'), skipped: report.skipped.length }));
      } catch (cleanupError) {
        retained = true;
        report.status = 'failed';
        report.error = `Successful checks completed, but owned cleanup failed: ${cleanupError && cleanupError.stack || cleanupError}`;
        report.fixture = { root: fixture, originalRoot, movedRoot, retained: true };
        writeReport('failure.json', report);
        console.error(JSON.stringify({ status: report.status, report: path.join(REPORT_DIR, 'failure.json'), fixture }, null, 2));
        process.exitCode = 1;
      }
    }
  }
})().catch(() => { process.exitCode = 1; });
