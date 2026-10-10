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
const REPORT_DIR = process.env.GDS_SELECTION_CLEAR_REPORT_DIR || path.join(ROOT, 'logs', 'performance', 'selection-clear');
const VIEWER_SHA256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'webview', 'viewer.html'))).digest('hex');
const BROWSER = [
    process.env.GDS_BROWSER,
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright', 'chromium_headless_shell-1217', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
].filter(Boolean).find(fs.existsSync);
assert(BROWSER, 'Set GDS_BROWSER or install the pinned Chromium headless shell');

function fixture() {
    const features = Array.from({ length: 12 }, (_, i) => ({
        type: 'Feature',
        properties: {
            element_id: 'clear-' + i,
            layer: 1,
            data_type: 0,
            color: '#89b4fa',
            provenance: {
                file: 'clear_fixture.py',
                line: 20,
                instance_name: 'array_inst',
                loop_index: [0],
                array_index: [[0, i]]
            }
        },
        geometry: { type: 'Polygon', coordinates: [[[i, 0], [i + .5, 0], [i + .5, 1], [i, 1], [i, 0]]] }
    }));
    return { type: 'FeatureCollection', features };
}

function stableFeatureState(page) {
    return page.evaluate(() => ({
        ids: selectedFeatures.getArray().map(f => f.get('elementId')),
        selectedFlags: allFeatures.map(f => !!f.get('selected')),
        labels: allFeatures.map(f => f.get('label') || ''),
        featureObjects: allFeatures.map(f => f.ol_uid),
        geometry: allFeatures.map(f => f.getGeometry().getCoordinates()),
        provenance: allFeatures.map(f => f.get('provenance')),
        drawn: drawSource.getFeatures().map(f => ({ id: f.get('annotationId'), selected: !!f.get('selected'), object: f.ol_uid, geometry: f.getGeometry().getCoordinates(), provenance: f.get('provenance') || null })),
        intent: { action: document.getElementById('intent-action').value, text: document.getElementById('intent-text').value },
        cycle: { value: selectionCycle, text: document.getElementById('cycle-indicator').textContent, display: document.getElementById('cycle-indicator').style.display },
        mode: currentMode,
        modifyActive: modifyInteraction.getActive(),
        translateActive: translateInteraction.getActive(),
        snapshot: currentLayoutHash
    }));
}

async function main() {
    const baselineMode = process.env.SELECTION_CLEAR_BASELINE === '1';
    const expectedDispatches = baselineMode ? 2 : 1;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-selection-clear-'));
    fs.writeFileSync(path.join(temp, 'clear.geojson'), JSON.stringify(fixture()));
    const host = await startServer({ port: 0, root: temp, stateDir: path.join(temp, 'state'), file: 'clear.geojson' });
    let browser;
    let browserShutdown = { verified: false };
    let cleanupError;
    try {
        browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(host.url, { waitUntil: 'networkidle0' });
        await page.evaluate(() => window.__gdsDebug.load('clear.geojson'));
        await page.waitForFunction(() => allFeatures.length === 12 && currentGdsPath.endsWith('clear.geojson'));

        await page.evaluate(() => {
            const drawing = new ol.Feature({ geometry: new ol.geom.Polygon([[[0, 2], [1, 2], [1, 3], [0, 2]]]) });
            drawing.setProperties({ isDrawn: true, annotationId: 'draw-clear', selected: false,
                intent: { action: 'move', text: 'preserve this proposal' }, shapeType: 'polygon' });
            drawSource.addFeature(drawing);
            replaceSelection([allFeatures[0], allFeatures[1], allFeatures[2], drawing]);
            rewriteLabels('[:]');
            document.getElementById('intent-action').value = 'move';
            document.getElementById('intent-text').value = 'preserve this proposal';
            // Prime the real handler before wrapping it so drawing edit interactions
            // reflect the selected proposal in the pre-action snapshot.
            onSelectionChanged();
            window.__clearProbe = { changes: 0, posts: [], originalChange: onSelectionChanged, originalPost: postSelectedComponents };
            onSelectionChanged = function () { window.__clearProbe.changes++; return window.__clearProbe.originalChange.apply(this, arguments); };
            postSelectedComponents = function (features) {
                window.__clearProbe.posts.push(features.map(f => ({ id: f.get('elementId') || f.get('annotationId'), selected: !!f.get('selected'), geometry: f.getGeometry().getCoordinates(), provenance: f.get('provenance') })));
                return window.__clearProbe.originalPost.apply(this, arguments);
            };
        });

        const beforeEscape = await stableFeatureState(page);
        await page.focus('#map');
        const sentBeforeEscape = await page.evaluate(() => window.__gdsDebug.sent.length);
        const escapeStarted = Date.now();
        await page.keyboard.press('Escape');
        const escapeMs = Date.now() - escapeStarted;
        const escape = await page.evaluate(start => ({ state: window.__clearProbe.changes, posts: window.__clearProbe.posts, sent: window.__gdsDebug.sent.slice(start), selected: selectedFeatures.getArray().length, mode: currentMode }), sentBeforeEscape);
        assert.equal(escape.state, expectedDispatches, 'Escape onSelectionChanged dispatch count');
        assert.equal(escape.posts.length, expectedDispatches, 'Escape selectComponents dispatch count');
        assert.deepEqual(escape.posts.at(-1), [], 'Escape final selectComponents payload');
        assert(escape.posts.every(payload => payload.length === 0), 'Escape emitted a non-empty selectComponents payload');
        const escapeMessages = escape.sent.filter(message => message.type === 'selectComponents');
        assert.equal(escapeMessages.length, expectedDispatches, 'Escape host selectComponents message count');
        assert(escapeMessages.every(message => message.components && message.components.length === 0), 'Escape host payload was not empty: ' + JSON.stringify(escapeMessages));
        assert.equal(escape.mode, 'select', 'Escape did not leave select mode');
        assert.equal(escape.selected, 0);
        const afterEscape = await stableFeatureState(page);
        assert.deepEqual(afterEscape.ids, []);
        assert(afterEscape.selectedFlags.every(value => !value), 'Escape left a selected feature flag');
        assert(afterEscape.drawn.every(value => !value.selected), 'Escape left drawing selected');
        assert.deepEqual(afterEscape.geometry, beforeEscape.geometry);
        assert.deepEqual(afterEscape.provenance, beforeEscape.provenance);
        assert.deepEqual(afterEscape.featureObjects, beforeEscape.featureObjects, 'Escape changed feature identity');
        assert.deepEqual(afterEscape.drawn, beforeEscape.drawn.map(value => ({ ...value, selected: false })), 'Escape changed drawing geometry/provenance or identity');
        assert.deepEqual(afterEscape.labels, beforeEscape.labels, 'Escape changed labels');
        assert.equal(afterEscape.snapshot, beforeEscape.snapshot, 'Escape changed layout snapshot');
        assert.deepEqual(afterEscape.intent, { action: 'inspect', text: '' });
        assert.equal(afterEscape.modifyActive, false, 'Escape left modify interaction active');
        assert.equal(afterEscape.translateActive, false, 'Escape left translate interaction active');
        assert.deepEqual(afterEscape.cycle, { value: beforeEscape.cycle.value, text: beforeEscape.cycle.text, display: beforeEscape.cycle.display });

        await page.evaluate(() => {
            replaceSelection([allFeatures[0], allFeatures[1], allFeatures[2]]);
            selectionCycle = 0;
            const cycle = document.getElementById('cycle-indicator'); cycle.textContent = 'seed'; cycle.style.display = 'block';
            document.getElementById('intent-action').value = 'inspect'; document.getElementById('intent-text').value = 'terminal ladder';
            window.__clearProbe.changes = 0; window.__clearProbe.posts = [];
            onSelectionChanged();
            window.__clearProbe.changes = 0; window.__clearProbe.posts = [];
        });
        const beforeCtrlA = await stableFeatureState(page);
        await page.focus('#map');
        let terminalCtrlA;
        let terminalMs = 0;
        for (let i = 0; i < 8; i++) {
            const beforeCount = await page.evaluate(() => ({ changes: window.__clearProbe.changes, posts: window.__clearProbe.posts.length, sent: window.__gdsDebug.sent.length }));
            const started = Date.now();
            await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
            const elapsed = Date.now() - started;
            const afterCount = await page.evaluate(() => ({ changes: window.__clearProbe.changes, posts: window.__clearProbe.posts.length, sent: window.__gdsDebug.sent.length, selected: selectedFeatures.getArray().length, ids: selectedFeatures.getArray().map(f => f.get('elementId')) }));
            if (afterCount.selected === 0) {
                terminalMs = elapsed;
                const payloads = await page.evaluate(count => window.__clearProbe.posts.slice(count), beforeCount.posts);
                const sent = await page.evaluate(start => window.__gdsDebug.sent.slice(start), beforeCount.sent);
                terminalCtrlA = { changes: afterCount.changes - beforeCount.changes, posts: afterCount.posts - beforeCount.posts, payloads, sent, selected: afterCount.selected, ids: afterCount.ids };
                break;
            }
        }
        const ctrlA = terminalCtrlA;
        assert(ctrlA, 'Ctrl+A ladder did not reach terminal clear');
        assert.equal(ctrlA.selected, 0, 'terminal Ctrl+A did not clear');
        assert.equal(ctrlA.changes, expectedDispatches, 'terminal Ctrl+A onSelectionChanged dispatch count');
        assert.equal(ctrlA.posts, expectedDispatches, 'terminal Ctrl+A selectComponents dispatch count');
        assert.deepEqual(ctrlA.payloads.at(-1), [], 'terminal Ctrl+A final selectComponents payload');
        assert(ctrlA.payloads.every(payload => payload.length === 0), 'terminal Ctrl+A emitted a non-empty selectComponents payload');
        const ctrlAMessages = ctrlA.sent.filter(message => message.type === 'selectComponents');
        assert.equal(ctrlAMessages.length, expectedDispatches, 'terminal Ctrl+A host selectComponents message count');
        assert(ctrlAMessages.slice(-expectedDispatches).every(message => message.components && message.components.length === 0), 'terminal Ctrl+A host payload was not empty');
        const afterCtrlA = await stableFeatureState(page);
        assert.equal(afterCtrlA.mode, beforeCtrlA.mode, 'Ctrl+A changed editor mode');
        assert.deepEqual(afterCtrlA.ids, []);
        assert(afterCtrlA.selectedFlags.every(value => !value));
        assert.equal(afterCtrlA.cycle.value, 0);
        assert.equal(afterCtrlA.cycle.text, '');
        assert.equal(afterCtrlA.cycle.display, 'none');
        assert.deepEqual(afterCtrlA.geometry, beforeCtrlA.geometry);
        assert.deepEqual(afterCtrlA.provenance, beforeCtrlA.provenance);
        assert.deepEqual(afterCtrlA.featureObjects, beforeCtrlA.featureObjects, 'Ctrl+A changed feature identity');
        assert.deepEqual(afterCtrlA.drawn, beforeCtrlA.drawn, 'Ctrl+A changed drawing state');
        assert.deepEqual(afterCtrlA.labels, Array.from({ length: 12 }, (_, i) => '[0,' + i + ']'), 'Ctrl+A did not restore original labels');
        assert.equal(afterCtrlA.snapshot, beforeCtrlA.snapshot, 'Ctrl+A changed layout snapshot');
        assert.deepEqual(afterCtrlA.intent, { action: 'inspect', text: '' });
        assert.equal(afterCtrlA.modifyActive, false);
        assert.equal(afterCtrlA.translateActive, false);
        assert.equal(errors.length, 0, errors.join('; '));

        const out = REPORT_DIR;
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ status: baselineMode ? 'baseline-red' : 'passed', viewerSha256: VIEWER_SHA256, fixture: 12, expectedDispatches, escape: { onSelectionChanged: escape.state, callbackSelectComponents: escape.posts.length, hostSelectComponents: escapeMessages.length, emptyHostPayloads: escapeMessages.every(message => message.components.length === 0), mode: escape.mode, elapsedMs: escapeMs }, ctrlA: { onSelectionChanged: ctrlA.changes, callbackSelectComponents: ctrlA.posts, hostSelectComponents: ctrlAMessages.length, emptyHostPayloads: ctrlAMessages.slice(-expectedDispatches).every(message => message.components.length === 0), mode: afterCtrlA.mode, terminalElapsedMs: terminalMs }, intendedAfter: { onSelectionChanged: 1, callbackSelectComponents: 1, hostSelectComponents: 1 }, notes: ['Dispatch counts are deterministic operation evidence.', 'Date.now keyboard timings are supplementary and noisy; they do not establish latency or FPS gains.', 'Geometry/provenance identity and terminal selection state remained unchanged.'] }, null, 2));
        console.log(JSON.stringify({ status: baselineMode ? 'baseline-red' : 'passed', escape: [escape.state, escape.posts.length], ctrlA: [ctrlA.changes, ctrlA.posts], elapsedMs: [escapeMs, terminalMs] }));
    } finally {
        try {
            if (browser) {
                browserShutdown = await closeOwnedBrowser(browser);
                assert(browserShutdown.verified, 'browser parent/helper shutdown was not verified');
                console.log(JSON.stringify({ cleanup: browserShutdown }));
            }
        } catch (error) {
            cleanupError = error;
        } finally {
            try {
                await host.close();
            } catch (error) {
                cleanupError ||= error;
            } finally {
                if (browserShutdown.verified && !cleanupError) fs.rmSync(temp, { recursive: true, force: true });
                else console.error('retaining temporary workspace after unverified cleanup:', temp);
            }
        }
        if (cleanupError) throw cleanupError;
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
