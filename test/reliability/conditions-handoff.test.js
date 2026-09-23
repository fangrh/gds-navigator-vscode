const assert = require('assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-conditions-'));
const reportDir = path.join(root, 'logs/reliability/conditions');
const reportPath = path.join(reportDir, 'handoff.json');
fs.mkdirSync(reportDir, { recursive: true });

require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/selectionExport.ts')], bundle: true, platform: 'node', outfile: path.join(tmp, 'export.js') });
const { selectionDocument, toYaml, validateAnnotations } = require(path.join(tmp, 'export.js'));
const polygon = (x = 0) => ({ type: 'Polygon', coordinates: [[[x, 0], [x + 10, 0], [x + 10, 5], [x, 5], [x, 0]]] });
const line = { type: 'LineString', coordinates: [[0, 0], [2, 3], [4, 0]] };
const a = { provId: 'pad-a', layer: '4/0', bbox: [0, 0, 10, 5], geometry: polygon(), provenance: { file: 'D:/demo/build.py', line: 18, array_index: [[2, 3], [0, 1]], source_text: 'pad.move((x, y))' } };
const b = { ...a, provId: 'pad-b', geometry: polygon(30), bbox: [30, 0, 40, 5], provenance: { ...a.provenance, array_index: [[2, 4], [0, 1]] } };
const catalog = [a, b];
const intent = (action, text, targetIds = ['pad-a'], extra = {}) => ({ action, text, targetIds, snapshot: 'snapshot-a', ...extra });
const drawing = (i, extra = {}) => ({ provId: 'drawing-1', drawn: true, geometry: polygon(-20), intent: i, ...extra });
const make = (selected, request, extra = {}) => selectionDocument('D:/demo/chip.gds', 'snapshot-a', selected, 'DEMO', { request, catalog, ...extra });

const cases = [
  { id: 'C01', name: 'single selected instance keeps exact geometry and provenance', run: () => { const d = make([a], intent('move', 'Move pad +5 um in x.')); assert.deepEqual(d.elements[0].provenance.array_index, [[2, 3], [0, 1]]); assert.deepEqual(d.elements[0].geometry, a.geometry); } },
  { id: 'C02', name: 'same source line preserves distinct target identities', run: () => { const d = make([a, b], intent('inspect', 'Compare both pads.', ['pad-a', 'pad-b'])); assert.deepEqual(d.elements.map(e => e.id), ['pad-a', 'pad-b']); assert.notDeepEqual(d.elements[0].geometry, d.elements[1].geometry); } },
  { id: 'C03', name: 'drawing-only handoff includes linked target context', run: () => { const d = make([drawing(intent('move', 'Move the linked pad.'))]); assert.deepEqual(d.referenced_elements.map(e => e.id), ['pad-a']); assert.equal(d.elements.length, 0); } },
  { id: 'C04', name: 'omitted snapshot binds to the current snapshot', run: () => { const d = make([drawing({ action: 'inspect', text: 'Inspect current pad.', targetIds: ['pad-a'] })]); assert.equal(d.annotations[0].target_snapshot, 'snapshot-a'); assert.equal(d.annotations[0].target_status, 'current_snapshot'); } },
  { id: 'C05', name: 'restored annotation from an old snapshot requires review', run: () => { const d = make([drawing(intent('move', 'Move old pad.', ['pad-a'], { snapshot: 'old-snapshot' }))]); assert.equal(d.annotations[0].target_status, 'stale_review_required'); assert(d.handoff.issues.some(i => i.code === 'stale_target')); } },
  { id: 'C06', name: 'restored annotation from another document requires review', run: () => { const d = make([drawing(intent('delete', 'Delete old pad.', ['pad-a'], { documentPath: 'D:/other/chip.gds' }))]); assert.equal(d.annotations[0].target_status, 'stale_review_required'); assert(d.handoff.issues.some(i => i.code === 'stale_target')); } },
  { id: 'C07', name: 'unknown target identity is retained as unresolved', run: () => { const d = make([drawing(intent('move', 'Move missing pad.', ['gone']))]); assert.equal(d.annotations[0].target_status, 'unresolved'); assert(d.handoff.issues.some(i => i.code === 'unresolved_target')); } },
  { id: 'C08', name: 'editing action without target is rejected for clarification', run: () => { const d = make([drawing(intent('resize', 'Resize a pad.', []))]); assert(d.handoff.issues.some(i => i.code === 'missing_target')); assert.equal(d.handoff.status, 'needs_clarification'); } },
  { id: 'C09', name: 'delete and move on one identity exposes action conflict', run: () => { const d = make([drawing(intent('delete', 'Delete pad.')), drawing(intent('move', 'Move pad.'), { provId: 'drawing-2' })]); assert(d.handoff.issues.some(i => i.code === 'conflicting_actions')); } },
  { id: 'C10', name: 'restored unclosed polygon is rejected', run: () => { const bad = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }; const d = make([drawing(intent('mark_region', 'Review region.', []), { geometry: bad })]); assert(d.handoff.issues.some(i => i.code === 'invalid_geometry')); assert.equal(d.annotations[0].target_status, 'invalid_geometry'); } },
  { id: 'C11', name: 'restored one-point line is rejected', run: () => { assert.equal(validateAnnotations([{ id: 'line', geometry: { type: 'LineString', coordinates: [[0, 0]] } }]), false); } },
  { id: 'C12', name: 'restored zero-radius circle is rejected', run: () => { assert.equal(validateAnnotations([{ id: 'circle', geometry: { type: 'Circle', center: [0, 0], radius: 0 } }]), false); } },
  { id: 'C13', name: 'valid point line polygon and circle annotations pass', run: () => { assert.equal(validateAnnotations([{ id: 'p', geometry: { type: 'Point', coordinates: [1, 2] } }, { id: 'l', geometry: line }, { id: 'g', geometry: polygon() }, { id: 'c', geometry: { type: 'Circle', center: [1, 2], radius: 3 } }]), true); } },
  { id: 'C14', name: 'restored scalar target list is rejected', run: () => { const bad = { id: 'bad', geometry: polygon(), intent: { action: 'move', text: 'Bad target list.', targetIds: 'pad-a', snapshot: 'snapshot-a' } }; assert.equal(validateAnnotations([bad]), false); const d = make([drawing(bad.intent)]); assert(d.handoff.issues.some(i => i.code === 'invalid_intent')); assert.equal(d.annotations[0].target_status, 'invalid_intent'); } },
  { id: 'C15', name: 'restored non-string snapshot is rejected', run: () => { const bad = { id: 'bad', geometry: polygon(), intent: { action: 'move', text: 'Bad snapshot.', targetIds: ['pad-a'], snapshot: { hash: 'snapshot-a' } } }; assert.equal(validateAnnotations([bad]), false); const d = make([drawing(bad.intent)]); assert(d.handoff.issues.some(i => i.code === 'invalid_intent')); assert.equal(d.annotations[0].target_status, 'invalid_intent'); } },
  { id: 'C16', name: 'quoted unicode YAML request survives independent parsing', run: () => { const d = make([a], intent('move', '只移动 µm 元件。\nNote: "left: right" # literal')); const parsed = childProcess.execFileSync('python', ['-c', 'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin.read())))'], { input: toYaml(d), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } }); assert.deepEqual(JSON.parse(parsed), JSON.parse(JSON.stringify(d))); } },
  { id: 'C17', name: 'nested provenance arrays survive YAML parsing', run: () => { const d = make([a]); const parsed = childProcess.execFileSync('python', ['-c', 'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin.read())))'], { input: toYaml(d), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } }); assert.deepEqual(JSON.parse(parsed).elements[0].provenance.array_index, [[2, 3], [0, 1]]); } },
  { id: 'C18', name: 'duplicate target IDs are deduplicated deterministically', run: () => { const d = make([drawing(intent('inspect', 'Inspect once.', ['pad-a', 'pad-a', 'pad-b']))]); assert.deepEqual(d.annotations[0].target_ids, ['pad-a', 'pad-b']); } },
  { id: 'C19', name: 'missing provenance is explicit and does not fabricate source data', run: () => { const d = make([{ ...a, provenance: {} }], intent('inspect', 'Describe geometry.')); assert.equal(d.elements[0].provenance_status, 'unavailable'); assert.deepEqual(d.elements[0].provenance, {}); } },
  { id: 'C20', name: 'catalog omission preserves missing linked identity as unresolved', run: () => { const d = selectionDocument('D:/demo/chip.gds', 'snapshot-a', [drawing(intent('inspect', 'Inspect absent catalog item.', ['pad-a']))], 'DEMO', { catalog: [] }); assert.equal(d.annotations[0].target_status, 'unresolved'); assert.equal(d.referenced_elements.length, 0); } },
];

const results = [];
try {
  for (const c of cases) {
    try { c.run(); results.push({ id: c.id, name: c.name, status: 'passed' }); }
    catch (error) { results.push({ id: c.id, name: c.name, status: 'failed', error: String(error && error.stack || error) }); }
  }
  const status = results.every(r => r.status === 'passed') ? 'passed' : 'failed';
  fs.writeFileSync(reportPath, JSON.stringify({ cases: results, status }, null, 2));
  assert.equal(status, 'passed', results.filter(r => r.status === 'failed').map(r => `${r.id} ${r.name}: ${r.error}`).join('\n'));
  console.log(JSON.stringify({ status, cases: results.length, report: reportPath }));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
