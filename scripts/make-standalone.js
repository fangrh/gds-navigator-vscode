// Regenerate webview/test-standalone.html from the CURRENT viewer.html so the
// refactored webview logic can be exercised in a plain browser (no VS Code).
// The harness shims acquireVsCodeApi, records every posted message into
// window.__sent, and boots from webview/real_geojson.json.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'webview', 'viewer.html'), 'utf8').replace(/\r\n/g, '\n');

html = html.replace('__OL_CSS__', '<link rel="stylesheet" href="/media/ol.css">');
html = html.replace('__OL_JS__', '<script src="/media/ol.js"></script>');
html = html.replace('__MARKER_JS__', '<script src="/webview/numbered-marker-alignment.js"></script>');
html = html.replace('__OVERLAY_JS__', '<script src="/webview/microscope-overlay.js"></script>');
html = html.replace('__PRIMITIVE_JS__', '<script src="/webview/layout-primitives.js"></script>');
html = html.replace('__PORT_JS__', '<script src="/webview/port-overlay.js"></script>');

html = html.replace('__CHOOSER_JS__', '<script src="/webview/component-chooser.js"></script>');

html = html.replace('__PROPERTIES_JS__', '<script src="/webview/shape-properties.js"></script>');

html=html.replace('__EDA_JS__','<script src="/webview/eda-workbench.js"></script>').replace('__EDA_CSS__','<link rel="stylesheet" href="/webview/eda-workbench.css">');
html=html.replace('__USAGE_JS__','<script src="/webview/usage-events.js"></script>');
html=html.replace('__ROUTE_JS__','<script src="/webview/manhattan-route.js"></script>');
html=html.replace('__REVIEW_JS__','<script src="/webview/layout-review.js"></script>').replace('__REVIEW_UI_JS__','<script src="/webview/review-tools.js"></script>');

const workerSource=['numbered-marker-alignment.js','numbered-marker-worker.js'].map(name=>fs.readFileSync(path.join(root,'webview',name),'utf8')).join('\n');
html=html.replace('__WORKER_SOURCE__','<script>window.numberedMarkerWorkerSource='+JSON.stringify(workerSource).replace(/</g,'\\u003c')+';</script>');

const shim = `<script>
// ---- standalone harness shim (injected by scripts/make-standalone.js) ----
window.__sent = [];
window.__pageErrors = [];
window.addEventListener('error', function (e) { window.__pageErrors.push(String(e.message) + ' @ ' + (e.filename||'') + ':' + (e.lineno||'')); });
window.addEventListener('unhandledrejection', function (e) { window.__pageErrors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)); });
window.acquireVsCodeApi = function () {
    return {
        postMessage: function (msg) { window.__sent.push(msg); },
        getState: function () { return window.__state || (window.__state = {}); },
        setState: function (s) { window.__state = s; }
    };
};
// Feed loadGds a fixed payload as soon as the page asks for it.
window.__bootRealGeoJson = function (geojson) {
    // The viewer posts webviewReady at script end; the harness responds by
    // invoking the same handling the extension would do for 'loadGds'.
    var deliver = function () {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'loadGds', geojson: geojson, gdsPath: 'standalone.gds', pythonFile: 'scripts/mzi_example.py', annotations: [], mode: 'full' } }));
    };
    if (window.__viewerReady) { deliver(); } else { window.__deliverOnReady = deliver; }
    var orig = window.acquireVsCodeApi;
    window.addEventListener('message', function (ev) { if (ev.data && ev.data.type === 'loadGds') { /* no-op */ } });
};
</script>
<script>
// intercept the viewer's own webviewReady post to know when it booted
(function () {
    var orig = window.acquireVsCodeApi;
    var api;
    window.acquireVsCodeApi = function () {
        if (!api) {
            api = orig();
            var origPost = api.postMessage.bind(api);
            api.postMessage = function (msg) {
                window.__sent.push(msg);
                if (msg && msg.type === 'webviewReady') {
                    window.__viewerReady = true;
                    if (window.__deliverOnReady) { setTimeout(window.__deliverOnReady, 30); }
                }
            };
        }
        return api;
    };
})();
</script>`;

html = html.replace('<script>\n// ============================================================\n// VS Code Webview API', shim + '\n<script>\n// ============================================================\n// VS Code Webview API');

// auto-boot: fetch data file (?data=<name> defaults to real_geojson) after load
html = html.replace('</body>', `<script>
fetch((new URLSearchParams(location.search).get('data') || 'real_geojson') + '.json').then(function (r) { return r.json(); }).then(function (gj) {
    window.__bootRealGeoJson(gj);
}).catch(function (e) { window.__pageErrors.push('fetch data: ' + e); });
</script>
</body>`);

fs.writeFileSync(path.join(root, 'webview', 'test-standalone.html'), html);
console.log('wrote webview/test-standalone.html', html.length, 'chars');
