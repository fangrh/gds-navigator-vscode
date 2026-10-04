'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer-core');
const { closeOwnedBrowser } = require('./process-cleanup.cjs');
const { startServer } = require('./serve-web.cjs');
const { verifyArtifact } = require('./geometry-artifact.cjs');
const ROOT = path.resolve(__dirname, '..');
const percentile = (items, fraction) => [...items].sort((a, b) => a - b)[Math.floor((items.length - 1) * fraction)];

async function main() {
    const artifact = verifyArtifact(), browserPath = process.env.GDS_BROWSER;
    assert(browserPath && fs.existsSync(browserPath), 'Set GDS_BROWSER to a Chromium executable');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-rust-profile-'));
    fs.writeFileSync(path.join(temp, 'empty.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }));
    const out = path.resolve(process.env.GDS_RUST_PROFILE_OUT || path.join(ROOT, 'logs/rust-performance/paired'));
    fs.mkdirSync(out, { recursive: true });
    const host = await startServer({ port: 0, root: temp, file: 'empty.geojson', stateDir: path.join(temp, 'state') });
    let browser;
    try {
        browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--no-first-run'] });
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(host.url, { waitUntil: 'networkidle0' });
        // Optional saved original planner supports a three-way comparison.
        const originalPath = process.argv[2] && path.resolve(process.argv[2]);
        const original = originalPath && fs.readFileSync(originalPath, 'utf8');
        const runs = await page.evaluate(async original => {
            const rectangle = (x, y, w, h) => ({ rings: [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]] });
            const times = [], coldStart = performance.now(), geometryModule = GdsGeometryKernel.getModule();
            if (!geometryModule) throw Error('Rust/Wasm unavailable; refusing to time the fallback as Rust');
            const compileMs = performance.now() - coldStart;
            const variants = original ? ['original-js', 'current-js', 'rust-bvh'] : ['current-js', 'rust-bvh'];
            for (const count of [1, 250, 2500]) {
                // Keep one real barrier in the corridor; other pieces exercise
                // the cost of scanning a dense layout outside that corridor.
                const obstacles = [rectangle(14, -4, 6, 8)].concat(Array.from({ length: count - 1 }, (_, i) => rectangle((i % 100) * 3 - 80, 20 + Math.floor(i / 100) * 3, 1, 1)));
                const spec = { start: [0, 0], end: [35, 0], width: 1, clearance: 1, gridSize: 1, obstacles };
                const samples = Object.fromEntries(variants.map(variant => [variant, []]));
                let canonical;
                async function run(variant) {
                    const code = (variant === 'original-js' ? original : window.routePlannerWorkerSource) + `
                        self.onmessage=function(e){
                            if(self.GdsGeometryKernel)GdsGeometryKernel.setModule(e.data.geometryModule);
                            var start=performance.now(),result=RoutePlanner.plan(e.data.spec);
                            self.postMessage({result,planMs:performance.now()-start});
                        };`;
                    const start = performance.now(), url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
                    const worker = new Worker(url); URL.revokeObjectURL(url);
                    try {
                        const value = await new Promise((resolve, reject) => {
                            const timer = setTimeout(() => reject(Error('Profile worker timed out')), 30000);
                            worker.onerror = e => { clearTimeout(timer); reject(Error(e.message)); };
                            worker.onmessage = e => { clearTimeout(timer); resolve(e.data); };
                            worker.postMessage({ spec, geometryModule: variant === 'rust-bvh' ? geometryModule : null });
                        });
                        const workerMs = performance.now() - start, signature = JSON.stringify(value.result);
                        if (!value.result.ok) throw Error('Profile failed: ' + value.result.error);
                        if (canonical && signature !== canonical) throw Error('Routes/stats differ in ' + variant);
                        canonical = signature;
                        return { planMs: value.planMs, workerMs };
                    } finally { worker.terminate(); }
                }
                for (const variant of variants) await run(variant); // Warm all variants equally.
                for (let repeat = 0; repeat < 6; repeat++) {
                    // Alternate direction to limit ordering/JIT bias. Every run
                    // creates a fresh cancellable worker, like the editor.
                    for (const variant of repeat % 2 ? [...variants].reverse() : variants) samples[variant].push(await run(variant));
                }
                times.push({ obstacles: count, samples, result: JSON.parse(canonical) });
            }
            return { compileMs, times };
        }, original || null);
        assert.deepEqual(errors, []);
        const cases = runs.times.map(run => ({ ...run,
            routeSha256: crypto.createHash('sha256').update(JSON.stringify(run.result)).digest('hex'),
            medians: Object.fromEntries(Object.entries(run.samples).map(([variant, samples]) => [variant, {
                planMs: percentile(samples.map(s => s.planMs), .5), workerMs: percentile(samples.map(s => s.workerMs), .5),
            }])),
        }));
        const report = { at: new Date().toISOString(), browser: await browser.version(), platform: process.platform, arch: process.arch,
            artifact: { sourceSha256: artifact.sourceSha256, wasmSha256: artifact.wasmSha256, wasmBytes: Buffer.from(artifact.base64, 'base64').length },
            plannerSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'webview/route-planner.js'))).digest('hex'),
            originalPlanner: originalPath || null, originalSha256: original && crypto.createHash('sha256').update(original).digest('hex'),
            compileMs: runs.compileMs, repetitions: 6, cases, errors,
            limits: 'Same-machine headless Chromium, alternating variant order and fresh workers. planMs includes packing, Wasm instantiation, BVH construction, search and final collision validation. workerMs also includes worker creation, structured cloning and message delivery. First main-thread Wasm compilation is reported separately. Deterministic rectangular synthetic layouts measure autorouting, not load/pan/FPS, whole-editor or installed VS Code performance. Rust and spatial indexing change together; this does not isolate language-only speedup.' };
        fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ report: path.join(out, 'report.json'), compileMs: report.compileMs, cases: cases.map(({ obstacles, medians, routeSha256 }) => ({ obstacles, medians, routeSha256 })) }, null, 2));
    } finally {
        let stopped = !browser;
        try { if (browser) { await closeOwnedBrowser(browser); stopped = true; } }
        finally {
            try { await host.close(); }
            finally { if (stopped) fs.rmSync(temp, { recursive: true, force: true }); }
        }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
