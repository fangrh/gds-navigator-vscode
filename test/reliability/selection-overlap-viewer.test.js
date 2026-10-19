'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { startServer } = require('../../scripts/serve-web.cjs');
const { closeOwnedBrowser } = require('../../scripts/process-cleanup.cjs');

const ROOT = path.resolve(__dirname, '../..');
const REPORT_DIR = path.resolve(process.env.GDS_SELECTION_OVERLAP_REPORT_DIR || path.join(ROOT, 'logs', 'reliability', 'selection-overlap'));
const BROWSER = [process.env.GDS_BROWSER, process.env.GDS_TEST_BROWSER, path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright', 'chromium_headless_shell-1217', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')].filter(Boolean).find(fs.existsSync);
assert(BROWSER, 'Set GDS_BROWSER/GDS_TEST_BROWSER or install the pinned Chromium headless shell');
const VIEWER_SHA256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'webview', 'viewer.html'))).digest('hex');

// Frozen from HEAD 98eee26. Keep this local so the comparison remains valid
// after the production implementation changes.
const BASELINE_REPLACE_SELECTION = `function replaceSelection(features) {
    features=expandFactorySelection(features).filter(function(f){return f.get('visible')!==false;});
    if(features.length&&typeof imageCanvasSelected!=='undefined')imageCanvasSelected=false;
    selectedFeatures.forEach(function(f) { f.set('selected', false); });
    selectedFeatures.clear();
    features.forEach(function(f) {
        selectedFeatures.push(f);
        f.set('selected', true);
    });
    vectorLayer.changed();
    drawLayer.changed();
}`;

function polygon(x, y = 0) {
    return { type: 'Polygon', coordinates: [[[x, y], [x + .5, y], [x + .5, y + .5], [x, y + .5], [x, y]]] };
}

function fixture() {
    const features = Array.from({ length: 3000 }, (_, i) => ({
        type: 'Feature', geometry: polygon(i % 100, Math.floor(i / 100)), properties: {
            element_id: 'overlap-' + i, layer: i % 2 ? 2 : 1, data_type: 0, color: i % 2 ? '#f38ba8' : '#89b4fa',
            provenance: { file: i % 2 ? 'source_b.py' : 'source_a.py', line: i % 2 ? 22 : 11, instance_name: 'inst-' + (i % 5), loop_index: [Math.floor(i / 100)], array_index: [[i % 10, Math.floor(i / 10) % 10]] },
        },
    }));
    return { type: 'FeatureCollection', features, ports: [
        { id: 'port-a', name: 'in_a', center: [0.25, 0.25], width: .5, orientation: 0, layer: [1, 0], coordinate_frame: 'layout', provenance: { file: 'source_a.py', line: 11 } },
        { id: 'port-b', name: 'out_b', center: [1.25, 0.25], width: .5, orientation: 180, layer: [2, 0], coordinate_frame: 'layout', provenance: { file: 'source_b.py', line: 22 } },
    ] };
}

async function main() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-selection-overlap-'));
    fs.writeFileSync(path.join(temp, 'overlap.geojson'), JSON.stringify(fixture()));
    const host = await startServer({ port: 0, root: temp, stateDir: path.join(temp, 'state'), file: 'overlap.geojson' });
    const profile = fs.mkdtempSync(path.join(REPORT_DIR, 'browser-profile-'));
    let browser;
    let browserShutdown = { verified: false, survivors: [] };
    let cleanupError;
    let report;
    let summary;
    let testSucceeded = false;
    try {
        browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, userDataDir: profile, args: ['--no-first-run'] });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(host.url, { waitUntil: 'networkidle0' });
        await page.evaluate(() => window.__gdsDebug.load('overlap.geojson'));
        await page.waitForFunction(() => allFeatures.length === 3000 && portFeatureById.size === 2);
        const result = await page.evaluate((baselineSource) => {
            const baseline = eval('(' + baselineSource + ')');
            const factoryA = new ol.Feature({ geometry: new ol.geom.Polygon([[[400, 0], [402, 0], [402, 2], [400, 2], [400, 0]]]) });
            const factoryB = new ol.Feature({ geometry: new ol.geom.Polygon([[[403, 0], [405, 0], [405, 2], [403, 2], [403, 0]]]) });
            const drawing = new ol.Feature({ geometry: new ol.geom.Polygon([[[406, 0], [408, 0], [408, 2], [406, 2], [406, 0]]]) });
            const factory = { groupId: 'factory-overlap', pieceIndex: 0, pieceCount: 2, name: 'factory-overlap', sourceGeometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, ports: [] };
            factoryA.setProperties({ isDrawn: true, annotationId: 'factory-a', factory });
            factoryB.setProperties({ isDrawn: true, annotationId: 'factory-b', factory: { ...factory, pieceIndex: 1 } });
            drawing.setProperties({ isDrawn: true, annotationId: 'drawing-overlap', intent: { action: 'mark_region', text: 'keep label' } });
            drawSource.addFeatures([factoryA, factoryB, drawing]);
            setLayoutPortLayerVisibility('1/0', false);
            allFeatures[7].set('visible', false);
            rewriteLabels('[:]');
            const current = window.replaceSelection;
            const ids = features => features.map(f => f.get('elementId') || f.get('annotationId') || f.get('port')?.id);
            const state = () => ({ selected: ids(selectedFeatures.getArray()), flags: allFeatures.map(f => !!f.get('selected')), geometries: allFeatures.slice(0, 12).map(f => f.getGeometry().getCoordinates()), provenance: allFeatures.slice(0, 12).map(f => f.get('provenance')), labels: allFeatures.slice(0, 12).map(f => f.get('label') || ''), ports: [...portFeatureById].map(([id, f]) => ({ id, visible: f.get('visible') !== false, selected: !!f.get('selected') })), factory: [factoryA, factoryB].map(f => ({ id: f.get('annotationId'), selected: !!f.get('selected'), geometry: f.getGeometry().getCoordinates() })), drawing: { selected: !!drawing.get('selected'), geometry: drawing.getGeometry().getCoordinates(), intent: drawing.get('intent') } });
            const names = { a: allFeatures[0], b: allFeatures[1], c: allFeatures[2], hidden: allFeatures[7], portA: portFeatureById.get('port-a'), portB: portFeatureById.get('port-b'), factoryA, factoryB, drawing };
            const originalAProvenance = names.a.get('provenance');
            const originalAGeometry = names.a.getGeometry().clone();
            const scenarios = {
                repeatedsame: [names.a, names.a],
                partialoverlap: [names.a, names.b, names.factoryA, names.drawing],
                disjoint: [names.c, names.portB],
                clear: [],
                ordering: [names.drawing, names.a, names.factoryB, names.portA],
                hidden: [names.hidden, names.portA, names.a],
                factorygroup: [names.factoryA],
                mixed: [names.portB, names.drawing, names.b],
                replacement: [names.a, names.b, names.factoryA, names.drawing],
                bulkRepeat: allFeatures.filter(f => f.get('visible') !== false),
            };
            function run(name, fn) {
                names.a.set('provenance', originalAProvenance, true); names.a.setGeometry(originalAGeometry.clone());
                selectedFeatures.clear(); allFeatures.forEach(f => f.set('selected', false, true)); [factoryA, factoryB, drawing, names.portA, names.portB].forEach(f => f.set('selected', false, true));
                const initial = name === 'repeatedsame' ? [names.a] : name === 'bulkRepeat' ? allFeatures.filter(f => f.get('visible') !== false) : [names.a, names.factoryA, names.factoryB];
                initial.forEach(f => { selectedFeatures.push(f); f.set('selected', true, true); });
                const changes = { selected: 0, add: 0, remove: 0, posts: [] };
                const listeners = [];
                allFeatures.concat([factoryA, factoryB, drawing, names.portA, names.portB]).forEach(f => { const handler = () => { changes.selected++; }; f.on('change:selected', handler); listeners.push([f, handler]); });
                const onAdd = () => { changes.add++; }, onRemove = () => { changes.remove++; };
                selectedFeatures.on('add', onAdd); selectedFeatures.on('remove', onRemove);
                const oldHandler = window.postSelectedComponents;
                const oldVscodePost = vscode.postMessage;
                changes.rawMessages = [];
                vscode.postMessage = function(message) {
                    if (message && message.type === 'selectComponents') changes.rawMessages.push(JSON.parse(JSON.stringify(message)));
                    return oldVscodePost.apply(this, arguments);
                };
                window.postSelectedComponents = function(fs) { changes.posts.push(fs.map(f => ({ id: f.get('elementId') || f.get('annotationId') || f.get('port')?.id, selected: !!f.get('selected'), geometry: f.getGeometry().getCoordinates(), provenance: f.get('provenance') || null }))); return oldHandler.apply(this, arguments); };
                if (name === 'replacement') {
                    names.a.set('provenance', { file: 'replacement.py', line: 99 });
                    names.a.setGeometry(new ol.geom.Polygon([[[9, 9], [10, 9], [10, 10], [9, 9]]]));
                }
                fn(scenarios[name]); onSelectionChanged();
                const messages = changes.rawMessages;
                const output = { events: changes, state: state(), messages };
                vscode.postMessage = oldVscodePost;
                selectedFeatures.un('add', onAdd); selectedFeatures.un('remove', onRemove);
                listeners.forEach(([f, handler]) => f.un('change:selected', handler));
                return output;
            }
            const outputs = { baseline: {}, current: {} };
            for (const name of Object.keys(scenarios)) outputs.baseline[name] = run(name, baseline);
            for (const name of Object.keys(scenarios)) outputs.current[name] = run(name, current);
            return outputs;
        }, BASELINE_REPLACE_SELECTION);
        report = { status: 'candidate-red', viewerSha256: VIEWER_SHA256, featureCount: 3000, errors, result, notes: ['Baseline implementation is frozen from HEAD 98eee26.', 'Event counts cover selected property changes and selection collection add/remove events; message JSON is compared separately.', 'No latency or FPS claim is made.'] };
        fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2));
        assert.deepEqual(errors, [], errors.join('; '));
        for (const name of Object.keys(result.baseline)) {
            assert.deepEqual(result.current[name].state, result.baseline[name].state, name + ' state parity');
            assert.deepEqual(result.current[name].messages, result.baseline[name].messages, name + ' message parity');
            assert(result.current[name].events.selected <= result.baseline[name].events.selected, name + ' selected event count regressed');
            assert.equal(result.current[name].events.add, result.baseline[name].events.add, name + ' collection add count changed');
            assert.equal(result.current[name].events.remove, result.baseline[name].events.remove, name + ' collection remove count changed');
        }
        assert.equal(result.current.repeatedsame.events.selected, 0, 'repeated same selection should not toggle selected');
        assert.equal(result.current.bulkRepeat.events.selected, 0, 'bulk repeated selection should not toggle selected');
        assert.equal(result.current.partialoverlap.events.selected, 2, 'partial overlap should update only entering/leaving features');
        assert.equal(result.current.clear.events.selected, 3, 'clear should deselect only selected features');
        assert(result.current.replacement.messages[0].components.some(row => row.provenance?.file === 'replacement.py' && row.geometry.coordinates[0][0][0] === 9), 'retained feature replacement was not serialized in the selection message');
        report.status = 'passed';
        fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2));
        testSucceeded = true;
        summary = { status: report.status, scenarios: Object.keys(result.current), repeatedSame: { selected: result.current.repeatedsame.events.selected, add: result.current.repeatedsame.events.add, remove: result.current.repeatedsame.events.remove }, bulkRepeat: { selected: result.current.bulkRepeat.events.selected, add: result.current.bulkRepeat.events.add, remove: result.current.bulkRepeat.events.remove }, partialOverlap: { selected: result.current.partialoverlap.events.selected, add: result.current.partialoverlap.events.add, remove: result.current.partialoverlap.events.remove } };
    } catch (error) {
        if (!report) {
            report = { status: 'candidate-red', viewerSha256: VIEWER_SHA256, error: error.stack || String(error) };
        }
        report.error = error.stack || String(error);
        throw error;
    } finally {
        try {
            if (browser) {
                browserShutdown = await closeOwnedBrowser(browser);
                console.log(JSON.stringify({ cleanup: browserShutdown }));
                assert(browserShutdown.verified, 'browser parent/helper shutdown was not verified');
            }
        } catch (error) { cleanupError = error; }
        try { await host.close(); } catch (error) { cleanupError ||= error; }
        if (report) {
            report.status = testSucceeded && browserShutdown.verified && !cleanupError ? 'passed' : 'failed';
            report.cleanup = browserShutdown;
            if (cleanupError) report.cleanupError = String(cleanupError);
            fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2));
        }
        if (testSucceeded && browserShutdown.verified && !cleanupError) {
            fs.rmSync(temp, { recursive: true, force: true });
            fs.rmSync(profile, { recursive: true, force: true });
        } else console.error(JSON.stringify({ retainedWorkspace: temp, retainedProfile: profile, cleanup: browserShutdown }));
        if (cleanupError) throw cleanupError;
        if (testSucceeded) console.log(JSON.stringify(summary));
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
