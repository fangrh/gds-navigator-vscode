#!/usr/bin/env node
'use strict';
// Repeatable measurements of the actual shared editor in a browser, without VS Code.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer-core');
const { startServer } = require('./serve-web.cjs');
const ROOT = path.resolve(__dirname, '..');
const executable = [process.env.GDS_BROWSER,
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean).find(fs.existsSync);
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];

async function main() {
    if (!executable) throw new Error('Set GDS_BROWSER to a Chromium/Chrome/Edge executable.');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-web-profile-'));
    const out = path.resolve(process.env.GDS_PROFILE_OUT || path.join(ROOT, 'logs/reliability/browser-performance')); fs.mkdirSync(out, { recursive: true });
    const sizes = [1000, 10000];
    for (const count of sizes) {
        const features = Array.from({ length: count }, (_, i) => {
            const x = (i % 100) * 12, y = Math.floor(i / 100) * 12;
            return { type: 'Feature', properties: { layer: i % 8, data_type: 0, color: ['#4ecdc4', '#ff6b6b', '#45b7d1', '#96ceb4'][i % 4], bbox: [x, y, x + 8, y + 8] }, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 8, y], [x + 8, y + 8], [x, y + 8], [x, y]]] } };
        });
        fs.writeFileSync(path.join(temp, `${count}.geojson`), JSON.stringify({ type: 'FeatureCollection', features }));
    }
    const host = await startServer({ port: 0, root: temp, stateDir: path.join(temp, 'state'), file: '1000.geojson' });
    let browser;
    try {
        browser = await puppeteer.launch({ executablePath: executable, headless: true, args: ['--no-first-run'] });
        const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 900 });
        const viewerPath = path.resolve(process.env.GDS_PROFILE_VIEWER || path.join(ROOT, 'webview/viewer.html'));
        const { renderViewer } = require('./render-viewer.cjs');
        const viewerHtml = renderViewer({ browser: true, viewerPath });
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.isNavigationRequest() && request.frame() === page.mainFrame() && request.url() === host.url + '/') {
                void request.respond({ status: 200, contentType: 'text/html', body: viewerHtml });
            } else void request.continue();
        });
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.goto(host.url, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => typeof allFeatures !== 'undefined' && allFeatures.length === 1000);
        const profiler = await page.createCDPSession();
        await profiler.send('Profiler.enable');
        await profiler.send('Profiler.setSamplingInterval', { interval: 500 });
        await profiler.send('Profiler.start');
        await page.evaluate(() => {
            window.__profileStages = {};
            const wrap = (owner, key, name) => {
                const original = owner[key];
                owner[key] = function (...args) {
                    const start = performance.now();
                    try { return original.apply(this, args); }
                    finally { const item = window.__profileStages[name] ||= { ms: 0, calls: 0, samplesMs: [] }; const ms = performance.now() - start; item.ms += ms; item.calls++; item.samplesMs.push(ms); }
                };
            };
            wrap(window, 'loadGdsData', 'viewerLoad');
            wrap(source, 'clear', 'sourceClear');
            wrap(source, 'addFeatures', 'sourceAdd');
            wrap(window, 'refreshPortOverlay', 'ports');
            wrap(window, 'buildLegend', 'legend');
            wrap(window, 'updateModeIndicator', 'provenanceIndicator');
        });
        const runs = [];
        for (const count of sizes) {
            // Warm each size and fit the whole layout before timing repeated loads.
            await page.evaluate(async file => {
                await window.__gdsDebug.load(file); fitView(); map.renderSync();
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }, `${count}.geojson`);
            await page.evaluate(() => { window.__profileStages = {}; });
            const loadMs = [];
            for (let i = 0; i < 3; i++) {
                loadMs.push(await page.evaluate(async file => {
                    const start = performance.now(); await window.__gdsDebug.load(file);
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    return performance.now() - start;
                }, `${count}.geojson`));
            }
            const render = await page.evaluate(() => {
                const center = map.getView().getCenter().slice(), resolution = map.getView().getResolution();
                const times = [];
                for (let i = 0; i < 40; i++) {
                    const start = performance.now();
                    map.getView().setCenter([center[0] + (i % 2 ? 5 : -5) * resolution, center[1]]); map.renderSync();
                    times.push(performance.now() - start);
                }
                map.getView().setCenter(center); map.renderSync();
                return { times, features: allFeatures.length, sourceFeatures: source.getFeatures().length, selected: selectedFeatures.getLength(), annotations: drawSource.getFeatures().length };
            });
            assert.equal(render.features, count); assert.equal(render.sourceFeatures, count); assert.equal(render.annotations, 0);
            const metrics = await page.metrics();
            const stages = await page.evaluate(() => window.__profileStages);
            const snapshot = await page.evaluate(() => allFeatures.map(f => ({ geometry: f.getGeometry().getCoordinates(), elementId: f.get('elementId'), layer: f.get('layer'), layerKey: f.get('layerKey'), color: f.get('color'), visible: f.get('visible'), selected: f.get('selected'), provenance: f.get('provenance'), meta: f.get('meta') })));
            const signature = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
            const snapEnableMs = await page.evaluate(() => {
                const start = performance.now(); toggleSnap(); return performance.now() - start;
            });
            const snapActiveLoadMs = [];
            await page.evaluate(() => { window.__profileStages = {}; });
            for (let i = 0; i < 3; i++) {
                snapActiveLoadMs.push(await page.evaluate(async file => {
                    const start = performance.now(); await window.__gdsDebug.load(file);
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    if (!snapActive || snapGds.getMap() !== map) throw new Error('Reload lost snapping');
                    return performance.now() - start;
                }, `${count}.geojson`));
            }
            const snapActiveStages = await page.evaluate(() => { toggleSnap(); return window.__profileStages; });
            runs.push({ features: count, loadMs, loadMedianMs: percentile(loadMs, .5), panRenderMedianMs: percentile(render.times, .5), panRenderP95Ms: percentile(render.times, .95), panRenderSamplesMs: render.times, jsHeapUsedBytes: metrics.JSHeapUsedSize, sourceFeatures: render.sourceFeatures, signature, snapEnableMs, stages, snapActiveLoadMs, snapActiveStages });
        }
        const { profile } = await profiler.send('Profiler.stop');
        fs.writeFileSync(path.join(out, 'browser.cpuprofile'), JSON.stringify(profile));
        const nodeById = new Map(profile.nodes.map(node => [node.id, node]));
        const totals = new Map();
        profile.samples.forEach((id, index) => {
            const frame = nodeById.get(id).callFrame;
            const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').at(-1)}:${frame.lineNumber + 1}`;
            totals.set(key, (totals.get(key) || 0) + profile.timeDeltas[index] / 1000);
        });
        const cpuSelf = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([functionName, ms]) => ({ functionName, ms }));
        assert.deepEqual(errors, []);
        const report = { at: new Date().toISOString(), browser: await browser.version(), viewport: { width: 1400, height: 900 }, viewerPath, viewerSha256: crypto.createHash('sha256').update(fs.readFileSync(viewerPath)).digest('hex'), fixture: 'deterministic 8-layer square grid, 100 columns, fitted to the viewport before timing', repetitions: { snapOffLoads: 3, snapOnLoads: 3, panRender: 40 }, runs, cpuSelf, errors, limits: 'Local Chromium headless observations with CPU sampling enabled. Stage times are inclusive and may overlap. Load includes HTTP, JSON, viewer work and two animation frames. Snapping is off during the primary loads/pans; enabling it builds its index on demand. Separate active-snap load times include rebuilding that index. renderSync timing is CPU-side browser work, not GPU completion or universal FPS; heap is JavaScript only. Compare like-for-like on the same machine/browser. Snapshot comparison replaces viewer.html only; all other assets are current.' };
        fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
        await page.screenshot({ path: path.join(out, '10000-features.png') });
        console.log(JSON.stringify({ report: path.join(out, 'report.json'), runs: runs.map(({ panRenderSamplesMs, ...run }) => run) }, null, 2));
    } finally { if (browser) await browser.close(); await host.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
