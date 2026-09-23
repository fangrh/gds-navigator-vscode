const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { buildSync } = require('esbuild');

const repo = path.resolve(__dirname, '../..');
const reportDir = path.join(repo, 'logs', 'reliability', 'work-order-tracking');
fs.mkdirSync(reportDir, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-cli-tracking-'));
const queueBundle = path.join(root, 'queue.cjs');
buildSync({ entryPoints: [path.join(repo, 'src/instructionQueue.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: queueBundle });
const { InstructionQueue } = require(queueBundle);
const queueFile = path.join(root, '.gds-navigator', 'instructions.json');
const cli = path.join(repo, 'scripts', 'instructions.cjs');
const run = (...args) => cp.spawnSync(process.execPath, [cli, '--queue', queueFile, ...args], { encoding: 'utf8', windowsHide: true });
const json = result => JSON.parse(result.stdout);
const expectFailure = (result, pattern) => { assert.notEqual(result.status, 0, `expected failure, got ${result.stdout}`); assert(pattern.test(result.stderr + result.stdout), `missing ${pattern} in ${result.stderr}${result.stdout}`); };
const input = (gdsPath, text) => ({
    gdsPath,
    gdsHash: `sha-${gdsPath}`,
    request: { action: 'move', text, targetIds: ['target-17'], snapshot: `sha-${gdsPath}`, documentPath: gdsPath },
    components: [{ id: 'target-17', kind: 'rectangle', layer: [1, 0], geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }]
});

try {
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    const sourceA = path.join(root, 'layout.py');
    const sourceB = path.join(root, 'helper.py');
    fs.writeFileSync(sourceA, 'value = 1\n', 'utf8');
    fs.writeFileSync(sourceB, 'helper = 1\n', 'utf8');
    const beforeA = fs.readFileSync(sourceA, 'utf8');
    const beforeB = fs.readFileSync(sourceB, 'utf8');

    let queue = new InstructionQueue(root);
    const a1 = queue.add(input('chip-a.gds', 'Move target-17 by +2 um and validate the rebuilt layout.'));
    const b1 = queue.add(input('chip-b.gds', 'Review target-17 independently on chip B.'));
    const a2 = queue.add(input('./chip-a.gds', 'Second A work order after the first validation.'));
    assert.equal(queue.ready(), true);

    const shown = run('show', a1.id);
    assert.equal(shown.status, 0, shown.stderr);
    const shownRecord = json(shown);
    assert.equal(shownRecord.request.text, a1.request.text);
    assert.deepEqual(shownRecord.context.request.target_ids, ['target-17']);
    assert.equal(shownRecord.context.schema, 'gds-navigator.selection');

    let result = run('start', a1.id, '--file', sourceA, '--file', sourceB);
    assert.equal(result.status, 0, result.stderr);
    expectFailure(run('start', a2.id, '--file', sourceA), /FIFO/);
    // B is independent and can complete while A1 remains open.
    result = run('start', b1.id, '--file', sourceB);
    assert.equal(result.status, 0, result.stderr);
    fs.writeFileSync(sourceB, 'helper = 2\n', 'utf8');
    result = run('done', b1.id, '--note', 'independent GDS validation');
    assert.equal(result.status, 0, result.stderr);
    fs.writeFileSync(sourceA, 'value = 2\n', 'utf8');
    result = run('done', a1.id, '--note', 'validated in a fresh CLI process');
    assert.equal(result.status, 0, result.stderr);
    const doneA1 = json(result);
    assert.equal(doneA1.status, 'done');
    assert.deepEqual(doneA1.history.map(h => h.event), ['created', 'start', 'done']);
    assert(doneA1.sourceReceipts.every(r => r.afterHash), 'done did not persist post-edit receipt hashes');
    result = run('comment', a1.id, '--text', 'Please attach the validation log to this order.');
    assert.equal(result.status, 0, result.stderr);
    const commentedA1 = json(result);
    assert.equal(commentedA1.comments.length, 1);
    assert.equal(commentedA1.comments[0].text, 'Please attach the validation log to this order.');
    assert.equal(commentedA1.history.at(-1).event, 'comment');
    expectFailure(run('comment', a1.id, '--text', ''), /Comment must contain/);

    const reopened = new InstructionQueue(root);
    assert.equal(reopened.get(a1.id).history.find(h => h.event === 'done').note, 'validated in a fresh CLI process');
    assert.equal(reopened.get(a1.id).comments[0].text, 'Please attach the validation log to this order.');
    const openA = run('list', '--gds', path.join(root, 'chip-a.gds'), '--open');
    assert.equal(openA.status, 0, openA.stderr);
    assert.deepEqual(json(openA).map(r => r.id), [a2.id]);

    // A stale current source must reject revert and leave the conflicting bytes untouched.
    fs.writeFileSync(sourceA, 'value = 3  # newer edit\n', 'utf8');
    const conflictBytes = fs.readFileSync(sourceA, 'utf8');
    result = run('revert', a1.id);
    expectFailure(result, /changed after completion/);
    assert.equal(fs.readFileSync(sourceA, 'utf8'), conflictBytes);
    fs.writeFileSync(sourceA, 'value = 2\n', 'utf8');
    result = run('revert', a1.id, '--note', 'restored after conflict check');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(sourceA, 'utf8'), beforeA);
    assert.equal(fs.readFileSync(sourceB, 'utf8'), beforeB);
    expectFailure(run('revert', a1.id), /Only done instructions|already been reverted|Unknown instruction/);
    expectFailure(run('done', a1.id), /Only open instructions/);

    // A1 is reverted, so A2 may now start and complete on its own list.
    result = run('start', a2.id, '--file', sourceA);
    assert.equal(result.status, 0, result.stderr);
    fs.writeFileSync(sourceA, 'value = 4\n', 'utf8');
    result = run('done', a2.id, '--note', 'second A validation');
    assert.equal(result.status, 0, result.stderr);

    expectFailure(run('show', 'INS-999999-unknown'), /Unknown instruction/);
    expectFailure(run('done', 'INS-999999-unknown'), /Unknown instruction/);
    const saved = fs.readFileSync(queueFile, 'utf8');
    fs.writeFileSync(queueFile, '{ malformed', 'utf8');
    expectFailure(run('list'), /Malformed queue/);
    fs.writeFileSync(queueFile, saved, 'utf8');

    const finalQueue = new InstructionQueue(root);
    assert.equal(finalQueue.ready(), true);
    assert.equal(finalQueue.get(a1.id).status, 'reverted');
    assert.equal(finalQueue.get(a2.id).status, 'done');
    assert.equal(finalQueue.get(b1.id).status, 'done');
    const report = {
        status: 'passed',
        queueFile,
        checks: ['show-frozen-context', 'cross-process-start-done-history', 'comment-reload', 'blank-comment-rejection', 'strict-conflict-revert', 'exact-source-revert', 'duplicate-lifecycle-rejection', 'independent-gds-fifo', 'unknown-id', 'malformed-queue']
    };
    fs.writeFileSync(path.join(reportDir, 'cli.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
} catch (error) {
    const failure = { status: 'failed', error: String(error.stack || error), queueFile };
    fs.writeFileSync(path.join(reportDir, 'cli.json'), JSON.stringify(failure, null, 2) + '\n');
    throw error;
}
