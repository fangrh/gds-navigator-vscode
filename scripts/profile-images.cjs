'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { closeOwnedBrowser } = require('./process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '..');
const currentPath = path.join(ROOT, 'webview/microscope-overlay.js');
const beforePath = path.resolve(process.argv[2] || path.join(ROOT, 'logs/broad-performance/before/microscope-overlay.js'));
if (!fs.existsSync(beforePath)) throw new Error(`Saved original overlay source is required: ${beforePath}`);
const currentSource = fs.readFileSync(currentPath, 'utf8');
const beforeSource = fs.readFileSync(beforePath, 'utf8');
const browserPath = process.env.GDS_BROWSER;
assert(browserPath && fs.existsSync(browserPath), 'Set GDS_BROWSER to a Chromium executable');

const percentile = (items, fraction) => [...items].sort((a, b) => a - b)[Math.floor((items.length - 1) * fraction)];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const cases = [
    { width: 256, height: 256 },
    { width: 1024, height: 768 },
    { width: 2000, height: 1500 },
];
const displays = [
    { name: 'image', value: { mode: 'image', threshold: 40, color: '#00ffff', width: 1, border: false } },
    { name: 'border', value: { mode: 'image', threshold: 40, color: '#00ffff', width: 2, border: true } },
    { name: 'contours', value: { mode: 'contours', threshold: 40, color: '#00ffff', width: 1, border: false } },
];

async function runVariant(browser, source, size, display) {
    const page = await browser.newPage();
    try {
        await page.setContent('<body></body>');
        await page.addScriptTag({ path: path.join(ROOT, 'webview/numbered-marker-alignment.js') });
        await page.addScriptTag({ content: source });
        return await page.evaluate(async ({ width, height, display }) => {
            const sourceCanvas = document.createElement('canvas'); sourceCanvas.width = width; sourceCanvas.height = height;
            const sourceContext = sourceCanvas.getContext('2d'); const imageData = sourceContext.createImageData(width, height);
            for (let i = 0; i < imageData.data.length; i++) imageData.data[i] = (i * 29 + (i >> 5) * 17 + width + height) & 255;
            sourceContext.putImageData(imageData, 0, 0);
            const image = new Image(); image.src = sourceCanvas.toDataURL('image/png'); await image.decode();
            const makeState = (step, nextDisplay) => ({ img: image, cx: width / 2 + (step % 2 ? .37 : -.29), cy: height / 2 + (step % 3 ? -.21 : .33), umPerPx: 1, rotDeg: 9 + step * 2.5, opacity: 1, visible: true, locked: true, markerTransform: null, markerPose: null, options: { markerAppearance: 'yellow', markerLayers: ['1/0'] }, quality: { status: 'unverified', boundaryRmsPx: null, markerCount: 0 }, display: nextDisplay });
            const samples = [], specs = Array.from({ length: 6 }, (_, step) => makeState(step, display));
            // Warm decode and one render before timed alternating pose updates.
            MicroscopeOverlay.render(image, makeState(-1, display));
            for (const state of specs) {
                const start = performance.now(); const output = MicroscopeOverlay.render(image, state); const elapsedMs = performance.now() - start;
                samples.push({ elapsedMs, url: output.url, width: output.canvas.width, height: output.canvas.height, extent: output.extent, transform: output.transform });
            }
            const colorSamples = [];
            for (const color of ['#ff0000', '#00ff00', '#0000ff']) {
                const start = performance.now(); const output = MicroscopeOverlay.render(image, makeState(5, { ...display, color }));
                colorSamples.push({ elapsedMs: performance.now() - start, url: output.url });
            }
            return { samples, colorSamples };
        }, { ...size, display: display.value });
    } finally { await page.close(); }
}

async function main() {
    const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--no-first-run'] });
    try {
        const runs = [];
        for (const size of cases) for (const display of displays) {
            const variants = [{ name: 'current-js', source: currentSource }, { name: 'saved-original-js', source: beforeSource }];
            const results = { 'current-js': [], 'saved-original-js': [] };
            for (let repeat = 0; repeat < 2; repeat++) {
                const ordered = repeat % 2 ? [...variants].reverse() : variants;
                for (const variant of ordered) results[variant.name].push(await runVariant(browser, variant.source, size, display));
            }
            const current = results['current-js'], original = results['saved-original-js'];
            for (let repeat = 0; repeat < 2; repeat++) {
                const actual = current[repeat], expected = original[repeat];
                assert.deepEqual(actual.samples.map(x => sha(Buffer.from(x.url.split(',')[1], 'base64'))), expected.samples.map(x => sha(Buffer.from(x.url.split(',')[1], 'base64'))), `current/original PNG mismatch for ${display.name} ${size.width}x${size.height}, pair ${repeat}`);
                assert.deepEqual(actual.colorSamples.map(x => sha(Buffer.from(x.url.split(',')[1], 'base64'))), expected.colorSamples.map(x => sha(Buffer.from(x.url.split(',')[1], 'base64'))), `cached display PNG mismatch for ${display.name} ${size.width}x${size.height}, pair ${repeat}`);
                assert.deepEqual(actual.samples.map(x => ({ width: x.width, height: x.height, extent: x.extent, transform: x.transform })), expected.samples.map(x => ({ width: x.width, height: x.height, extent: x.extent, transform: x.transform })), `current/original geometry mismatch for ${display.name} ${size.width}x${size.height}, pair ${repeat}`);
            }
            const summarize = values => {
                const samples = values.flatMap(result => result.samples).map(sample => ({ elapsedMs: sample.elapsedMs, pngSha256: sha(Buffer.from(sample.url.split(',')[1], 'base64')), width: sample.width, height: sample.height, extent: sample.extent, transform: sample.transform }));
                const colorSamples = values.flatMap(result => result.colorSamples).map(sample => ({ elapsedMs: sample.elapsedMs, pngSha256: sha(Buffer.from(sample.url.split(',')[1], 'base64')) }));
                return { samples, colorSamples, medianMs: percentile(samples.map(x => x.elapsedMs), .5), p95Ms: percentile(samples.map(x => x.elapsedMs), .95), colorMedianMs: percentile(colorSamples.map(x => x.elapsedMs), .5) };
            };
            runs.push({ size, display: display.name, variants: Object.fromEntries(Object.entries(results).map(([name, values]) => [name, summarize(values)])), parity: 'passed' });
        }
        const out = path.resolve(process.env.GDS_IMAGE_PROFILE_OUT || path.join(ROOT, 'logs/broad-performance/images'));
        fs.mkdirSync(out, { recursive: true });
        const markerSource = fs.readFileSync(path.join(ROOT, 'webview/numbered-marker-alignment.js'), 'utf8');
        const report = { status: 'passed', at: new Date().toISOString(), browser: await browser.version(), currentSourceSha256: sha(currentSource), markerSourceSha256: sha(markerSource), beforeSource: beforePath, beforeSourceSha256: sha(beforeSource), cases, displays: displays.map(x => x.name), poseSamplesPerVariant: 12, variantOrder: ['current-js','saved-original-js','saved-original-js','current-js'], runs, limits: 'Fresh Chromium page per variant/case; image decode warmed once. Timed render includes bilinear image warp, display processing, canvas putImageData and PNG data URL encoding. All returned PNG bytes and extents match the saved original. Color-only samples are reported separately because the existing warped-image cache avoids another warp.' };
        fs.writeFileSync(path.join(out, 'profile.json'), `${JSON.stringify(report, null, 2)}\n`);
        console.log(JSON.stringify({ report: path.join(out, 'profile.json'), cases: runs.length, status: report.status }));
    } finally { await closeOwnedBrowser(browser); }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
