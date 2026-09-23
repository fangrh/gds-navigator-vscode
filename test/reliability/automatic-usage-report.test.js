const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '../..');
const bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-auto-report-bundle-')), 'automaticUsageReport.cjs');
esbuild.buildSync({ entryPoints: [path.join(root, 'src', 'automaticUsageReport.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { AutomaticUsageReport } = require(bundle);

function event(action, seq = 1) {
  return { schema: 'gds-navigator.usage', version: 1, sessionId: 'session-a', seq, id: `session-a-${seq}`, timestamp: new Date().toISOString(), action, phase: 'intent', outcome: 'unknown' };
}
function makeProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-auto-report-'));
  const usage = path.join(project, '.gds-navigator', 'usage');
  fs.mkdirSync(usage, { recursive: true });
  fs.writeFileSync(path.join(usage, 'session-a-0001.jsonl'), JSON.stringify(event('first')) + '\n');
  return project;
}
function readReport(project) {
  return JSON.parse(fs.readFileSync(path.join(project, '.gds-navigator', 'usage-report.json'), 'utf8'));
}
async function main() {
  const project = makeProject();
  const automatic = new AutomaticUsageReport(project, { delayMs: 10 });
  automatic.changed();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(readReport(project).totalEvents, 1);
  assert(!fs.existsSync(path.join(project, '.gds-navigator', 'usage-report.md.tmp')));
  await automatic.dispose();

  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const project2 = makeProject();
  const serialized = new AutomaticUsageReport(project2, { generate: async root => { calls.push(root); if (calls.length === 1) await gate; return { summary: { totalEvents: calls.length }, markdown: `report ${calls.length}\n` }; } });
  serialized.changed();
  const first = serialized.flush();
  serialized.changed();
  release();
  await first;
  assert.equal(calls.length, 2, 'a change during a write must produce a later report');
  assert.equal(readReport(project2).totalEvents, 2);
  await serialized.dispose();

  const errors = [];
  let fail = true;
  const project3 = makeProject();
  const retry = new AutomaticUsageReport(project3, { onError: error => errors.push(error), generate: async () => { if (fail) throw new Error('temporary generation failure'); return { summary: { totalEvents: 9 }, markdown: 'recovered\n' }; } });
  retry.changed();
  await retry.flush();
  assert.equal(errors.length, 1);
  fail = false;
  await retry.flush();
  assert.equal(readReport(project3).totalEvents, 9);
  await retry.dispose();
  console.log('automatic usage report tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
