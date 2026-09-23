const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os'), Module = require('module'), cp = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-provider-instructions-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-provider-bundle-'));
require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../../src/gdsEditor.ts')], bundle: true, platform: 'node', external: ['vscode'], outfile: path.join(tmp, 'provider.js') });
let clipboard = '', messages = [];
const vscode = { Uri: { file: fsPath => ({ fsPath }) }, window: { createTextEditorDecorationType: () => ({}), showErrorMessage() {}, setStatusBarMessage() {} }, OverviewRulerLane: { Right: 4 },
    workspace: { workspaceFolders: [{ uri: { fsPath: root } }], getWorkspaceFolder: () => ({ uri: { fsPath: root } }) }, env: { getPython: () => path.join(root, 'Python Env', 'python.exe'), clipboard: { writeText: async text => { clipboard = text; }, readText: async () => clipboard } } };
const original = Module._load; let Provider;
try { Module._load = function (name, ...args) { if (name === 'vscode') return vscode; if (name === 'child_process') return { spawn: () => { const { EventEmitter } = require('events'); const p = new EventEmitter(); p.stdin = { on() { return this; }, end(text) { clipboard = text; setImmediate(() => p.emit('close', 0)); } }; p.kill = () => {}; return p; } }; return original.call(this, name, ...args); }; Provider = require(path.join(tmp, 'provider.js')).GdsEditorProvider; } finally { Module._load = original; }
const values = new Map(); const provider = new Provider({ extensionUri: { fsPath: path.join(__dirname, '../..') }, workspaceState: { get: k => values.get(k), update: async (k, v) => values.set(k, v) } }, { getPython: () => path.join(root, 'Python Env', 'python.exe') }, { appendLine() {} });
const entry = file => { const item = { gdsPath: path.join(root, file), gdsHash: 'hash-' + file, topCell: 'TOP', loading: false, ready: true, disposed: false, lastSelection: [], elementCatalog: [], posts: [] }; item.panel = { webview: { postMessage: async m => { messages.push(m); item.posts.push(m); return true; } } }; return item; };
const a = entry('a.gds'), b = entry('b.gds');
const annotation = id => ({ id, shapeType: 'polygon', geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] }, intent: { action: 'add', text: 'Add this proposal.', targetIds: [] } });
function queueFile() { return path.join(root, '.gds-navigator', 'instructions.json'); }
function stored(key) { return provider.state.get(key); }
(async () => {
    try {
        await provider.onMessage(a, { type: 'saveAnnotations', layoutHash: a.gdsHash, recordInstruction: true, components: [], annotations: [annotation('proposal-a')] });
        assert.deepEqual(stored('gdsNavigator.annotations.v1:' + a.gdsPath.toLowerCase()), [annotation('proposal-a')]);
        let store = JSON.parse(fs.readFileSync(queueFile(), 'utf8')); assert.equal(store.records.length, 1); const first = store.records[0]; assert.equal(first.context.schema, 'gds-navigator.selection'); assert(first.context.annotations.length === 1);
        await provider.onMessage(a, { type: 'instructionAction', action: 'add', layoutHash: a.gdsHash, request: { action: 'inspect', text: 'Second request' }, components: [] });
        store = JSON.parse(fs.readFileSync(queueFile(), 'utf8')); const second = store.records[1]; assert.equal(second.context.request.action, 'inspect'); assert.equal(second.runtime.env.GDS_PROVENANCE, '1'); assert.match(second.runtime.executable, /Python Env/);
        await provider.onMessage(a, { type: 'instructionAction', action: 'done', id: second.id }); assert(messages.some(m => m.type === 'instructionError' && /FIFO/.test(m.error)));
        await provider.onMessage(a, { type: 'instructionAction', action: 'copyRef', id: first.id }); assert(clipboard.includes(first.id) && clipboard.includes('instructions.json'), JSON.stringify({ clipboard, first: first.id, messages }));
        await provider.onMessage(a, { type: 'instructionAction', action: 'done', id: first.id });
        await provider.onMessage(a, { type: 'instructionAction', action: 'revert', id: first.id });
        assert.deepEqual(stored('gdsNavigator.annotations.v1:' + a.gdsPath.toLowerCase()), []); assert(messages.some(m => m.type === 'restoreAnnotations'));
        store = JSON.parse(fs.readFileSync(queueFile(), 'utf8')); assert.equal(store.records[0].status, 'reverted'); assert.match(store.records[0].note, /source|Python|GDS/i);
        await provider.onMessage(b, { type: 'instructionAction', action: 'copyDetails', id: second.id }); assert(messages.some(m => m.type === 'instructionError' && /another layout|another layout/i.test(m.error)));
        const source = path.join(root, 'build.py'); fs.writeFileSync(source, 'x = 1\n');
        await provider.onMessage(a, { type: 'instructionAction', action: 'add', layoutHash: a.gdsHash, request: { action: 'inspect', text: 'Source receipt' }, components: [] });
        store = JSON.parse(fs.readFileSync(queueFile(), 'utf8')); const third = store.records[store.records.length - 1];
        const { InstructionQueue } = require('../../dist/instructionQueue.js'); const q = new InstructionQueue(root); q.setStatus(second.id, 'done'); q.start(third.id, [source]); fs.writeFileSync(source, 'x = 2\n');
        cp.execFileSync(process.execPath, [path.join(__dirname, '../../scripts/instructions.cjs'), '--queue', queueFile(), 'done', third.id]);
        messages = []; await provider.onMessage(a, { type: 'instructionAction', action: 'refresh' }); assert(messages.some(m => m.type === 'instructions' && m.records.some(r => r.id === third.id && r.status === 'done')));
        provider.viewers.set('a', [a]); provider.viewers.set('b', [b]); provider.activeEntry = a;
        vscode.window.tabGroups = { activeTabGroup: { activeTab: { input: { uri: { fsPath: b.gdsPath } } } } };
        a.posts = []; b.posts = []; await provider.commandCopyYaml();
        assert.equal(a.posts.filter(m => m.type === 'requestYaml').length, 0); assert.equal(b.posts.filter(m => m.type === 'requestYaml').length, 1);
        // Source undo refuses newer edits and preserves the work-order state.
        fs.writeFileSync(source, 'x = 3\n'); messages = [];
        await provider.onMessage(a, { type: 'instructionAction', action: 'revert', id: third.id });
        assert(messages.some(m => m.type === 'instructionError' && /Source changed/.test(m.error)));
        assert.equal(fs.readFileSync(source, 'utf8'), 'x = 3\n');
        fs.writeFileSync(source, 'x = 2\n');
        await provider.onMessage(a, { type: 'instructionAction', action: 'revert', id: third.id });
        assert.equal(fs.readFileSync(source, 'utf8'), 'x = 1\n');
        const comp = {provId:'target-order',layer:'1/0',geometry:{type:'Polygon',coordinates:[[[0,0],[2,0],[2,2],[0,0]]]},provenance:{}};
        await provider.onMessage(a, {type:'instructionAction',action:'add',workOrder:true,requestId:'new-a',layoutHash:a.gdsHash,request:{action:'move',text:'Move selected pad',targetIds:['target-order']},components:[comp]});
        await provider.onMessage(b, {type:'instructionAction',action:'add',workOrder:true,requestId:'new-b',layoutHash:b.gdsHash,request:{action:'inspect',text:'Explain selected pad',targetIds:['target-order']},components:[comp]});
        const addedB=messages.find(m=>m.type==='instructionAdded'&&m.requestId==='new-b'); assert(addedB&&addedB.id);
        assert(messages.some(m=>m.type==='instructions'&&m.gdsPath===b.gdsPath&&m.nextOpen===addedB.id));
        await provider.onMessage(b,{type:'instructionAction',action:'copyRef',id:addedB.id}); assert(clipboard.includes('this_gds')&&clipboard.includes('--gds')&&clipboard.includes('Explain selected pad'));
        await provider.onMessage(b,{type:'instructionAction',action:'done',id:addedB.id});
        store=JSON.parse(fs.readFileSync(queueFile(),'utf8')); assert.equal(store.records.find(r=>r.id===addedB.id).status,'done');
        const priorCount=store.records.length; await provider.onMessage(b,{type:'instructionAction',action:'add',workOrder:true,requestId:'empty',layoutHash:b.gdsHash,request:{action:'inspect',text:'No targets'},components:[]});
        assert.equal(JSON.parse(fs.readFileSync(queueFile(),'utf8')).records.length,priorCount); assert(messages.some(m=>m.type==='instructionError'&&m.requestId==='empty'));
        await provider.onMessage(b,{type:'instructionAction',action:'comment',id:addedB.id,text:'Keep the pad center fixed.',requestId:'comment-b'});
        assert(messages.some(m=>m.type==='instructionCommented'&&m.id===addedB.id&&m.requestId==='comment-b'));
        const commented=JSON.parse(fs.readFileSync(queueFile(),'utf8')).records.find(r=>r.id===addedB.id);
        assert.equal(commented.comments[0].text,'Keep the pad center fixed.'); assert.equal(commented.history.at(-1).event,'comment');
        await provider.onMessage(a,{type:'instructionAction',action:'comment',id:addedB.id,text:'wrong file',requestId:'wrong-comment'});
        assert(messages.some(m=>m.type==='instructionError'&&m.requestId==='wrong-comment'&&/another layout/.test(m.error)));
        await provider.onMessage(b,{type:'instructionAction',action:'comment',id:addedB.id,text:' ',requestId:'empty-comment'});
        assert(messages.some(m=>m.type==='instructionError'&&m.requestId==='empty-comment'));
        assert.equal(JSON.parse(fs.readFileSync(queueFile(),'utf8')).records.find(r=>r.id===addedB.id).comments.length,1);
        await provider.onMessage(b,{type:'instructionAction',action:'copyDetails',id:addedB.id}); assert(clipboard.includes('Keep the pad center fixed.'));
        // Rebuild derives current links without rewriting historical work orders or stored geometry.
        const addedA=messages.find(m=>m.type==='instructionAdded'&&m.requestId==='new-a');
        const journalBefore=fs.readFileSync(queueFile(),'utf8');
        const bound={...annotation('bound-drawing'),intent:{action:'move',text:'keep drawing',targetIds:['target-order'],snapshot:'hash-a.gds',documentPath:a.gdsPath}};
        await provider.onMessage(a,{type:'saveAnnotations',layoutHash:a.gdsHash,annotations:[bound],recordInstruction:false});
        a.gdsHash='rebuilt-a';a.elementCatalog=[{...comp,provId:'new-target-order'}];
        await provider.onMessage(a,{type:'instructionAction',action:'refresh'});
        const refreshed=a.posts.filter(m=>m.type==='instructions').at(-1).records.find(r=>r.id===addedA.id);
        assert.equal(refreshed.tracking.status,'relinked');assert.deepEqual(refreshed.tracking.targetIds,['new-target-order']);
        assert.equal(refreshed.gdsHash,'hash-a.gds');assert.equal(fs.readFileSync(queueFile(),'utf8'),journalBefore);
        const rebound=provider.annotationsForLayout(a)[0];assert.deepEqual(rebound.geometry,bound.geometry);assert.deepEqual(rebound.intent.targetIds,['new-target-order']);assert.equal(rebound.intent.snapshot,'rebuilt-a');
        assert.deepEqual(stored('gdsNavigator.annotations.v1:'+a.gdsPath.toLowerCase())[0],bound,'view rebind overwrote saved historical annotation');
        a.elementCatalog.push({...comp,provId:'ambiguous-target'});
        assert.equal(provider.withTracking(a,refreshed).tracking.status,'needs_review');
        assert.deepEqual(provider.annotationsForLayout(a)[0].intent,bound.intent,'ambiguous rebind replaced original targets');
        console.log(JSON.stringify({ status: 'passed', checks: ['record-context', 'fifo-done-rejection', 'copy-reference', 'annotation-revert', 'wrong-document', 'external-cli-done-refresh', 'active-tab-copy-target','checked-source-undo','per-gds-work-orders','required-targets','work-order-ack'] }));
    } finally { await provider.shutdownUsage(); fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
