'use strict';
// Real extension with a separate profile, workspace and driver.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const { closeOwnedProcess } = require('../../scripts/process-cleanup.cjs');
const ROOT = path.resolve(__dirname, '../..');
const EXE = process.env.VSCODE_EXE, PYTHON = process.env.GDS_PYTHON;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 60000) {
    const end = Date.now() + timeout;
    let error;
    while (Date.now() < end) {
        try { const value = await fn(); if (value) return value; } catch (e) { error = e; }
        await sleep(150);
    }
    throw new Error('Timed out: ' + (error?.message || 'condition'));
}

async function main() {
    assert(EXE && fs.existsSync(EXE), 'Set VSCODE_EXE to the VS Code application executable');
    assert(PYTHON && fs.existsSync(PYTHON), 'Set GDS_PYTHON to Python with klayout');
    require('../../scripts/geometry-artifact.cjs').verifyArtifact();
    const out = path.join(ROOT, 'logs/reliability/rust-routing/vscode');
    fs.mkdirSync(out, { recursive: true });
    const report = { status: 'running', cycles: [], startedAt: new Date().toISOString() };
    const save = () => fs.writeFileSync(path.join(out, 'vscode-report.json'), JSON.stringify(report, null, 2));
    save();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-rust-vscode-'));
    const workspace = path.join(dir, 'workspace'), bridge = path.join(dir, 'bridge'), driver = path.join(dir, 'driver');
    for (const folder of [workspace, bridge, driver, path.join(workspace, '.vscode')]) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({ 'gdsNavigator.pythonPath': PYTHON, 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false }));
    const files = Array.from({ length: 10 }, (_, i) => path.join(workspace, `chip-${i + 1}.gds`));
    for (const file of files) fs.copyFileSync(path.join(ROOT, 'test/fixtures/jj_pad_center_100_test.gds'), file);
    fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'gds-rust-test-driver', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.75.0' }, activationEvents: ['*'], main: 'main.js' }));
    const host = fs.readFileSync(path.join(__dirname, 'vscode-host.js'), 'utf8')
        .replace("else if(req.action==='stop') break;", "else if(req.action==='restoreClipboard') { const current=await vscode.env.clipboard.readText(); result=current===req.expected; if(result)await vscode.env.clipboard.writeText(previous); }\nelse if(req.action==='stop') { fs.writeFileSync(path.join(dir,'response.json'),JSON.stringify({id:req.id,result:null})); break; }")
        .replace('} finally { await vscode.env.clipboard.writeText(previous); }', '} finally {}');
    fs.writeFileSync(path.join(driver, 'main.js'), host + '\nexports.activate=()=>{exports.run().then(()=>require("vscode").commands.executeCommand("workbench.action.closeWindow"));};');
    let requestId = 0;
    async function request(action, extra = {}) {
        const req = { id: ++requestId, action, ...extra };
        fs.writeFileSync(path.join(bridge, 'request.json'), JSON.stringify(req));
        const response = await until(() => {
            const value = JSON.parse(fs.readFileSync(path.join(bridge, 'response.json'), 'utf8'));
            if (value.id !== req.id) return false;
            if (value.error) throw Error(value.error);
            return { value: value.result };
        });
        return response.value;
    }
    try {
        for (let cycle = 0; cycle < 3; cycle++) {
            for (const file of ['ready.json', 'request.json', 'response.json']) try { fs.unlinkSync(path.join(bridge, file)); } catch (_) {}
            const port = 19470 + cycle, browserURL = `http://127.0.0.1:${port}`;
            const child = cp.spawn(EXE, [workspace, '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${path.join(dir, 'profile')}`, `--extensions-dir=${path.join(dir, 'extensions')}`, `--extensionDevelopmentPath=${ROOT}`, `--extensionDevelopmentPath=${driver}`, `--remote-debugging-port=${port}`], { env: { ...process.env, GDS_TEST_BRIDGE: bridge }, stdio: ['ignore', 'pipe', 'pipe'] });
            let browser, childLog = '', lastCopy;
            child.stdout.on('data', b => { childLog += b; }); child.stderr.on('data', b => { childLog += b; });
            child.on('error', error => { childLog += error.message; });
            const cycleReport = { cycle: cycle + 1, samples: [] };
            try {
                await until(() => { if (child.exitCode !== null) throw Error('Test VS Code exited: ' + childLog); return fs.existsSync(path.join(bridge, 'ready.json')); });
                const reconnect = async () => { if (browser) await browser.disconnect(); browser = await puppeteer.connect({ browserURL, defaultViewport: null, protocolTimeout: 15000 }); };
                await reconnect();
                const clipboardBefore = await request('clipboard');
                const frameFor = file => until(async () => {
                    for (const page of await browser.pages()) for (const frame of page.frames()) {
                        try { if (await frame.evaluate(p => typeof currentGdsPath !== 'undefined' && currentGdsPath === p && typeof allFeatures !== 'undefined' && allFeatures.length > 0, file)) return frame; } catch (_) {}
                    }
                    return false;
                });
                for (let i = 0; i < files.length; i++) {
                    await request('open', { file: files[i] }); await reconnect();
                    let frame = await frameFor(files[i]);
                    const id = `rust-vscode-${i}`;
                    if (cycle === 0 && i === 0) {
                        await until(() => frame.evaluate(() => !map.getView().getAnimating()));
                        await frame.click('.tool-btn[data-mode="rectangle"]');
                        const box = await (await frame.$('#map')).boundingBox();
                        await frame.page().mouse.click(box.x + box.width * .55, box.y + box.height * .35);
                        await frame.page().mouse.move(box.x + box.width * .7, box.y + box.height * .55);
                        await frame.page().mouse.click(box.x + box.width * .7, box.y + box.height * .55);
                        await until(() => frame.evaluate(() => drawSource.getFeatures().length === 1));
                    }
                    await frame.evaluate(({ id, i, first }) => {
                        if (first) {
                            let f = drawSource.getFeatures()[0];
                            if (!f) { f = new ol.Feature(new ol.geom.Polygon([[[1.000123 + i, 2], [9 + i, 2], [9 + i, 8], [1.000123 + i, 2]]])); drawSource.addFeature(f); }
                            f.setProperties({ isDrawn: true, annotationId: id, shapeType: 'polygon', intent: { action: 'move', text: id, targetIds: [allFeatures[0].get('elementId')], snapshot: currentLayoutHash } });
                            persistAnnotations();
                        }
                        const drawings = drawSource.getFeatures();
                        if (drawings.length !== 1 || drawings[0].get('annotationId') !== id) throw Error('Annotation isolation or restoration failed');
                        replaceSelection([allFeatures[0], drawings[0]]); onSelectionChanged();
                    }, { id, i, first: cycle === 0 });
                    if (![0, 4, 9].includes(i)) continue;
                    const native = await frame.evaluate(async () => {
                        const geometryModule = GdsGeometryKernel.getModule();
                        if (!(geometryModule instanceof WebAssembly.Module)) throw Error('Real webview CSP blocked Wasm');
                        const rect = (x, y, w, h) => ({ rings: [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]] });
                        const obstacles = [rect(14, -4, 6, 8)].concat(Array.from({ length: 250 }, (_, j) => rect((j % 25) * 8 - 80, 20 + Math.floor(j / 25) * 8, 2, 2)));
                        const spec = { start: [0, 0], end: [35, 0], gridSize: 1, width: 1, clearance: 1, obstacles };
                        const code = window.routePlannerWorkerSource + '\nself.onmessage=function(e){GdsGeometryKernel.setModule(e.data.geometryModule);var c=0,q=0,d=0,create=GdsGeometryKernel.create;GdsGeometryKernel.create=function(o){var x=create(o);if(!x)return null;c++;return {clear:function(a,b,r){q++;return x.clear(a,b,r);},dispose:function(){d++;x.dispose();}};};var result=RoutePlanner.plan(e.data.spec);self.postMessage({result,c,q,d});};';
                        async function run(module) {
                            const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), worker = new Worker(url); URL.revokeObjectURL(url);
                            try { return await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Worker timed out')), 15000); worker.onerror = e => { clearTimeout(timer); reject(Error(e.message)); }; worker.onmessage = e => { clearTimeout(timer); resolve(e.data); }; worker.postMessage({ geometryModule: module, spec }); }); }
                            finally { worker.terminate(); }
                        }
                        return { accelerated: await run(geometryModule), fallback: await run(null) };
                    });
                    assert.equal(JSON.stringify(native.accelerated.result), JSON.stringify(native.fallback.result));
                    assert(native.accelerated.result.ok && native.accelerated.c === 1 && native.accelerated.q > 0 && native.accelerated.d === 1);
                    assert.equal(native.fallback.c, 0);
                    let imageParity;
                    if (i === 0) imageParity = await frame.evaluate(async () => {
                        const source = document.createElement('canvas');source.width=128;source.height=96;
                        const sc=source.getContext('2d'),raw=sc.createImageData(128,96);
                        for(let j=0;j<raw.data.length;j+=4){raw.data[j]=j%256;raw.data[j+1]=(j>>4)%256;raw.data[j+2]=77;raw.data[j+3]=255;}
                        sc.putImageData(raw,0,0);
                        const image=new Image();image.src=source.toDataURL();await image.decode();
                        const project=NumberedMarkerAlignment.project;let calls=0;
                        NumberedMarkerAlignment.project=function(h,p){calls++;return project(h,p);};
                        let rendered;
                        try{rendered=MicroscopeOverlay.render(image,{cx:64,cy:48,umPerPx:1,rotDeg:17,markerTransform:null,markerPose:null,display:MicroscopeOverlay.defaultDisplay()});}
                        finally{NumberedMarkerAlignment.project=project;}
                        const decoded=document.createElement('canvas');decoded.width=128;decoded.height=96;const dc=decoded.getContext('2d');dc.drawImage(image,0,0);const pixels=dc.getImageData(0,0,128,96).data;
                        const w=rendered.canvas.width,h=rendered.canvas.height,ext=rendered.extent,inv=NumberedMarkerAlignment.inverse(rendered.transform),expected=new Uint8ClampedArray(w*h*4);
                        for(let y=0;y<h;y++)for(let x=0;x<w;x++){
                            const p=project(inv,[ext[0]+(x+.5)*(ext[2]-ext[0])/w,ext[3]-(y+.5)*(ext[3]-ext[1])/h]);
                            const sx=p[0]-.5,sy=p[1]-.5,x0=Math.floor(sx),y0=Math.floor(sy),fx=sx-x0,fy=sy-y0;
                            if(x0<0||y0<0||x0+1>=128||y0+1>=96)continue;
                            for(let c=0;c<4;c++)expected[4*(y*w+x)+c]=(1-fy)*((1-fx)*pixels[4*(y0*128+x0)+c]+fx*pixels[4*(y0*128+x0+1)+c])+fy*((1-fx)*pixels[4*((y0+1)*128+x0)+c]+fx*pixels[4*((y0+1)*128+x0+1)+c]);
                        }
                        const actual=rendered.canvas.getContext('2d').getImageData(0,0,w,h).data;
                        return {equal:actual.length===expected.length&&actual.every((v,j)=>v===expected[j]),projectionCalls:calls,pixels:w*h};
                    });
                    if (imageParity) {assert(imageParity.equal, 'image warp differs in the actual VS Code canvas');assert.equal(imageParity.projectionCalls,4);}
                    let sourceParity;
                    if (i === 0) sourceParity = await frame.evaluate(() => {
                        const original=allFeatures.slice(0,5).map(f=>f.get('provenance'));
                        const selected=selectedFeatures.getArray().slice(),center=map.getView().getCenter().slice(),resolution=map.getView().getResolution();
                        try{
                            for(let j=0;j<4;j++)allFeatures[j].set('provenance',{file:'integration-source.py',line:77,instance_name:'integration',loop_index:[0],array_index:[[0,j]]});
                            allFeatures[4].set('provenance',{call_chain:[{file:'integration-source.py',line:'77'}]});
                            _selectFeaturesBySource('INTEGRATION-SOURCE.PY',77);
                            const source=selectedFeatures.getArray().map(f=>allFeatures.indexOf(f));
                            replaceSelection([allFeatures[0]]);selectionCycle=0;handleCtrlA();
                            return {source,ctrlA:selectedFeatures.getArray().map(f=>allFeatures.indexOf(f)),built:!!sourceSelectionLookup};
                        }finally{
                            original.forEach((p,j)=>allFeatures[j].set('provenance',p));replaceSelection(selected);selectionCycle=0;onSelectionChanged();
                            map.getView().cancelAnimations();map.getView().setCenter(center);map.getView().setResolution(resolution);
                        }
                    });
                    if(sourceParity){assert.deepEqual(sourceParity.source,[0,1,2,3,4]);assert.deepEqual(sourceParity.ctrlA,[0,1,2,3]);assert(sourceParity.built);}
                    await request('copy');
                    lastCopy = await until(async () => { const text = await request('clipboard'); return text && text.includes(id) ? text : false; });
                    assert(lastCopy.includes(files[i]), 'YAML omitted the current document path');
                    fs.writeFileSync(path.join(out, `cycle-${cycle + 1}-file-${i + 1}.yaml`), lastCopy);
                    await frame.page().screenshot({ path: path.join(out, `cycle-${cycle + 1}-file-${i + 1}.png`) });
                    await request('close'); await request('open', { file: files[i] }); await reconnect(); frame = await frameFor(files[i]);
                    assert.equal(await frame.evaluate(id => drawSource.getFeatures().length === 1 && drawSource.getFeatures()[0].get('annotationId') === id, id), true);
                    cycleReport.samples.push({ file: i + 1, annotationId: id, native, ...(imageParity ? { imageParity } : {}), ...(sourceParity ? {sourceParity} : {}) }); save();
                }
                const restored = await request('restoreClipboard', { expected: lastCopy });
                if (restored) assert.equal(await request('clipboard'), clipboardBefore);
                lastCopy = undefined;
                cycleReport.clipboardRestored = restored;
                report.cycles.push(cycleReport); save();
                console.log(`VS Code cycle ${cycle + 1}: 1/5/10-file Wasm, clipboard and persistence checks passed`);
            } finally {
                if (lastCopy !== undefined) await request('restoreClipboard', { expected: lastCopy }).catch(() => {});
                try {
                    cycleReport.shutdown = await closeOwnedProcess(child, {
                        profileDir: path.join(dir, 'profile'),
                        graceful: async () => {
                            try { if (browser) await browser.disconnect(); }
                            finally { fs.writeFileSync(path.join(bridge, 'request.json'), JSON.stringify({ id: ++requestId, action: 'stop' })); }
                        },
                    });
                } finally {
                    fs.writeFileSync(path.join(out, `cycle-${cycle + 1}.log`), childLog);
                    save();
                }
            }
        }
        report.status = 'passed'; report.finishedAt = new Date().toISOString(); save();
        console.log(JSON.stringify({ status: report.status, cycles: 3, samples: 9, output: out }));
    } catch (error) {
        report.status = 'failed'; report.error = String(error.stack || error); save(); throw error;
    } finally {
        if (report.status === 'passed') fs.rmSync(dir, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
