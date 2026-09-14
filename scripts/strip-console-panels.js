// One-shot refactor of webview/viewer.html:
//   - remove the bottom Source/Info console (#console) from the UI
//   - Copy YAML becomes a small icon button in the zoom-control cluster
//   - selection/drawn-shape detail is sent to the extension, which logs it
//     to the "GDS Navigator" Output channel instead of in-viewer panels.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'webview', 'viewer.html');
let s = fs.readFileSync(file, 'utf8');
const before = s.length;

function cut(startAnchor, endAnchor, label) {
    const i = s.indexOf(startAnchor);
    if (i < 0) throw new Error('start anchor not found: ' + label);
    const j = s.indexOf(endAnchor, i);
    if (j < 0) throw new Error('end anchor not found: ' + label);
    s = s.slice(0, i) + s.slice(j);
    console.log('cut', label, (j - i), 'chars');
}
function rep(from, to, label) {
    if (!s.includes(from)) throw new Error('replace anchor not found: ' + label);
    s = s.replace(from, to);
    console.log('rep', label);
}

// --- A. CSS ---------------------------------------------------------------
cut(
    '#console { height: 200px;',
    '.file-item { padding: 6px 8px;',
    'css: console block'
);
rep(
    `.tab-btn { padding: 2px 8px; border-radius: 4px 4px 0 0; cursor: pointer; font-size: 11px; color: #6c7086; border-bottom: 2px solid transparent; }
.tab-btn.active { color: #89b4fa; border-bottom-color: #89b4fa; }
.tab-btn:hover { color: #cdd6f4; }
#claude-mode { background: #1e1e2e; color: #cdd6f4; border: 1px solid #313244; border-radius: 4px; padding: 2px 6px; font-size: 11px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; cursor: pointer; outline: none; }
#claude-mode:hover { border-color: #585b70; }
#claude-mode option { background: #1e1e2e; color: #cdd6f4; }
#copy-btn { background: #45475a; color: #cdd6f4; border: 1px solid #585b70; border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
#copy-btn:hover { background: #585b70; }
#copy-btn.copied { color: #a6e3a1; border-color: #a6e3a1; }
#source-panel { height: 100%; overflow-y: auto; }
.source-link { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 8px; border: 0; border-left: 3px solid transparent; background: transparent; color: #cdd6f4; cursor: pointer; font: 12px/1.5 'Cascadia Code', 'Fira Code', 'Consolas', monospace; text-align: left; }
.source-link:hover { background: #313244; border-left-color: #89b4fa; }
.source-link.primary { background: rgba(137, 180, 250, 0.08); border-left-color: #89b4fa; }
.source-link .loc { color: #89b4fa; white-space: nowrap; }
.source-link .fn { color: #a6adc8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`,
    `.zoom-btn#copy-btn.copied { color: #a6e3a1; border-color: #a6e3a1; }
`,
    'css: tabs/mode/copy/source-link'
);
cut(
    '.file-section { margin: 4px 0;',
    '#map-row { display: flex;',
    'css: file-section block'
);

// --- B. HTML --------------------------------------------------------------
rep(
    `                <button class="zoom-btn" id="fit-btn" title="Fit view">
                    <svg viewBox="0 0 24 24"><path d="M4 4h4M4 4v4M20 4h-4M20 4v4M4 20h4M4 20v-4M20 20h-4M20 20v-4"/></svg>
                </button>`,
    `                <button class="zoom-btn" id="fit-btn" title="Fit view">
                    <svg viewBox="0 0 24 24"><path d="M4 4h4M4 4v4M20 4h-4M20 4v4M4 20h4M4 20v-4M20 20h-4M20 20v-4"/></svg>
                </button>
                <button class="zoom-btn" id="copy-btn" title="Copy selection as YAML (Ctrl+Shift+C)">
                    <svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                </button>`,
    'html: copy button in zoom cluster'
);
// #console contains nested divs — cut from its opening tag to its balanced
// closing tag (depth counting), keeping everything after it.
(function cutConsole() {
    const i = s.indexOf('    <div id="console">');
    if (i < 0) throw new Error('console open tag not found');
    let depth = 0, j = i;
    const re = /<div\b|<\/div>/g;
    re.lastIndex = i;
    let m;
    while ((m = re.exec(s)) !== null) {
        depth += m[0] === '</div>' ? -1 : 1;
        if (depth === 0) { j = re.lastIndex; break; }
    }
    if (depth !== 0) throw new Error('console close tag not found');
    // also swallow the newline after the closing tag
    while (s[j] === '\n' || s[j] === '\r') j++;
    s = s.slice(0, i) + s.slice(j);
    console.log('cut html #console block');
})();
// remnant strings inside later-deleted JS functions are checked in the
// final pass below, after every cut has run.

// --- C. JS ----------------------------------------------------------------
rep(`var activeTab = 'source';\n`, '', 'js: drop activeTab var');

rep(
    `    if (count === 0) {
        postSelectedComponents([]);
        clearInspect();
        return;
    }

    var drawnFeatures = features.filter(function(f) { return f.get('isDrawn'); });
    var gdsFeatures = features.filter(function(f) { return !f.get('isDrawn'); });
    postSelectedComponents(features);

    if (drawnFeatures.length > 0 && gdsFeatures.length === 0) {
        if (drawnFeatures.length === 1) {
            showDrawnInspect(drawnFeatures[0]);
        } else {
            showDrawnMultiInspect(drawnFeatures);
        }
    } else if (drawnFeatures.length === 0) {
        if (gdsFeatures.length === 1) {
            showInspect(gdsFeatures[0]);
        } else {
            showMultiInspect(gdsFeatures);
        }
    } else {
        showMixedInspect(gdsFeatures, drawnFeatures);
    }
}`,
    `    if (count === 0) {
        postSelectedComponents([]);
        return;
    }

    // Selection detail (source refs + geometry) is logged by the extension
    // into the "GDS Navigator" Output channel — no in-viewer panels.
    postSelectedComponents(features);
}`,
    'js: onSelectionChanged dispatch'
);

rep(
    `function postSelectedComponents(features) {
    var mode = document.getElementById('claude-mode').value;
    var msg = {
        type: 'selectComponents',
        components: componentsFromFeatures(features),
        claudeMode: mode
    };`,
    `function postSelectedComponents(features) {
    var msg = {
        type: 'selectComponents',
        components: componentsFromFeatures(features)
    };`,
    'js: postSelectedComponents without mode'
);

rep(
    `        return {
            provId: f.ol_uid,
            layer: f.get('layer') || '',
            bbox: geomExtentToBbox(extent),
            provenance: f.get('provenance') || {}
        };`,
    `        var comp = {
            provId: f.ol_uid,
            layer: f.get('layer') || '',
            bbox: geomExtentToBbox(extent),
            provenance: f.get('provenance') || {}
        };
        if (f.get('isDrawn')) {
            comp.drawn = true;
            comp.shape = getShapeGeom(f);
        }
        return comp;`,
    'js: componentsFromFeatures enriched'
);

cut(
    '// ============================================================\n// Multi-inspect and source panel\n// ============================================================\nfunction showMultiInspect(features) {',
    '// ============================================================\n// GDS GeoJSON format, source, and vector layer',
    'js: showMultiInspect + updateMultiSourcePanel + renderSourceLinks'
);

rep(
    `    clearInspect();
    buildLegend();`,
    `    buildLegend();`,
    'js: loadGdsData drop clearInspect'
);

cut(
    '// ============================================================\n// Port formatting\n// ============================================================\nfunction formatPorts(prov) {',
    'function _normalizeCallChain(prov) {',
    'js: formatPorts'
);

cut(
    '// ============================================================\n// Console panel -- showInspect\n// ============================================================\nfunction showInspect(feature) {',
    '// ============================================================\n// Drawn shape geometry utils',
    'js: showInspect..esc helpers'
);

cut(
    '// ============================================================\n// Drawn shape inspection\n// ============================================================\nfunction showDrawnInspect(feature) {',
    '// ============================================================\n// shapeToYAML',
    'js: showDrawn*Inspect + showMixedInspect'
);

cut(
    '// ============================================================\n// Console toggle',
    '// ============================================================\n// Copy YAML',
    'js: toggleConsole section'
);

rep(
    `        var btn0 = document.getElementById('copy-btn');
        btn0.textContent = 'Nothing selected';
        btn0.classList.add('copied');
        setTimeout(function() { btn0.textContent = 'Copy YAML'; btn0.classList.remove('copied'); }, 1500);`,
    `        var btn0 = document.getElementById('copy-btn');
        btn0.classList.add('copied');
        btn0.title = 'Nothing selected';
        setTimeout(function() { btn0.classList.remove('copied'); btn0.title = 'Copy selection as YAML (Ctrl+Shift+C)'; }, 1500);`,
    'js: copyYAML empty feedback'
);
rep(
    `    var btn = document.getElementById('copy-btn');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(function() { btn.textContent = 'Copy YAML'; btn.classList.remove('copied'); }, 2000);`,
    `    var btn = document.getElementById('copy-btn');
    btn.classList.add('copied');
    btn.title = 'YAML copied to clipboard';
    setTimeout(function() { btn.classList.remove('copied'); btn.title = 'Copy selection as YAML (Ctrl+Shift+C)'; }, 2000);`,
    'js: copyYAML success feedback'
);

rep(
    `    on($('#copy-btn'), copyYAML);
    on($('#console-toggle'), toggleConsole);
`,
    `    on($('#copy-btn'), copyYAML);
`,
    'js: drop console-toggle binding'
);
rep(
    `
    document.querySelectorAll('.tab-btn[data-tab]').forEach(function (btn) {
        on(btn, function (e) { switchTab(e, btn.dataset.tab); });
    });
})();`,
    `
})();`,
    'js: drop tab-btn bindings'
);

// residual references must be gone
for (const bad of ['showInspect', 'showMultiInspect', 'showDrawnInspect', 'showDrawnMultiInspect',
    'showMixedInspect', 'clearInspect', 'switchTab', 'toggleConsole', 'formatPorts', 'renderSourceLinks',
    'updateMultiSourcePanel', 'addKV', 'addSep', 'info-panel', 'source-panel', 'claude-mode',
    'console-toggle', 'tab-btn', '#console', 'console-header', 'console-body', 'function esc(', 'frag()']) {
    if (s.includes(bad)) throw new Error('residual reference: ' + bad);
}

fs.writeFileSync(file, s);
console.log('OK', before, '->', s.length, 'chars');

// syntax-check the inline script
const m = s.match(/<script>([\s\S]*)<\/script>/);
if (!m) throw new Error('no script block');
fs.writeFileSync(path.join(__dirname, '_viewer_check.js'), m[1]);
