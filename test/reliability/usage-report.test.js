const assert = require('assert/strict');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-usage-'));
const out = path.join(temp, 'usageReport.cjs'); esbuild.buildSync({ entryPoints: [path.join(root, 'src', 'usageReport.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out });
const { generateUsageReport } = require(out); const usage = path.join(temp, '.gds-navigator', 'usage'); fs.mkdirSync(usage, { recursive: true });
const lines = [
  { action: 'open', timestamp: '2026-09-22T10:00:00Z', sessionId: 's1', seq: 1, source: 'ui', phase: 'intent', outcome: 'unknown', documentId: 'doc-aaaaaaaaaaaaaaaaaaaaaaaa' },
  { action: 'preview', timestamp: '2026-09-22T10:01:00Z', sessionId: 's1', seq: 2, source: 'ui', phase: 'result', outcome: 'success', documentId: 'doc-aaaaaaaaaaaaaaaaaaaaaaaa', durationMs: 100 },
  { action: 'click', timestamp: '2026-09-22T10:02:00Z', sessionId: 's1', seq: 3, source: 'ui', phase: 'intent', outcome: 'unknown', documentId: 'doc-aaaaaaaaaaaaaaaaaaaaaaaa', durationMs: 300 },
  { action: 'open', timestamp: '2026-09-22T11:00:00Z', sessionId: 's2', seq: 1, source: 'ui', phase: 'intent', outcome: 'unknown', documentId: 'doc-bbbbbbbbbbbbbbbbbbbbbbbb' },
  { action: 'open', timestamp: '2026-09-22T11:01:00Z', sessionId: 's2', seq: 2, source: 'ui', phase: 'intent', outcome: 'unknown', documentId: 'doc-bbbbbbbbbbbbbbbbbbbbbbbb' },
  { action: 'save', timestamp: '2026-09-22T11:02:00Z', sessionId: 's2', seq: 3, source: 'ui', phase: 'result', outcome: 'failure', documentId: 'doc-bbbbbbbbbbbbbbbbbbbbbbbb' },
];
for (const event of lines) { event.schema = 'gds-navigator.usage'; event.version = 1; }
fs.writeFileSync(path.join(usage, 'session-a.jsonl'), lines.map(JSON.stringify).join('\n') + '\nnot-json\n');
fs.writeFileSync(path.join(usage, 'session-b.jsonl'), JSON.stringify({ schema: 'gds-navigator.usage', version: 1, action: 'ignored', timestamp: '2026-09-22T12:00:00Z', sessionId: 's3', seq: 1, phase: 'intent', outcome: 'unknown', documentId: 'doc-cccccccccccccccccccccccc' }) + '\n');
fs.writeFileSync(path.join(usage, 'unsafe name.jsonl'), JSON.stringify(lines[0]) + '\n'); fs.writeFileSync(path.join(usage, 'session-empty.jsonl'), '');
(async () => {
  const report = await generateUsageReport(temp); const s = report.summary;
  assert.equal(s.totalSessions, 3); assert.equal(s.totalEvents, 7); assert.equal(s.malformedEvents, 1); assert.equal(s.actionIntents.open, 3); assert.equal(s.outcomes.failure, 1); assert.equal(s.durations.count, 2); assert.equal(s.durations.p50Ms, 100); assert(s.transitionCounts['open -> preview'] === 1); assert(s.sessionChronology[0].events.length > 0); assert(report.markdown.includes('Rare activity is not evidence') || report.markdown.includes('Rare activity'));
  fs.writeFileSync(path.join(usage, 'session-malformed.jsonl'), '{"schema":"gds-navigator.usage","version":1,"action":"cut"'); const zero = await generateUsageReport(path.join(os.tmpdir(), `gds-empty-${process.pid}`)); assert.equal(zero.summary.totalEvents, 0); assert(zero.markdown.includes('none observed'));
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-usage-cli-')); fs.mkdirSync(path.join(install, 'scripts')); fs.mkdirSync(path.join(install, 'dist'));
  fs.copyFileSync(path.join(__dirname, '../../scripts/usage-report.cjs'), path.join(install, 'scripts/usage-report.cjs'));
  require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../../src/usageReport.ts')], outfile: path.join(install, 'dist/usageReport.js'), bundle: true, platform: 'node', format: 'cjs' });
  const cli = require('child_process').spawnSync(process.execPath, [path.join(install, 'scripts/usage-report.cjs'), '--project', temp, '--json'], { encoding: 'utf8' }); assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).totalEvents, 7); assert(!fs.existsSync(path.join(temp, 'dist')));
  console.log('usage report tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
