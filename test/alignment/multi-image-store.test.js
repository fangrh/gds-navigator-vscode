// Collection persistence regression: ordering, same-file IDs, migration, and restore.
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), Module = require('module'), esbuild = require('esbuild');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-multi-image-')), bundle = path.join(dir, 'provider.cjs');
  try {
    esbuild.buildSync({ entryPoints: [path.join(__dirname, '../../src/gdsEditor.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle });
    const original = Module._load; let GdsEditorProvider;
    try { Module._load = function (name, ...args) { if (name === 'vscode') return { window: { createTextEditorDecorationType: () => ({}) }, OverviewRulerLane: { Right: 4 } }; return original.call(this, name, ...args); }; ({ GdsEditorProvider } = require(bundle)); } finally { Module._load = original; }
    const values = new Map(), messages = [];
    const provider = new GdsEditorProvider({ extensionUri: { fsPath: dir }, workspaceState: { get: k => values.get(k), update: async (k, v) => { if (v === undefined) values.delete(k); else values.set(k, v); } } }, {}, { appendLine: () => {} });
    const gdsPath = path.join(dir, 'chip.gds'), imagePath = path.join(dir, 'image.png'); fs.writeFileSync(imagePath, Buffer.from('same-image'));
    const imageHash = crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex');
    const state = (cx) => ({ version: 1, imageSizePx: [1, 1], cx, cy: 2, umPerPx: .5, rotDeg: 0, opacity: 1, display: {mode:cx===11?'contours':'image-contours',threshold:60,color:'#ff00aa',width:2,border:true}, visible: true, locked: true, markerTransform: null, markerPose: null, quality: { status: 'unverified', boundaryRmsPx: null, markerCount: 0 }, options: { markerAppearance: 'yellow', markerLayers: ['1/0'] } });
    const idA = imageHash + ':a', idB = imageHash + ':b';
    const entry = { gdsPath, gdsHash: 'gds-a', currentImageId: idA, currentImagePath: imagePath, currentImageHash: imageHash, loading: false, images: new Map([[idA, { imageId: idA, order: 0, imagePath, imageHash, gdsHash: 'gds-a', state: state(1) }], [idB, { imageId: idB, order: 1, imagePath, imageHash, gdsHash: 'gds-a', state: state(2) }]]), panel: { webview: { postMessage: async m => { messages.push(m); return true; } } } };
    await provider.saveImageState(entry, { imageId: idA, layoutHash: 'gds-a', state: state(11), revision: 1 });
    await provider.saveImageState(entry, { imageId: idB, layoutHash: 'gds-a', state: state(22), revision: 1 });
    const stored = [...values.values()][0]; assert.equal(stored.version, 2); assert.deepEqual(stored.images.map(i => i.imageId), [idA, idB]);
    await provider.reorderImages(entry, { imageIds: [idB, idA], layoutHash: 'gds-a' });
    assert.deepEqual([...values.values()][0].images.sort((a, b) => a.order - b.order).map(i => i.imageId), [idB, idA]);
    messages.length = 0; entry.images = new Map(); entry.currentImageId = undefined; await provider.restoreSavedImage(entry, 'gds-a');
    const loads = messages.filter(m => m.type === 'loadImage'); assert.deepEqual(loads.map(m => m.imageId), [idB, idA]); assert.deepEqual(loads.map(m => m.append), [true, true]);
    assert.deepEqual(loads.map(m=>m.savedState.display),[state(22).display,state(11).display], 'contour display settings crossed between images');
    entry.images.set('pending', { imageId:'pending',order:2,imagePath,imageHash,gdsHash:'gds-a',state:undefined });
    await provider.saveImageState(entry,{imageId:idA,layoutHash:'gds-a',state:state(33),revision:2});
    assert.equal([...values.values()][0].images.length,2,'pending image made saved collection invalid');
    const aligned={...state(22),markerTransform:[1,0,0,0,-1,0,0,0,1],markerPose:{cx:22,cy:2,umPerPx:.5,rotDeg:0},quality:{status:'aligned',boundaryRmsPx:.5,markerCount:4}};
    await provider.saveImageState(entry,{imageId:idB,layoutHash:'gds-a',state:aligned,revision:2});
    entry.gdsHash='gds-b';messages.length=0;await provider.restoreSavedImage(entry,'gds-b');
    const changed=messages.filter(m=>m.type==='loadImage');assert.equal(changed.length,2);
    assert(changed.every(m=>m.savedState.quality.status==='unverified'),'changed GDS retained verified status');
    assert.deepEqual(changed.find(m=>m.imageId===idB).savedState.markerTransform,aligned.markerTransform,'changed GDS altered image placement');
    assert.equal([...values.values()][0].gdsHash,'gds-b');
    await provider.clearImageState(entry, { imageId: idB }); assert.equal([...values.values()][0].images.length, 1); assert.equal([...values.values()][0].images[0].imageId, idA);
    console.log('multi-image persistence: collection, stable duplicate IDs, reorder, sequential restore, clear passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
