#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '../..');

function fingerprint(file) {
  const stat = fs.statSync(file);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return `${stat.size}:${stat.mtimeMs}:${hash}`;
}

function sorted(paths) { return paths.map((file) => path.resolve(file)).sort(); }

const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-snapshot-bundle-'));
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-snapshot-fixture-')));
const bundle = path.join(bundleDir, 'pythonRunner.cjs');
let passed = false;
let report;

(async () => {
try {
  require('esbuild').buildSync({
    entryPoints: [path.join(ROOT, 'src', 'pythonRunner.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    outfile: bundle,
  });
  const originalLoad = Module._load;
  let findChangedGds;
  try {
    Module._load = function load(request, parent, isMain) {
      if (request === 'vscode') return { window: { showErrorMessage() {} } };
      return originalLoad.call(this, request, parent, isMain);
    };
    ({ findChangedGds } = require(bundle));
  } finally {
    Module._load = originalLoad;
  }

  const nested = path.join(fixture, 'nested');
  const hidden = path.join(fixture, '.hidden');
  const nodeModules = path.join(fixture, 'node_modules', 'dependency');
  const errorDir = path.join(fixture, 'race-dir');
  for (const dir of [nested, hidden, nodeModules, errorDir]) fs.mkdirSync(dir, { recursive: true });

  const files = {
    root: path.join(fixture, 'a.gds'),
    nested: path.join(nested, 'M.GDS'),
    hidden: path.join(hidden, 'hidden.gds'),
    dependency: path.join(nodeModules, 'dependency.gds'),
    race: path.join(errorDir, 'race.gds'),
    disappearing: path.join(fixture, 'disappearing.gds'),
    readError: path.join(fixture, 'read-error.gds'),
    asyncReadError: path.join(fixture, 'async-read-error.gds'),
  };
  fs.writeFileSync(files.root, 'root-a');
  fs.writeFileSync(files.nested, 'nested-m');
  fs.writeFileSync(files.hidden, 'hidden');
  fs.writeFileSync(files.dependency, 'dependency');
  fs.writeFileSync(files.race, 'race');
  fs.writeFileSync(files.disappearing, 'gone');
  fs.writeFileSync(files.readError, 'read-error');
  fs.writeFileSync(files.asyncReadError, 'async-read-error');

  const linkTarget = path.join(fixture, 'link-target.gds');
  const linkPath = path.join(fixture, 'linked-file.GdS');
  const linkedDirTarget = path.join(fixture, 'directory-target');
  const linkedDir = path.join(fixture, 'linked-directory');
  fs.writeFileSync(linkTarget, 'link-target');
  fs.mkdirSync(linkedDirTarget);
  fs.writeFileSync(path.join(linkedDirTarget, 'inside.gds'), 'inside');
  const cleanupLink = (file) => { try { fs.unlinkSync(file); } catch {} };
  let fileSymlinkSupported = false;
  let directorySymlinkSupported = false;
  try {
    fs.symlinkSync(linkTarget, linkPath);
    fileSymlinkSupported = true;
  } catch {
    cleanupLink(linkPath);
  }
  try {
    fs.symlinkSync(linkedDirTarget, linkedDir, 'dir');
    directorySymlinkSupported = true;
  } catch {
    cleanupLink(linkedDir);
  }
  const brokenLink = path.join(fixture, 'broken.gds');
  let brokenSymlinkSupported = false;
  try {
    fs.symlinkSync(path.join(fixture, 'missing-target.gds'), brokenLink);
    brokenSymlinkSupported = true;
  } catch {
    cleanupLink(brokenLink);
  }

  // Freeze the fixture timestamps so a same-size edit can keep size and mtime
  // unchanged while the full SHA-256 fingerprint still changes.
  const frozen = new Date('2020-01-02T03:04:05.678Z');
  for (const file of [files.root, files.nested, linkTarget]) fs.utimesSync(file, frozen, frozen);

  const before = new Map([
    [path.resolve(files.root), fingerprint(files.root)],
    [path.resolve(files.nested), fingerprint(files.nested)],
    [path.resolve(files.race), fingerprint(files.race)],
    [path.resolve(files.disappearing), fingerprint(files.disappearing)],
    [path.resolve(files.readError), fingerprint(files.readError)],
    [path.resolve(files.asyncReadError), fingerprint(files.asyncReadError)],
    [path.resolve(linkedDirTarget, 'inside.gds'), fingerprint(path.join(linkedDirTarget, 'inside.gds'))],
    [path.resolve(linkTarget), fingerprint(linkTarget)],
  ]);
  if (fileSymlinkSupported) before.set(path.resolve(linkPath), fingerprint(linkPath));

  assert.deepEqual(await findChangedGds(fixture, before), [], 'unchanged eligible files are stable');
  assert.deepEqual(
    await findChangedGds(fixture, new Map([...before].map(([file, full]) => [file, full.split(':').slice(0, 2).join(':')]))) ,
    [],
    'historical size:mtime fingerprints remain compatible',
  );

  const nestedBefore = fs.statSync(files.nested);
  fs.writeFileSync(files.nested, 'changed!');
  fs.utimesSync(files.nested, frozen, frozen);
  assert.equal(fs.statSync(files.nested).size, nestedBefore.size);
  assert.equal(fs.statSync(files.nested).mtimeMs, nestedBefore.mtimeMs);
  fs.writeFileSync(linkTarget, 'link-value!');
  fs.utimesSync(linkTarget, frozen, frozen);
  const newFile = path.join(fixture, 'b.gds');
  fs.writeFileSync(newFile, 'new');
  const changed = await findChangedGds(fixture, before);
  const expected = sorted([files.nested, newFile, linkTarget, ...(fileSymlinkSupported ? [linkPath] : [])]);
  assert.deepEqual(changed, expected, 'same-size/same-mtime edits and new files are sorted');

  // Exercise all three race/error catches while preserving the public result.
  const originalStat = fs.promises.stat;
  const originalReaddir = fs.promises.readdir;
  const originalCreateReadStream = fs.createReadStream;
  fs.promises.stat = async function stat(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(files.disappearing)) throw new Error('disappeared');
    return originalStat.call(this, file, ...args);
  };
  fs.promises.readdir = async function readdir(dir, ...args) {
    if (path.resolve(String(dir)) === path.resolve(errorDir)) throw new Error('directory disappeared');
    return originalReaddir.call(this, dir, ...args);
  };
  fs.createReadStream = function createReadStream(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(files.readError)) throw new Error('read failed');
    return originalCreateReadStream.call(this, file, ...args);
  };
  try {
    const raceResult = await findChangedGds(fixture, new Map());
    const expectedRace = sorted([
      files.root, files.nested, files.asyncReadError, newFile, linkTarget, path.join(linkedDirTarget, 'inside.gds'),
      ...(fileSymlinkSupported ? [linkPath] : []),
    ]);
    assert.deepEqual(raceResult, expectedRace, 'stat/read/readdir races leave exactly the remaining candidates');
  } finally {
    fs.promises.stat = originalStat;
    fs.promises.readdir = originalReaddir;
    fs.createReadStream = originalCreateReadStream;
  }

  let asyncErrorStream;
  fs.createReadStream = function createReadStream(file, ...args) {
    const stream = originalCreateReadStream.call(this, file, ...args);
    if (path.resolve(String(file)) === path.resolve(files.asyncReadError)) {
      asyncErrorStream = stream;
      queueMicrotask(() => stream.destroy(new Error('async read failed')));
    }
    return stream;
  };
  try {
    const asyncRaceResult = await findChangedGds(fixture, new Map());
    const expectedAsyncRace = sorted([
      files.root, files.nested, files.race, files.disappearing, files.readError, linkTarget,
      path.join(linkedDirTarget, 'inside.gds'), newFile,
      ...(fileSymlinkSupported ? [linkPath] : []),
    ]);
    assert.deepEqual(asyncRaceResult, expectedAsyncRace, 'async stream errors leave exactly the remaining candidates');
    assert(asyncErrorStream?.closed, 'async stream has settled before the public promise returns');
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }

  assert(!changed.includes(path.resolve(files.hidden)), 'dot directories are excluded');
  assert(!changed.includes(path.resolve(files.dependency)), 'node_modules is excluded');
  if (directorySymlinkSupported) assert(!changed.includes(path.resolve(linkedDir, 'inside.gds')), 'directory symlinks are not traversed');
  if (fileSymlinkSupported) {
    assert(changed.includes(path.resolve(linkPath)), 'regular file symlinks are followed');
  }
  if (brokenSymlinkSupported) assert(!changed.includes(path.resolve(brokenLink)), 'broken symlink races are tolerated');

  passed = true;
  report = {
    status: 'passed',
    fixture: 'private canonical temporary tree',
    sortedCandidates: true,
    caseInsensitiveExtension: true,
    excludedDotAndNodeModules: true,
    directorySymlinkNotTraversed: directorySymlinkSupported,
    fileSymlinkFollowed: fileSymlinkSupported,
    historicalSizeMtimeCompatible: true,
    fullSha256SameSizeSameMtime: true,
    raceErrorsTolerated: true,
  };
} finally {
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.rmSync(fixture, { recursive: true, force: true });
}

if (!passed) throw new Error('GDS snapshot contract failed');
console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
