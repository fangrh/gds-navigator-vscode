#!/usr/bin/env node
'use strict';

// Real-process component API shutdown contract.  This deliberately uses a
// private bundled copy of component_catalog.py; production sources are never
// rewritten and no VS Code/browser instance is launched.
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inventoryProcesses } = require('../../scripts/process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '../..');
const REPORT = path.resolve(process.env.GDS_COMPONENT_PROCESS_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'component-shutdown-process'));
const PYTHON = path.resolve(process.env.GDS_TEST_PYTHON || process.env.GDS_PYTHON || path.join(ROOT, '.venv-fork', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForFile(file, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (!fs.existsSync(file)) { if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`); await sleep(20); }
}

function writeFixture(root) {
    const python = path.join(root, 'python'); const dist = path.join(root, 'dist');
    fs.mkdirSync(python); fs.mkdirSync(dist);
    const script = path.join(python, 'component_catalog.py');
    fs.writeFileSync(script, String.raw`import json, os, signal, subprocess, sys, time
from pathlib import Path
root = Path(os.environ['GDS_COMPONENT_FIXTURE_DIR'])
root.mkdir(parents=True, exist_ok=True)
parent = root / 'parent.pid'; helper = root / 'helper.pid'; ready = root / 'ready'; gate = root / 'gate'; helper_ready = root / 'helper-ready'
def helper_main():
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    helper.write_text(str(os.getpid())); helper_ready.write_text('ready')
    while True: time.sleep(1)
if os.environ.get('GDS_COMPONENT_HELPER') == '1': helper_main(); raise SystemExit
signal.signal(signal.SIGTERM, signal.SIG_IGN)
parent.write_text(str(os.getpid()))
child = subprocess.Popen([sys.executable, __file__], env={**os.environ, 'GDS_COMPONENT_HELPER':'1'})
ready.write_text('ready')
while not gate.exists(): time.sleep(0.01)
try: os.kill(child.pid, signal.SIGKILL)
except ProcessLookupError: pass
if '--catalog' in sys.argv:
    value = {'components':[{'name':'straight','description':'fixture','parameters':[{'name':'length','required':False,'default':10}],'source':'components'}], 'environment':{'python':sys.executable,'fixture':True}}
elif '--preview' in sys.argv:
    settings = json.loads(sys.argv[sys.argv.index('--preview') + 2])
    value = {'geojson':{'type':'FeatureCollection','features':[{'type':'Feature','geometry':{'type':'Polygon','coordinates':[[[0,0],[2,0],[2,1],[0,0]]]},'properties':{}}]},'name':'straight','settings':settings,'ports':[{'name':'o1','center':[0,0],'width':0.5,'orientation':180,'layer':[1,0]}]}
elif '--thumbnails' in sys.argv:
    names = json.loads(sys.argv[sys.argv.index('--thumbnails') + 1]); value = {'items':[{'name':name,'geojson':{'type':'FeatureCollection','features':[]},'settings':{},'ports':[{'name':'o1','center':[0,0],'width':0.5,'orientation':180,'layer':[1,0]}]} for name in names]}
else: value = {'error':'unknown fixture mode'}
print(json.dumps(value), flush=True)
`);
    return { script, dist, parent: path.join(root, 'parent.pid'), helper: path.join(root, 'helper.pid'), ready: path.join(root, 'ready'), helperReady: path.join(root, 'helper-ready'), gate: path.join(root, 'gate') };
}

async function main() {
    fs.mkdirSync(REPORT, { recursive: true });
    assert(fs.existsSync(PYTHON), `Python interpreter is required: ${PYTHON}`);
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-component-process-')));
    const fixture = writeFixture(temp); const bundle = path.join(fixture.dist, 'componentCatalog.cjs');
    const owned = new Map(); const controllers = []; const requests = []; const report = { status: 'failed', python: PYTHON, platform: process.platform, scenarios: [], tempDir: temp, timeout: 'skipped: production timeout is 45s; bounded cancellation cases do not wait for it' };
    const recordOwned = async () => { for (const row of (await inventoryProcesses()).filter(row => row.command.includes(temp))) { assert(row.start, `missing birth identity for ${row.pid}`); owned.set(`${row.pid}:${row.start}`, row); } };
    const alive = async pids => { const rows = await inventoryProcesses(); return pids.filter(pid => rows.some(row => row.pid === pid && [...owned.values()].some(w => w.pid === pid && w.start === row.start))); };
    const gateAndDrain = async pids => { fs.writeFileSync(fixture.gate, 'go'); const deadline = Date.now() + 5000; while ((await alive(pids)).length && Date.now() < deadline) await sleep(30); assert.deepEqual(await alive(pids), [], 'fixture parent/helper did not drain'); };
    let api;
    try {
        await esbuild.build({ entryPoints: [path.join(ROOT, 'src', 'componentCatalog.ts')], bundle: true, platform: 'node', format: 'cjs', external: [], outfile: bundle });
        api = require(bundle);
        process.env.GDS_COMPONENT_FIXTURE_DIR = path.join(temp, 'normal'); fs.mkdirSync(process.env.GDS_COMPONENT_FIXTURE_DIR); const normal = writeFixture(path.join(temp, 'normal')); fs.writeFileSync(normal.gate, 'go');
        const catalog = await api.loadComponentCatalog(PYTHON); assert.equal(catalog.components[0].name, 'straight');
        const settings = { width: 2, length: 11 }; const preview = await api.previewComponent(PYTHON, 'straight', settings); assert.deepEqual(Object.keys(preview.settings), ['width', 'length']);
        assert.deepEqual(preview.geojson.features[0].geometry, { type: 'Polygon', coordinates: [[[0,0],[2,0],[2,1],[0,0]]] });
        assert.deepEqual(preview.ports, [{ name: 'o1', center: [0,0], width: 0.5, orientation: 180, layer: [1,0] }]);
        const thumbnails = await api.requestComponentThumbnails(PYTHON, ['straight']); assert.equal(thumbnails.items[0].name, 'straight');
        report.scenarios.push({ name: 'normal-valid-json-geometry-ports-settings-order', status: 'passed' });

        for (const kind of ['catalog', 'preview']) {
            process.env.GDS_COMPONENT_FIXTURE_DIR = path.join(temp, kind); fs.mkdirSync(process.env.GDS_COMPONENT_FIXTURE_DIR); const f = writeFixture(path.join(temp, kind));
            const firstCtl = new AbortController(); const peerCtl = new AbortController();
            controllers.push(firstCtl, peerCtl);
            const first = kind === 'catalog' ? api.loadComponentCatalog(PYTHON, firstCtl.signal, undefined, true) : api.previewComponent(PYTHON, 'straight', { width: 2, length: 12 }, firstCtl.signal);
            const peer = kind === 'catalog' ? api.loadComponentCatalog(PYTHON, peerCtl.signal) : api.previewComponent(PYTHON, 'straight', { width: 2, length: 12 }, peerCtl.signal);
            requests.push(first, peer);
            await waitForFile(f.ready); await waitForFile(f.helperReady); const pids = [Number(fs.readFileSync(f.parent)), Number(fs.readFileSync(f.helper))]; await recordOwned();
            let peerSettled = false; peer.then(() => { peerSettled = true; }, () => { peerSettled = true; }); firstCtl.abort(); await assert.rejects(first, /cancelled/); await sleep(50); assert.equal(peerSettled, false, `${kind}: peer settled after first subscriber cancellation`); assert.deepEqual(await alive(pids), pids, `${kind}: first cancellation killed shared child`);
            peerCtl.abort(); await Promise.race([assert.rejects(peer, /cancelled/), sleep(6000).then(() => { throw new Error(`${kind}: last subscriber did not reject within bounded cancellation window`); })]); assert.equal(peerSettled, true); assert.deepEqual(await alive(pids), [], `${kind}: last subscriber settled before process-group exit`);
            report.scenarios.push({ name: `shared-${kind}-last-subscriber-waits-for-group-exit`, status: 'passed', pids });
        }

        process.env.GDS_COMPONENT_FIXTURE_DIR = path.join(temp, 'thumbnail'); fs.mkdirSync(process.env.GDS_COMPONENT_FIXTURE_DIR); const f = writeFixture(path.join(temp, 'thumbnail')); const ctl = new AbortController(); controllers.push(ctl); const pending = api.requestComponentThumbnails(PYTHON, ['straight'], ctl.signal); requests.push(pending); await waitForFile(f.ready); await waitForFile(f.helperReady); const pids = [Number(fs.readFileSync(f.parent)), Number(fs.readFileSync(f.helper))]; await recordOwned(); let settled = false; pending.then(() => { settled = true; }, () => { settled = true; }); ctl.abort(); await sleep(50); assert.equal(settled, false, 'unshared thumbnail abort settled before child exit'); assert.deepEqual(await alive(pids), pids); await Promise.race([assert.rejects(pending, /cancelled/), sleep(6000).then(() => { throw new Error('thumbnail: abort did not reject within bounded cancellation window'); })]); assert.equal(settled, true); assert.deepEqual(await alive(pids), [], 'unshared thumbnail settled before process-group exit'); report.scenarios.push({ name: 'unshared-thumbnail-abort-waits-for-group-exit', status: 'passed', pids });
        report.status = 'passed';
    } catch (error) { report.error = String(error.stack || error); throw error; }
    finally {
        for (const controller of controllers) controller.abort();
        await Promise.allSettled(requests);
        try { await recordOwned(); } catch (error) { report.cleanupError = String(error.stack || error); }
        const rows = await inventoryProcesses(); const survivors = [];
        for (const wanted of owned.values()) { const current = rows.find(row => row.pid === wanted.pid && row.start === wanted.start); if (!current || current.pid === process.pid) continue; survivors.push(current.pid); try { process.kill(current.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') report.cleanupError = String(error.stack || error); } }
        const deadline = Date.now() + 3000; let left = survivors; while (left.length && Date.now() < deadline) { await sleep(30); const now = await inventoryProcesses(); left = survivors.filter(pid => now.some(row => row.pid === pid && [...owned.values()].some(w => w.pid === pid && w.start === row.start))); }
        report.cleanup = { verified: left.length === 0, authenticatedIdentities: [...owned.values()], survivors: left }; fs.writeFileSync(path.join(REPORT, 'report.json'), JSON.stringify(report, null, 2) + '\n'); delete process.env.GDS_COMPONENT_FIXTURE_DIR; if (!left.length && report.status === 'passed') fs.rmSync(temp, { recursive: true, force: true }); if (left.length) throw new Error(`authenticated component processes survived cleanup: ${left.join(', ')}`);
    }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
