'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const puppeteer = require('puppeteer-core');
const { startServer } = require('../../scripts/serve-web.cjs');
const { renderViewer } = require('../../scripts/render-viewer.cjs');
const baseline = require('../fixtures/source-selection-baseline.json');

async function main() {
    assert(process.env.GDS_BROWSER && fs.existsSync(process.env.GDS_BROWSER), 'Set GDS_BROWSER');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-source-lookup-'));
    const features = Array.from({ length: 1000 }, (_, i) => ({ type: 'Feature', properties: { element_id: 'node-' + i, layer: 1, data_type: 0, color: '#89b4fa', provenance: {
        file: i < 80 ? 'build.py' : 'unrelated.py', line: i < 80 ? 20 : i, instance_name: 'instance-' + Math.floor(i / 4), loop_index: [Math.floor(i / 20)], array_index: [[Math.floor(i / 4) % 5, i % 4]],
        ...(i % 25 === 0 ? { call_chain: [{ resolved_file: 'build.py', line: '20' }] } : {})
    } }, geometry: { type: 'Polygon', coordinates: [[[i, 0], [i + .5, 0], [i + .5, 1], [i, 1], [i, 0]]] } }));
    features[0].properties.provenance = { call_chain: [{ file: 'build.py', line: 20 }] };
    fs.writeFileSync(path.join(temp, 'layout.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
    const host = await startServer({ port: 0, root: temp, file: 'layout.geojson', stateDir: path.join(temp, 'state') });
    let browser;
    try {
        browser = await puppeteer.launch({ executablePath: process.env.GDS_BROWSER, headless: true, args: ['--no-first-run'] });
        const reports = [];
        for (const before of [true, false]) {
            const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
            await page.setRequestInterception(true);
            page.on('request', request => {
                if (request.isNavigationRequest() && request.url() === host.url + '/') {
                    let html = renderViewer({ browser: true });
                    if (before) html = html.replace('</body>', '<script>' + Object.values(baseline.functions).join('\n') + '</script></body>');
                    void request.respond({ status: 200, contentType: 'text/html', body: html });
                } else void request.continue();
            });
            await page.goto(host.url, { waitUntil: 'networkidle0' });
            await page.waitForFunction(() => allFeatures.length === 1000);
            const result = await page.evaluate(() => {
                const ids = () => selectedFeatures.getArray().map(f => allFeatures.indexOf(f));
                let scans = 0; const filter = allFeatures.filter;
                allFeatures.filter = function () { scans++; return filter.apply(this, arguments); };
                _selectFeaturesBySource('BUILD.PY', '20'); const first = ids();
                const lookupBuilt = !!sourceSelectionLookup;
                scans = 0; _selectFeaturesBySource('build.py', 20); const warmScans = scans, warm = ids();
                const changed = allFeatures[900];
                changed.set('provenance', { file: 'build.py', line: 20, instance_name: 'new' });
                _selectFeaturesBySource('build.py', 20); const replaced = ids();
                replaceSelection([allFeatures[1]]);selectionCycle=0;const ladder=[];
                for(let i=0;i<6;i++){handleCtrlA();ladder.push({ids:ids(),cycle:selectionCycle,label:document.getElementById('cycle-indicator').textContent});}
                delete allFeatures.filter;
                const data={type:'FeatureCollection',features:[{type:'Feature',properties:{element_id:'fresh',layer:2,color:'#abc',provenance:{file:'new.py',line:3}},geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}}]};
                loadGdsData(data,'fresh.gds','',[],'partial');const reset=sourceSelectionLookup===null;
                _selectFeaturesBySource('build.py',20);const stale=ids();
                _selectFeaturesBySource('new.py',3);const fresh=ids();
                map.getView().cancelAnimations();
                return {first,warm,warmScans,lookupBuilt,replaced,ladder,reset,stale,fresh};
            });
            assert.deepEqual(errors, []); reports.push(result); await page.close();
        }
        const [before, after] = reports;
        for(const field of ['first','warm','replaced','ladder','stale','fresh'])assert.deepEqual(after[field],before[field],field+' changed');
        assert.equal(after.lookupBuilt,true);assert.equal(after.warmScans,0);assert.equal(before.warmScans,2);assert(after.reset);
        assert(after.replaced.includes(900));assert.equal(after.first[0],1,'chain-only row preceded direct matches');
        assert.deepEqual(after.fresh,[0]);assert.deepEqual(after.stale,[]);
        const out=path.resolve(__dirname,'../../logs/next-performance/source');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'viewer-report.json'),JSON.stringify({status:'passed',before,after},null,2));
        console.log(JSON.stringify({status:'passed',warmFullScans:[before.warmScans,after.warmScans],orderedSource:true,ctrlALadder:true,replacementInvalidation:true,reloadReset:true}));
    } finally {if(browser)await browser.close();await host.close();fs.rmSync(temp,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
