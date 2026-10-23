#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-file-links-'));
const storeBundle = path.join(temp, 'project-store.js');
const linksBundle = path.join(temp, 'file-links.js');
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/projectStore.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: storeBundle });
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/fileLinks.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: linksBundle });
const { ProjectStore } = require(storeBundle);
const links = require(linksBundle);

const legacyMap = new Map();
const legacy = { keys: [], get: (key, fallback) => legacyMap.has(key) ? legacyMap.get(key) : fallback, update: async (key, value) => legacyMap.set(key, value) };
const rootPath = path.join(temp, 'MixedRoot');
const gds = path.join(rootPath, 'Layouts', 'Chip.GDS');
const script = path.join(rootPath, 'Scripts', 'Build.PY');
const explicitScript = path.join(rootPath, 'Scripts', 'Explicit.PY');
const output = path.join(rootPath, 'Layouts', 'Chip.GDS');
const externalScript = path.join(path.dirname(rootPath), 'MixedRootSibling', 'Build.PY');
const externalGds = path.join(path.dirname(rootPath), 'MixedRootSibling', 'Chip.GDS');
// These paths are intentionally nonexistent case-only siblings on POSIX. A
// folded string appears under rootPath, but native lexical containment says
// they are outside and they must remain absolute.
const posixCaseBoundary = process.platform !== 'win32';
const caseExternalBase = posixCaseBoundary ? rootPath.toLowerCase() : rootPath + '-case-external';
const upperExternalBase = posixCaseBoundary ? path.join(path.dirname(rootPath), path.basename(rootPath).toUpperCase()) : rootPath + '-upper-external';
const externalCaseScript = path.join(caseExternalBase, 'External.PY');
const externalCaseGds = path.join(caseExternalBase, 'External.GDS');
const externalUpperScript = path.join(upperExternalBase, 'Other.PY');
const externalUpperGds = path.join(upperExternalBase, 'Other.GDS');
const reportDir = process.env.GDS_STORE_LINKS_REPORT_DIR || path.join(root, 'logs', 'store-contract');
const reportFile = path.join(reportDir, 'project-store-file-links.json');

function writeReport(payload) {
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

(async () => {
  let passed = false;
  let ownedLowerRoot;
  let successResult;
  try {
    fs.mkdirSync(rootPath, { recursive: true });
    const graph = links.updateBuildLinks(undefined, script, [output]);
    const withExplicit = links.linkScript(graph, gds, explicitScript);
    const withExternal = links.updateBuildLinks(withExplicit, externalScript, [externalGds]);
    const withCaseExternal = links.updateBuildLinks(withExternal, externalCaseScript, [externalCaseGds]);
    const allLinks = links.updateBuildLinks(withCaseExternal, externalUpperScript, [externalUpperGds]);
    // This is outside by native lexical containment, despite folding to a
    // root-internal spelling. Its key must stay absolute and exact.
    const opaqueBase = posixCaseBoundary ? rootPath.toLowerCase() : rootPath + '-opaque-external';
    const opaqueKey = path.join(opaqueBase, 'Opaque.Key');
    const opaqueBuildsKey = path.join(opaqueBase, 'Opaque.Builds');
    const metadataValue = path.join(rootPath, 'Metadata', 'Opaque.Value');
    const store = new ProjectStore(rootPath, legacy);
    await store.ready();
    await store.update('gdsNavigator.assoc:' + gds.toLowerCase(), script);
    await store.update('gdsNavigator.annotations.v1:' + gds.toLowerCase(), { gdsPath: gds });
    await store.update('gdsNavigator.alignment:' + gds.toLowerCase(), { imagePath: path.join(rootPath, 'Images', 'Photo.PNG') });
    await store.update('gdsNavigator.opaque', {
      [opaqueKey]: { opaquePath: metadataValue },
      builds: { [opaqueBuildsKey]: { opaquePath: metadataValue } },
    });
    await store.update('gdsNavigator.fileLinks.v1', {
      ...allLinks,
      metadata: { builds: { [opaqueBuildsKey]: { opaquePath: metadataValue } } },
    });

    const projectFile = path.join(rootPath, '.gds-navigator', 'project.json');
    const before = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    const serialized = JSON.stringify(before);
    assert.match(serialized, /@projectRelative\//, 'in-project logical keys were not serialized relatively');
    assert.match(serialized, /Chip\.GDS|Build\.PY/, 'actual path spelling was lost in persisted fileLinks values');
    assert(serialized.includes(externalScript), 'external fileLinks value was unexpectedly rewritten');
    assert(serialized.includes(externalGds), 'external GDS value was unexpectedly rewritten');
    assert(serialized.includes(externalCaseScript) && serialized.includes(externalCaseGds), 'case-only external link was unexpectedly relativized');
    assert(serialized.includes(externalUpperScript) && serialized.includes(externalUpperGds), 'upper-case external link was unexpectedly relativized');
    assert(serialized.includes(opaqueKey), 'opaque outside object key was unexpectedly relativized');
    assert(serialized.includes(opaqueBuildsKey), 'opaque builds key unexpectedly inherited fold permission');
    assert(serialized.includes(metadataValue), 'unknown metadata field was unexpectedly path-encoded');

    // Separate all-lower root control: the upper-case external witness folds
    // to the root spelling but remains outside by native lexical comparison.
    let lowerControl = { status: 'skipped', reason: 'no existing all-lower temporary base' };
    if (posixCaseBoundary) {
      const lowerBase = [os.tmpdir(), '/tmp'].find(candidate => candidate === candidate.toLowerCase() && fs.statSync(candidate).isDirectory());
      if (lowerBase) {
        const suffix = crypto.randomBytes(8).toString('hex');
        const lowerName = `gds-store-lower-${suffix}`;
        ownedLowerRoot = path.join(lowerBase, lowerName);
        const lowerExternalBase = path.join(lowerBase, lowerName.toUpperCase());
        const lowerExternalScript = path.join(lowerExternalBase, 'External.PY');
        const lowerExternalGds = path.join(lowerExternalBase, 'External.GDS');
        fs.mkdirSync(ownedLowerRoot, { recursive: true });
        const lowerStore = new ProjectStore(ownedLowerRoot, legacy);
        await lowerStore.ready();
        await lowerStore.update('gdsNavigator.fileLinks.v1', links.updateBuildLinks(undefined, lowerExternalScript, [lowerExternalGds]));
        const lowerSerialized = fs.readFileSync(path.join(ownedLowerRoot, '.gds-navigator', 'project.json'), 'utf8');
        const lowerExternalKey = lowerExternalScript.toLowerCase();
        assert(lowerSerialized.includes(lowerExternalKey), 'all-lower-root external logical key was unexpectedly relativized');
        assert(lowerSerialized.includes(lowerExternalScript) && lowerSerialized.includes(lowerExternalGds), 'all-lower-root external link value was unexpectedly rewritten');
        lowerControl = { status: 'passed', root: ownedLowerRoot };
      }
    }

    const moved = path.join(temp, 'MovedRoot');
    fs.renameSync(rootPath, moved);
    const reopened = new ProjectStore(moved, legacy);
    await reopened.ready();
    const movedGds = path.join(moved, 'Layouts', 'Chip.GDS');
    const movedScript = path.join(moved, 'Scripts', 'Build.PY');
    const movedExplicitScript = path.join(moved, 'Scripts', 'Explicit.PY');
    assert.equal(reopened.get('gdsNavigator.assoc:' + movedGds.toLowerCase()), movedScript, 'association key did not relocate');
    assert.equal(reopened.get('gdsNavigator.annotations.v1:' + movedGds.toLowerCase()).gdsPath, movedGds, 'annotation path value did not relocate');
    assert.equal(reopened.get('gdsNavigator.alignment:' + movedGds.toLowerCase()).imagePath, path.join(moved, 'Images', 'Photo.PNG'), 'alignment path value did not relocate');

    const movedLinks = reopened.get('gdsNavigator.fileLinks.v1');
    assert.equal(links.linkedScript(movedLinks, movedGds), movedExplicitScript, 'explicit link priority or relocation failed');
    assert.deepEqual(links.relatedLayouts(movedLinks, movedScript), [movedGds], 'relatedLayouts did not retain the relocated output');
    assert.deepEqual(links.relatedLayouts(movedLinks, movedExplicitScript), [movedGds], 'explicit related-layout link did not relocate');
    assert.equal(links.linkedScript(movedLinks, externalGds), externalScript, 'external link was changed or lost');
    assert.equal(links.linkedScript(movedLinks, externalCaseGds), externalCaseScript, 'case-only external link was changed or lost');
    assert.equal(links.linkedScript(movedLinks, externalUpperGds), externalUpperScript, 'upper-case external link was changed or lost');
    assert.equal(movedLinks.metadata.builds[opaqueBuildsKey].opaquePath, metadataValue, 'unknown nested metadata was changed');
    passed = true;
    successResult = { status: 'passed', logicalKeysRelocated: true, fileLinksSelectors: true, actualPathValuesPreserved: true, externalAndOpaquePathsPreserved: true, lowerRootExternalWitness: lowerControl };
  } catch (error) {
    writeReport({ status: 'failed', error: String(error && error.stack || error), fixtureRetained: true });
    throw error;
  } finally {
    if (passed) {
      try {
        fs.rmSync(temp, { recursive: true, force: true });
        if (ownedLowerRoot) fs.rmSync(ownedLowerRoot, { recursive: true, force: true });
        writeReport(successResult);
        console.log(JSON.stringify(successResult));
      } catch (error) {
        writeReport({ status: 'failed', error: `Owned fixture cleanup failed: ${error.stack || error}`, fixtureRetained: true, temp, ownedLowerRoot });
        throw error;
      }
    }
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
