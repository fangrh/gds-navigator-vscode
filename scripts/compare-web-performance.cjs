#!/usr/bin/env node
'use strict';
// Alternate revisions in separate browsers to limit run-order and retained-heap bias.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const baseline = process.argv[2];
if (!baseline || !fs.existsSync(baseline)) {
    console.error('Usage: npm run profile:web:compare -- PATH_TO_SAVED_VIEWER_HTML');
    process.exit(1);
}
const out = path.resolve(process.env.GDS_COMPARE_OUT || path.join(root, 'logs/reliability/shared-performance/paired'));
fs.mkdirSync(out, { recursive: true });
const reports = [];
for (const [index, variant] of ['before', 'after', 'after', 'before'].entries()) {
    const dir = path.join(out, `${index + 1}-${variant}`);
    const run = spawnSync(process.execPath, [path.join(__dirname, 'profile-web.cjs')], {
        cwd: root, encoding: 'utf8', timeout: 120000,
        env: { ...process.env, GDS_PROFILE_OUT: dir, GDS_PROFILE_VIEWER: variant === 'before' ? path.resolve(baseline) : path.join(root, 'webview/viewer.html') },
    });
    fs.writeFileSync(path.join(out, `${index + 1}-${variant}.log`), (run.stdout || '') + (run.stderr || ''));
    if (run.error || run.status !== 0) throw run.error || new Error(`${variant} failed: ${run.stderr}`);
    reports.push({ variant, ...JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) });
    console.log(`Completed ${index + 1}/4: ${variant}`);
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const comparisons = reports[0].runs.map(({ features }) => {
    const matching = reports.flatMap(report => report.runs.filter(run => run.features === features));
    assert.equal(new Set(matching.map(run => run.signature)).size, 1, 'Geometry, order or properties changed');
    const summarize = variant => {
        const runs = reports.filter(report => report.variant === variant).flatMap(report => report.runs.filter(run => run.features === features));
        return { loadMedianMs: median(runs.flatMap(run => run.loadMs)), viewerMedianMs: median(runs.flatMap(run => run.stages.viewerLoad.samplesMs)), sourceClearMedianMs: median(runs.flatMap(run => run.stages.sourceClear.samplesMs)), sourceAddMedianMs: median(runs.flatMap(run => run.stages.sourceAdd.samplesMs)), panMedianMs: median(runs.flatMap(run => run.panRenderSamplesMs)), snapEnableMedianMs: median(runs.map(run => run.snapEnableMs)), snapActiveLoadMedianMs: median(runs.flatMap(run => run.snapActiveLoadMs)), snapActiveViewerMedianMs: median(runs.flatMap(run => run.snapActiveStages.viewerLoad.samplesMs)) };
    };
    const before = summarize('before'), after = summarize('after');
    return { features, signature: matching[0].signature, before, after, viewerImprovementPercent: 100 * (1 - after.viewerMedianMs / before.viewerMedianMs), loadImprovementPercent: 100 * (1 - after.loadMedianMs / before.loadMedianMs) };
});
assert.equal(new Set(reports.map(report => report.browser)).size, 1, 'Browser changed between runs');
const report = { at: new Date().toISOString(), order: reports.map(report => report.variant), browser: reports[0].browser, beforeSha256: reports[0].viewerSha256, afterSha256: reports[1].viewerSha256, repetitionsPerVariant: { snapOffLoads: 6, snapOnLoads: 6, panRenders: 80, snapEnables: 2 }, comparisons, limits: reports[0].limits, rawReports: reports.map((_, index) => `${index + 1}-${reports[index].variant}/report.json`) };
fs.writeFileSync(path.join(out, 'comparison.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
