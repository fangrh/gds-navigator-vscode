// Regenerate webview/test-standalone.html from the CURRENT viewer.html so the
// refactored webview logic can be exercised in a plain browser (no VS Code).
// The harness shims acquireVsCodeApi, records every posted message into
// window.__sent, and boots from webview/real_geojson.json.
const path = require('path');
const fs = require('fs');
const { renderViewer } = require('./render-viewer.cjs');

const root = path.join(__dirname, '..');
let html = renderViewer({ browser: false });

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
