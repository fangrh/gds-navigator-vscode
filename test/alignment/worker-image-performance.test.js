'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '../..');
const current = fs.readFileSync(path.join(ROOT, 'webview/numbered-marker-alignment.js'), 'utf8');
const ts = require('typescript');
const ast = ts.createSourceFile('marker.js', current, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let photo;
function find(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'photoMarkers') photo = node; ts.forEachChild(node, find); }
find(ast); assert(photo, 'photoMarkers function missing');
const original = current.slice(0, photo.getStart(ast)) + require('../fixtures/performance-baseline.json').photoMarkers + current.slice(photo.end);
const worker = fs.readFileSync(path.join(ROOT, 'webview/numbered-marker-worker.js'), 'utf8');

async function main() {
    assert(process.env.GDS_BROWSER && fs.existsSync(process.env.GDS_BROWSER), 'Set GDS_BROWSER');
    const python = process.env.GDS_PYTHON;
    assert(python && fs.existsSync(python), 'Set GDS_PYTHON to Python with klayout');
    const features = JSON.parse(cp.execFileSync(python, ['python/parse_gds.py', 'test/fixtures/jj_pad_center_100_test.gds'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).features;
    const image = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'test/fixtures/electrode100-microscope.png')).toString('base64');
    const browser = await puppeteer.launch({ executablePath: process.env.GDS_BROWSER, headless: true, args: ['--no-first-run'] });
    try {
        const page = await browser.newPage();
        const results = await page.evaluate(async ({ original, current, worker, features, image }) => {
            const photo = new Image(); photo.src = image; await photo.decode();
            async function run(source) {
                const instrumentation = `
                    var draws=0;var started=performance.now();
                    var NativeCanvas=self.OffscreenCanvas,patched=new WeakSet();
                    self.OffscreenCanvas=class extends NativeCanvas {
                        getContext(type,options){var ctx=super.getContext(type,options);if(ctx&&!patched.has(ctx)){patched.add(ctx);var draw=ctx.drawImage;ctx.drawImage=function(){draws++;return draw.apply(this,arguments);};}return ctx;}
                    };
                    var send=self.postMessage.bind(self);
                    self.postMessage=function(message){if(message.type==='result')message.performance={draws,elapsedMs:performance.now()-started};send(message);};
                `;
                const url = URL.createObjectURL(new Blob([instrumentation, source, worker], { type: 'text/javascript' }));
                const task = new Worker(url); URL.revokeObjectURL(url);
                try {
                    const bitmap = await createImageBitmap(photo);
                    return await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => reject(Error('Alignment worker timed out')), 30000);
                        task.onerror = e => { clearTimeout(timer); reject(Error(e.message)); };
                        task.onmessage = e => { if (e.data.type === 'error') { clearTimeout(timer); reject(Error(e.data.message)); } if (e.data.type === 'result') { clearTimeout(timer); resolve(e.data); } };
                        task.postMessage({ type: 'align', requestId: 1, imageBitmap: bitmap, features, options: { markerAppearance: 'yellow', markerLayers: ['1/0','8/0','9/0'] } }, [bitmap]);
                    });
                } finally { task.terminate(); }
            }
            const cases = [];
            // Full solver output must match, not only mask or component counts.
            for (const [before, after] of [[true,false],[false,true],[true,false]]) {
                const first = await run(before ? original : current), second = await run(after ? original : current);
                const legacy = before ? first : second, next = before ? second : first;
                if (JSON.stringify(legacy.result) !== JSON.stringify(next.result)) throw Error('Worker alignment changed after removing its image copy');
                if (next.result.status !== 'aligned') throw Error('Known microscope fixture did not align: ' + next.result.reason);
                cases.push({ original: legacy.performance, current: next.performance, result: next.result });
            }
            return cases;
        }, { original, current, worker, features, image });
        for (const result of results) {
            assert.equal(result.original.draws, 2); assert.equal(result.current.draws, 1);
            assert(result.result.boundaryRmsPx <= 2);
        }
        assert.equal(new Set(results.map(result => JSON.stringify(result.result.transform))).size, 1);
        const out = path.join(ROOT, 'logs/broad-performance/alignment'); fs.mkdirSync(out, { recursive: true });
        const report = { status: 'passed', browser: await browser.version(), at: new Date().toISOString(),
            originalSha256: crypto.createHash('sha256').update(original).digest('hex'), currentSha256: crypto.createHash('sha256').update(current).digest('hex'),
            cases: results, limits: 'Three alternating real-worker comparisons on the known 720x606 microscope fixture. Full solver results match exactly. drawImage copies drop from two to one; elapsed time includes worker setup and alignment and is not an isolated copy-kernel speedup.' };
        fs.writeFileSync(path.join(out, 'worker-report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ status: 'passed', repetitions: results.length, imageCopies: { before: 2, after: 1 }, rms: results[0].result.boundaryRmsPx, report: path.join(out, 'worker-report.json') }));
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
