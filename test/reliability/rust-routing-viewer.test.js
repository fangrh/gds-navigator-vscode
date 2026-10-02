'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { startServer } = require('../../scripts/serve-web.cjs');
const { verifyArtifact } = require('../../scripts/geometry-artifact.cjs');

async function main() {
    verifyArtifact();
    const browserPath = process.env.GDS_BROWSER;
    assert(browserPath && fs.existsSync(browserPath), 'Set GDS_BROWSER to a Chromium executable');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-rust-worker-'));
    fs.writeFileSync(path.join(temp, 'empty.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }));
    const host = await startServer({ port: 0, root: temp, file: 'empty.geojson', stateDir: path.join(temp, 'state') });
    let browser;
    try {
        browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--no-first-run'] });
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', e => errors.push(e.message));
        // Match the extension's script/worker policy, including Wasm permission.
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.isNavigationRequest() && request.url() === host.url + '/') {
                const { renderViewer } = require('../../scripts/render-viewer.cjs');
                const csp = "default-src 'none'; worker-src blob:; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; font-src 'self'";
                const body = renderViewer({ browser: true }).replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="' + csp + '">');
                void request.respond({ status: 200, contentType: 'text/html', body });
            } else void request.continue();
        });
        await page.goto(host.url, { waitUntil: 'networkidle0' });
        const report = await page.evaluate(async () => {
            const rectangle = (x, y, w, h) => ({ rings: [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]] });
            const obstacles = [rectangle(14, -4, 6, 8)].concat(Array.from({ length: 250 }, (_, i) => rectangle((i % 25) * 8 - 80, 20 + Math.floor(i / 25) * 8, 2, 2)));
            const spec = { start: [0, 0], end: [35, 0], gridSize: 1, width: 1, clearance: 1, obstacles };
            const geometryModule = GdsGeometryKernel.getModule();
            if (!(geometryModule instanceof WebAssembly.Module)) throw Error('Packaged Wasm failed under the extension CSP');
            const source = window.routePlannerWorkerSource + `
                self.onmessage=function(e){
                    GdsGeometryKernel.setModule(e.data.geometryModule);
                    var nativeCreates=0,nativeQueries=0,nativeDisposed=0;
                    var create=GdsGeometryKernel.create;
                    GdsGeometryKernel.create=function(obstacles){
                        var context=create(obstacles);if(!context)return null;nativeCreates++;
                        return {clear:function(a,b,r){nativeQueries++;return context.clear(a,b,r);},dispose:function(){nativeDisposed++;context.dispose();}};
                    };
                    var result=RoutePlanner.plan(e.data.spec);
                    self.postMessage({result,nativeCreates,nativeQueries,nativeDisposed});
                };`;
            async function run(module) {
                const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
                const worker = new Worker(url); URL.revokeObjectURL(url);
                try {
                    return await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => reject(Error('Rust worker timed out')), 10000);
                        worker.onerror = e => { clearTimeout(timer); reject(Error(e.message)); };
                        worker.onmessage = e => { clearTimeout(timer); resolve(e.data); };
                        worker.postMessage({ geometryModule: module, spec });
                    });
                } finally { worker.terminate(); }
            }
            const accelerated = await run(geometryModule), fallback = await run(null);
            if (JSON.stringify(accelerated.result) !== JSON.stringify(fallback.result)) throw Error('Rust/JS worker routes differ');
            if (!accelerated.result.ok || accelerated.nativeCreates !== 1 || !accelerated.nativeQueries || accelerated.nativeDisposed !== 1) throw Error('Rust execution or cleanup missing');
            if (fallback.nativeCreates || fallback.nativeQueries) throw Error('Unavailable Wasm did not fall back');
            // A terminated task cannot publish a route into the next task.
            const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            const cancelled = new Worker(url); URL.revokeObjectURL(url);
            let delivered = false; cancelled.onmessage = () => { delivered = true; };
            cancelled.postMessage({ geometryModule, spec }); cancelled.terminate();
            await new Promise(resolve => setTimeout(resolve, 50));
            if (delivered) throw Error('Cancelled worker delivered a stale result');
            return { status: 'passed', csp: true, compiledModuleTransfer: true, nativeQueries: accelerated.nativeQueries, nativeDisposed: accelerated.nativeDisposed, fallback: true, cancellation: true, route: accelerated.result };
        });
        assert.deepEqual(errors, []);
        const out = path.resolve(__dirname, '../../logs/reliability/rust-routing');
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, 'browser-report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ ...report, route: { ok: report.route.ok, stats: report.route.stats } }));
    } finally {
        if (browser) await browser.close();
        await host.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
