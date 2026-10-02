#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
const BROWSER = [process.env.GDS_BROWSER, 'C:/Users/fangr/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe'].filter(Boolean).find(fs.existsSync);
assert(fs.existsSync(BROWSER), 'required GDS_BROWSER headless shell is missing');
const GDS = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { element_id: 'block', layer: 1, data_type: 0, color: '#f38ba8' }, geometry: { type: 'Polygon', coordinates: [[[14, -4], [20, -4], [20, 4], [14, 4], [14, -4]]] } }] };

function startServer() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
            let body, type;
            if (pathname === '/route.json') { body = JSON.stringify(GDS); type = 'application/json'; }
            else {
                const file = path.resolve(ROOT, pathname.replace(/^\/+/, ''));
                if ((file !== ROOT && !file.startsWith(ROOT + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
                body = fs.readFileSync(file); type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file).toLowerCase()] || 'application/octet-stream');
            }
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body);
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

async function main() {
    cp.execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-standalone.js')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    const out = path.join(ROOT, 'logs/reliability/route-assist'); fs.mkdirSync(out, { recursive: true });
    const { server, port } = await startServer();
    const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 900 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    try {
        await page.goto(`http://127.0.0.1:${port}/webview/test-standalone.html?data=/route`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => window.allFeatures && allFeatures.length === 1);
        await page.evaluate(() => { currentLayoutHash = 'route-hash'; map.updateSize(); map.getView().fit([-2, -12, 38, 12], { size: map.getSize(), padding: [80, 80, 80, 80], duration: 0 }); map.renderSync(); });
        const point = xy => page.evaluate(c => { const p = map.getPixelFromCoordinate(c), r = map.getTargetElement().getBoundingClientRect(); return [p[0] + r.left, p[1] + r.top]; }, xy);
        const clickPoint = async xy => { const p = await point(xy); await page.mouse.click(p[0], p[1]); };
        const enterRoute = async method => {
            await page.click('#route-btn');
            await page.select('#route-method', method);
            await page.waitForFunction(() => !document.getElementById('route-assist-controls').hidden);
        };
        const segmentDistanceToRect = (a, b, rect) => {
            const pointSegment = (p, u, v) => { const dx = v[0] - u[0], dy = v[1] - u[1], d = dx * dx + dy * dy; const t = d ? Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / d)) : 0; return Math.hypot(p[0] - (u[0] + t * dx), p[1] - (u[1] + t * dy)); };
            if (a[0] >= rect.x0 && a[0] <= rect.x1 && a[1] >= rect.y0 && a[1] <= rect.y1 || b[0] >= rect.x0 && b[0] <= rect.x1 && b[1] >= rect.y0 && b[1] <= rect.y1) return 0;
            const edges = [[[rect.x0, rect.y0], [rect.x1, rect.y0]], [[rect.x1, rect.y0], [rect.x1, rect.y1]], [[rect.x1, rect.y1], [rect.x0, rect.y1]], [[rect.x0, rect.y1], [rect.x0, rect.y0]]];
            return Math.min(...edges.flatMap(edge => [pointSegment(edge[0], a, b), pointSegment(edge[1], a, b)]));
        };
        const expandedClear = (points, radius, rectangles = [{ x0: 14, x1: 20, y0: -4, y1: 4 }]) => {
            for (let i = 1; i < points.length; i++) {
                const a = points[i - 1], b = points[i];
                if (rectangles.some(rect => segmentDistanceToRect(a, b, rect) < radius - 1e-6)) return false;
            }
            return true;
        };

        // Automatic endpoints: preview remains transient until Use route.
        await enterRoute('auto');
        await clickPoint([0, 0]); await clickPoint([35, 0]); await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.getElementById('route-use').disabled);
        const preview = await page.evaluate(() => ({ committed: drawSource.getFeatures().filter(f => f.get('route')).length, points: JSON.parse(document.getElementById('route-points').value) }));
        assert.equal(preview.committed, 0, 'route preview committed before approval');
        const closePoint = (actual, expected) => Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) < 0.02;
        assert(closePoint(preview.points[0], [0, 0]), JSON.stringify(preview.points[0])); assert(closePoint(preview.points.at(-1), [35, 0]), JSON.stringify(preview.points.at(-1)));
        assert(expandedClear(preview.points, 1.5), JSON.stringify(preview.points));
        await page.click('#route-use'); await page.waitForFunction(() => drawSource.getFeatures().some(f => f.get('route')));
        const committed = await page.evaluate(() => drawSource.getFeatures().find(f => f.get('route')).getGeometry().getCoordinates());
        assert(closePoint(committed[0], preview.points[0])); assert(closePoint(committed.at(-1), preview.points.at(-1))); assert(expandedClear(committed, 1.5));

        // A guided reference above the obstacle biases the selected route upward.
        await page.evaluate(() => { drawSource.clear(); routeAssist.reset(); });
        await enterRoute('guided'); await page.click('#route-redraw');
        await clickPoint([0, 0]); await clickPoint([0, 8]); await clickPoint([35, 8]); await clickPoint([35, 0]); await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.getElementById('route-use').disabled);
        const guided = await page.evaluate(() => JSON.parse(document.getElementById('route-points').value));
        assert(closePoint(guided[0], [0, 0]) && closePoint(guided.at(-1), [35, 0])); assert(guided.some(p => p[1] >= 5.5), JSON.stringify(guided));
        await page.click('#route-cancel-preview'); await page.waitForFunction(() => document.getElementById('route-use').disabled);
        assert.equal(await page.evaluate(() => drawSource.getFeatures().some(f => f.get('route'))), false, 'cancel retained a route');

        // Settings invalidate a ready preview and disable Use route.
        await page.click('#route-redraw'); await clickPoint([0, 0]); await clickPoint([0, 8]); await clickPoint([35, 8]); await clickPoint([35, 0]); await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.getElementById('route-use').disabled);
        await page.$eval('#route-clearance', el => { el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
        await page.waitForFunction(() => document.getElementById('route-use').disabled);
        assert.match(await page.$eval('#route-error', el => el.textContent), /Find the route|obstacle|route/i);

        // Inject a real opaque image with a contrasting center rectangle.
        await page.evaluate(async () => {
            const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32; const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 32, 32); ctx.fillStyle = 'black'; ctx.fillRect(12, 12, 8, 8);
            const img = new Image(); img.src = canvas.toDataURL('image/png'); await img.decode();
            const state = { imageId: 'synthetic-route-image', name: 'synthetic opaque image', img, cx: 25, cy: 0, umPerPx: 1, rotDeg: 0, opacity: 1, visible: true, locked: true, markerTransform: null, markerPose: null, quality: { status: 'unverified', boundaryRmsPx: null, markerCount: 0 }, options: { markerAppearance: 'yellow', markerLayers: ['1/0'] } };
            microImages.push(state); microImg = state; window.__routeImageState = state; routeAssist.invalidate();
        });
        await page.click('#route-mask'); await page.waitForFunction(() => /[1-9]\d* blocked mask cells/.test(document.getElementById('route-error').textContent));
        const maskInfo = await page.$eval('#route-error', el => el.textContent); assert.match(maskInfo, /blocked mask cells/);

        // Plan with both the GDS rectangle and the image-derived rectangle active.
        await page.select('#route-method', 'auto'); await page.click('#route-redraw');
        await clickPoint([0, 0]); await clickPoint([35, 0]); await page.keyboard.press('Enter'); await page.waitForFunction(() => !document.getElementById('route-use').disabled);
        const imageRoute = await page.evaluate(() => JSON.parse(document.getElementById('route-points').value));
        assert(expandedClear(imageRoute, 1.5, [{ x0: 14, x1: 20, y0: -4, y1: 4 }, { x0: 21, x1: 29, y0: -4, y1: 4 }]));
        await page.screenshot({ path: path.join(out, 'combined-mask-route-preview.png'), fullPage: true });
        await page.click('#route-cancel-preview');

        // Replace the image with low-contrast pixels to exercise the explicit
        // no-contour feedback at a high threshold.
        await page.evaluate(async () => { const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32; const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgb(100,100,100)'; ctx.fillRect(0, 0, 16, 32); ctx.fillStyle = 'rgb(108,108,108)'; ctx.fillRect(16, 0, 16, 32); const img = new Image(); img.src = canvas.toDataURL('image/png'); await img.decode(); window.__routeImageState.img = img; routeAssist.invalidate(); });
        await page.$eval('#route-threshold', el => { el.value = '255'; el.dispatchEvent(new Event('input', { bubbles: true })); });
        await page.click('#route-mask'); await page.waitForFunction(() => /No contours detected/.test(document.getElementById('route-error').textContent));
        await page.screenshot({ path: path.join(out, 'route-assist.png'), fullPage: true });
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ status: 'passed', autoPreviewTransient: true, clearanceChecked: true, guidedBias: true, cancel: true, stalePreviewInvalidation: true, imageMaskNonempty: true, noContourInfo: true }, null, 2));
        console.log('Route assist browser interactions passed');
    } catch (error) {
        await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
        fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ status: 'failed', error: String(error), pageErrors: errors }, null, 2));
        throw error;
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
