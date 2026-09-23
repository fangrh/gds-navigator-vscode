const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSync } = require('esbuild');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-work-order-'));
const out = path.join(root, 'queue.cjs');
buildSync({ entryPoints: [path.join(__dirname, '../../src/instructionQueue.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out });
const { InstructionQueue } = require(out);
const input = (gdsPath) => ({ gdsPath, request: { action: 'add', text: 'work order' }, components: [] });

// FIFO is scoped to one normalized GDS identity. A different GDS can proceed.
let q = new InstructionQueue(root);
const first = q.add(input('chip.gds'));
const other = q.add(input('other.gds'));
const second = q.add(input('./chip.gds'));
assert.throws(() => q.setStatus(second.id, 'done'), /FIFO/);
q.setStatus(other.id, 'done', 'independent GDS');
q.setStatus(first.id, 'done');
q.setStatus(second.id, 'done');
assert.deepEqual(q.list('chip.gds').map(r => r.id), [first.id, second.id]);

// Lifecycle history is append-only across reloads and preserves notes.
const source = path.join(root, 'source.py');
fs.writeFileSync(source, 'value = 1\n', 'utf8');
const reversible = q.add(input('reversible.gds'));
q.start(reversible.id, [source]);
fs.writeFileSync(source, 'value = 2\n', 'utf8');
q.captureAfter(reversible.id, 'validated');
q.revertSources(reversible.id, 'undo');
const history = q.get(reversible.id).history;
assert.deepEqual(history.map(h => h.event), ['created', 'start', 'done', 'reverted']);
assert.equal(history[2].note, 'validated');
assert.equal(history[3].note, 'undo');
q = new InstructionQueue(root);
assert.deepEqual(q.get(reversible.id).history.map(h => h.event), ['created', 'start', 'done', 'reverted']);

// Version-1 records without history remain readable; a later transition adds it.
const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-work-order-legacy-'));
let legacy = new InstructionQueue(legacyRoot);
const legacyRecord = legacy.add(input('legacy.gds'));
const legacyFile = legacy.location;
const persisted = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
delete persisted.records[0].history;
fs.writeFileSync(legacyFile, JSON.stringify(persisted, null, 2) + '\n', 'utf8');
legacy = new InstructionQueue(legacyRoot);
assert.equal(legacy.ready(), true);
assert.equal(legacy.get(legacyRecord.id).history, undefined);
legacy.setStatus(legacyRecord.id, 'done');
assert.deepEqual(legacy.get(legacyRecord.id).history.map(h => h.event), ['done']);

// Source receipts remain strict even when work orders belong to different GDS files.
const conflictRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-work-order-conflict-'));
const sourceA = path.join(conflictRoot, 'a.py');
const sourceB = path.join(conflictRoot, 'b.py');
fs.writeFileSync(sourceA, 'a = 1\n', 'utf8');
fs.writeFileSync(sourceB, 'b = 1\n', 'utf8');
const conflicts = new InstructionQueue(conflictRoot);
const ga = conflicts.add(input('a.gds'));
const gb = conflicts.add(input('b.gds'));
conflicts.start(ga.id, [sourceA]);
conflicts.start(gb.id, [sourceB]);
fs.writeFileSync(sourceA, 'a = 2\n', 'utf8');
conflicts.captureAfter(ga.id);
fs.writeFileSync(sourceA, 'a = 3\n', 'utf8');
assert.throws(() => conflicts.revertSources(ga.id), /changed after completion/);
fs.writeFileSync(sourceB, 'b = 2\n', 'utf8');
conflicts.captureAfter(gb.id);
assert.equal(conflicts.get(gb.id).status, 'done');

console.log(JSON.stringify({ status: 'passed', checks: ['same-gds-fifo', 'other-gds-progress', 'history-reload', 'history-backward-compatibility', 'source-conflicts-across-gds'] }));
