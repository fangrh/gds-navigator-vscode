const assert = require('assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const python = process.env.GDS_TEST_PYTHON || path.join(root, '.venv-fork', 'Scripts', 'python.exe');
if (!fs.existsSync(python)) { console.log(JSON.stringify({ status: 'skipped', reason: 'fork Python unavailable' })); process.exit(0); }
const script = path.join(root, 'python', 'component_catalog.py');
const bundle = path.join(os.tmpdir(), `gds-component-catalog-${process.pid}.cjs`);
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src', 'componentCatalog.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { loadComponentCatalog, previewComponent, requestComponentThumbnails } = require(bundle);
function call(args) {
    try { return JSON.parse(cp.execFileSync(python, [script, ...args], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 })); }
    catch (error) { return JSON.parse(String(error.stdout || '{}')); }
}
const catalog = call(['--catalog']);
assert(catalog.components.length > 200, 'catalog did not discover the installed component factories');
for (const name of ['straight', 'taper', 'bend_circular', 'circle']) assert(catalog.components.some(x => x.name === name), `missing ${name}`);
const byName = new Map(catalog.components.map(x => [x.name, x]));
assert(byName.get('straight').parameters.some(x => x.name === 'length' && x.default === 10), 'signature defaults missing');
for (const [name, settings] of [['straight', { length: 12 }], ['taper', { length: 12, width1: 1, width2: 2 }], ['bend_circular', { radius: 10 }], ['circle', { radius: 5 }]]) {
    const preview = call(['--preview', name, JSON.stringify(settings)]);
    assert.equal(preview.name, name); assert(preview.geojson.features.length > 0, `${name} preview empty`); assert(Array.isArray(preview.ports));
}
const thumbnails = call(['--thumbnails', JSON.stringify(['straight', 'circle', 'does_not_exist'])]);
assert.equal(thumbnails.items.length, 3, 'thumbnail batch did not preserve requested items');
assert(thumbnails.items[0].geojson.features.length > 0, 'straight thumbnail empty');
assert(thumbnails.items[1].geojson.features.length > 0, 'circle thumbnail empty');
assert(thumbnails.items[2].error, 'unknown thumbnail name accepted');
assert(call(['--thumbnails', JSON.stringify(['straight', 'circle', 'taper', 'bend_circular', 'rectangle', 'cross', 'mmi1x2', 'grating_coupler'])]).items.length === 8, 'eight-name thumbnail batch rejected');
assert(call(['--thumbnails', JSON.stringify(['straight', 'circle', 'taper', 'bend_circular', 'rectangle', 'cross', 'mmi1x2', 'grating_coupler', 'extra'])]).error, 'thumbnail batch limit not enforced');
assert(call(['--preview', 'does_not_exist', '{}']).error, 'unknown name accepted');
assert(call(['--preview', 'straight', '{"unknown":1}']).error, 'unknown setting accepted');
assert(call(['--preview', 'straight', '[]']).error, 'malformed settings accepted');
(async () => {
    const apiCatalog = await loadComponentCatalog(python);
    assert(apiCatalog.components.length > 200, 'TypeScript catalog API returned too few components');
    const apiPreview = await previewComponent(python, 'straight', { length: 11 });
    assert(apiPreview.geojson.features.length > 0, 'TypeScript preview API returned empty geometry');
    const apiThumbnails = await requestComponentThumbnails(python, ['straight', 'circle', 'does_not_exist']);
    assert.equal(apiThumbnails.items.length, 3, 'TypeScript thumbnail API returned wrong item count');
    assert(apiThumbnails.items[0].geojson, 'TypeScript thumbnail API returned empty geometry');
    assert(apiThumbnails.items[2].error, 'TypeScript thumbnail API lost per-item error');
    fs.unlinkSync(bundle);
    console.log(JSON.stringify({ status: 'passed', components: catalog.components.length, previews: 4, api: true }));
})().catch(error => { try { fs.unlinkSync(bundle); } catch {} process.nextTick(() => { throw error; }); });
