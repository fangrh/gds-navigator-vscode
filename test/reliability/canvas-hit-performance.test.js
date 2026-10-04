'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
const requestedBrowser = process.env.CHROME_PATH || process.env.GDS_BROWSER;
if (requestedBrowser && !fs.existsSync(requestedBrowser)) {
    throw new Error(`configured browser does not exist: ${requestedBrowser}`);
}
const BROWSER = requestedBrowser || [
    path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    path.join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell'),
    path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(fs.existsSync);
assert(BROWSER, 'required Chromium headless shell is missing');

const GEOJSON = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: { element_id: 'hole', layer: 1, data_type: 0, color: '#f38ba8' },
            geometry: { type: 'Polygon', coordinates: [
                [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
                [[40, 40], [60, 40], [60, 60], [40, 60], [40, 40]],
            ] },
        },
        {
            type: 'Feature',
            properties: { element_id: 'overlap', layer: 2, data_type: 0, color: '#89b4fa' },
            geometry: { type: 'Polygon', coordinates: [[[25, 25], [75, 25], [75, 75], [25, 75], [25, 25]]] },
        },
        {
            type: 'Feature',
            properties: { element_id: 'separate', layer: 3, data_type: 0, color: '#a6e3a1' },
            geometry: { type: 'Polygon', coordinates: [[[125, 0], [175, 0], [175, 50], [125, 50], [125, 0]]] },
        },
    ],
};

async function main() {
    const startServer = require(path.join(ROOT, 'scripts', 'serve-web.cjs')).startServer;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-canvas-hit-'));
    fs.writeFileSync(path.join(temp, 'hit-fixture.geojson'), JSON.stringify(GEOJSON));
    let close = async () => {};
    let url;
    let browser;
    const pageErrors = [];
    const out = path.join(ROOT, 'logs/usability-20261004/canvas-hit');
    try {
        ({ url, close } = await startServer({ port: 0, root: temp, stateDir: path.join(temp, 'state'), file: 'hit-fixture.geojson' }));
        browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
        const page = await browser.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.evaluateOnNewDocument(() => {
        const stats = { contexts: [], imageReads: 0 };
        window.__canvasHitStats = stats;
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, options) {
            if (type === '2d') stats.contexts.push(options === undefined ? null : options);
            return originalGetContext.call(this, type, options);
        };
        const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function (...args) {
            stats.imageReads++;
            return originalGetImageData.apply(this, args);
        };
        });
        fs.mkdirSync(out, { recursive: true });

        await page.goto(url, { waitUntil: 'networkidle0' });
        await page.evaluate(() => window.__gdsReady);
        await page.waitForFunction(() => Array.isArray(window.allFeatures) && allFeatures.length === 3);
        await page.waitForFunction(() => document.querySelector('#map canvas')?.width > 0);
        await page.evaluate(() => {
            map.renderSync();
            window.__canvasHitStats.contexts = [];
            window.__canvasHitStats.imageReads = 0;
        });

        const probes = await page.evaluate(() => {
            function probe(coordinate) {
                const pixel = map.getPixelFromCoordinate(coordinate);
                const started = performance.now();
                const hits = map.getFeaturesAtPixel(pixel, { hitTolerance: 8 });
                return { coordinate, pixel, elapsedMs: performance.now() - started, ids: hits.map(feature => feature.get('elementId')), layers: hits.map(feature => feature.get('layer')) };
            }
            return { outer: probe([10, 10]), hole: probe([50, 50]), separate: probe([150, 25]) };
        });
        const stats = await page.evaluate(() => ({ ...window.__canvasHitStats }));
        assert.deepEqual(probes.outer.layers, ['1/0'], 'outer ring should hit the polygon with a hole');
        assert.deepEqual(probes.hole.layers, ['2/0'], 'a hole must allow the overlapping polygon to be hit');
        assert.deepEqual(probes.separate.layers, ['3/0'], 'separate polygon should remain selectable');
        assert(stats.contexts.length > 0 && stats.contexts.every(options => options && options.willReadFrequently === true), 'first hit did not use explicitly read-optimized canvas contexts');
        assert(stats.imageReads < 100, `first hit performed ${stats.imageReads} canvas reads; benchmark loop is still active`);

        const canvasBox = await page.$eval('#map canvas', canvas => canvas.getBoundingClientRect().toJSON());
        const selection = page.evaluate(() => new Promise(resolve => {
            const pixel = map.getPixelFromCoordinate([10, 10]);
            selectClick.once('select', event => resolve(event.selected.map(feature => feature.get('elementId'))));
            window.__hitSelectionPixel = pixel;
        }));
        const selectionPixel = await page.evaluate(() => window.__hitSelectionPixel);
        await page.mouse.click(canvasBox.left + selectionPixel[0], canvasBox.top + selectionPixel[1]);
        const selected = await selection;
        const selectionIds = await page.evaluate(() => selectedFeatures.getArray().map(feature => feature.get('elementId')));
        const selectionLayers = await page.evaluate(() => selectedFeatures.getArray().map(feature => feature.get('layer')));
        assert.deepEqual(selected, probes.outer.ids, 'select interaction result must match the direct outer-ring hit');
        assert.deepEqual(selectionIds, probes.outer.ids, 'selected feature identity must match the direct outer-ring hit');
        assert.deepEqual(selectionLayers, ['1/0'], 'real canvas click should select the polygon hit by the interaction');
        assert.deepEqual(pageErrors, [], 'canvas picking emitted a browser error');

        const report = {
            status: 'passed',
            fixture: 'real browser GeoJSON polygons: hole, overlap, separate',
            probes: { outer: probes.outer, hole: probes.hole, separate: probes.separate },
            firstHit: { imageReads: stats.imageReads, contexts: stats.contexts, maxProbeMs: Math.max(probes.outer.elapsedMs, probes.hole.elapsedMs, probes.separate.elapsedMs) },
            selectionIds,
            selectionLayers,
            pageErrors,
        };
        fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
    } catch (error) {
        fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ status: 'failed', error: String(error), pageErrors }, null, 2));
        throw error;
    } finally {
        if (browser) await browser.close();
        await close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
