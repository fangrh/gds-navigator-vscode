const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os'), Module = require('module'), cp = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-usage-provider-')), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-usage-bundle-'));
require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../../src/gdsEditor.ts')], bundle: true, platform: 'node', external: ['vscode'], outfile: path.join(tmp, 'provider.js') });
let clipboard = '', messages = [], enabled = true, quickPick = 'Review usage report';
const vscode = { window: { createTextEditorDecorationType: () => ({}), showErrorMessage() {}, showInformationMessage() {}, showWarningMessage() {}, setStatusBarMessage() {}, showQuickPick: async () => quickPick, showTextDocument: async () => {} }, OverviewRulerLane: { Right: 4 },
    workspace: { workspaceFolders: [{ uri: { fsPath: root } }], getWorkspaceFolder: () => ({ uri: { fsPath: root } }), getConfiguration: () => ({ get: () => enabled, update: async (_k, v) => { enabled = v; } }), ConfigurationTarget: { Workspace: 2 } },
    env: { clipboard: { writeText: async text => { clipboard = text; }, readText: async () => clipboard } }, commands: { executeCommand: async () => {} }, Uri: { file: p => ({ fsPath: p }) } };
const original = Module._load; let Provider;
try { Module._load = function (name, ...args) { if (name === 'vscode') return vscode; if (name === 'child_process') return { spawn: () => { const e = new (require('events').EventEmitter)(); e.stdin = { on() { return this; }, end(text) { clipboard = text; setImmediate(() => e.emit('close', 0)); } }; e.kill = () => {}; return e; } }; return original.call(this, name, ...args); }; Provider = require(path.join(tmp, 'provider.js')).GdsEditorProvider; } finally { Module._load = original; }
const state = new Map(); const provider = new Provider({ extension: { packageJSON: { version: 'test' } }, extensionUri: { fsPath: path.join(__dirname, '../..') }, workspaceState: { get: k => state.get(k), update: async (k, v) => state.set(k, v) } }, {}, { appendLine() {} });
const entry = name => ({ gdsPath: path.join(root, name), gdsHash: 'hash-' + name, topCell: 'TOP', loading: false, snapshotReady: true, ready: true, disposed: false, lastSelection: [], elementCatalog: [], panel: { webview: { postMessage: async m => { messages.push(m); return true; } } } });
const a = entry('a.gds'), b = entry('b.gds'); const target = { provId: 'pad', layer: '1/0', geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 1], [0, 0]]] }, provenance: {} };
(async () => {
    try {
        await provider.onMessage(a, { type: 'usageEvent', action: 'ui.control', phase: 'intent', control: 'copy', kind: 'polygon' });
        await provider.onMessage(a, { type: 'exportYaml', layoutHash: a.gdsHash, components: [] });
        await provider.onMessage(b, { type: 'exportYaml', layoutHash: b.gdsHash, components: [target] });
        const logs = [...provider.usageLogs.values()]; for (const log of logs) await log.flush();
        const usageDir = path.join(root, '.gds-navigator', 'usage'); const files = fs.readdirSync(usageDir).filter(n => n.startsWith('session-') && n.endsWith('.jsonl'));
        const events = files.flatMap(f => fs.readFileSync(path.join(usageDir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
        assert(events.some(e => e.action === 'selection.copy' && e.outcome === 'failure')); assert(events.some(e => e.action === 'selection.copy' && e.outcome === 'success')); assert(events.some(e => e.documentId)); assert(!JSON.stringify(events).includes('a.gds')); assert(!JSON.stringify(events).includes('b.gds')); assert(new Set(events.filter(e => e.documentId).map(e => e.documentId)).size >= 2);
        quickPick = 'Review usage report'; await provider.commandUsageLogs(a, true); assert(fs.existsSync(path.join(root, '.gds-navigator', 'usage-report.md'))); assert(fs.existsSync(path.join(root, '.gds-navigator', 'usage-report.json')));
        const summary = JSON.parse(fs.readFileSync(path.join(root, '.gds-navigator', 'usage-report.json'), 'utf8')); assert.equal(summary.totalEvents, events.length); assert.equal(summary.malformedEvents, 0);
        const count = events.length; enabled = false; await provider.onMessage(a, { type: 'usageEvent', action: 'ui.control', phase: 'intent', control: 'copy', kind: 'polygon' }); for (const log of logs) await log.flush();
        const after = files.flatMap(f => fs.readFileSync(path.join(usageDir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)); assert.equal(after.length, count);
        console.log(JSON.stringify({ status: 'passed', checks: ['incoming-event', 'copy-failure', 'copy-success', 'hashed-document-identities', 'report-command', 'paused-suppression'] }));
    } finally { await provider.shutdownUsage(); fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
