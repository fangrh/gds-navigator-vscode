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
const { loadComponentCatalog, previewComponent } = require(bundle);
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
assert(call(['--preview', 'does_not_exist', '{}']).error, 'unknown name accepted');
assert(call(['--preview', 'straight', '{"unknown":1}']).error, 'unknown setting accepted');
assert(call(['--preview', 'straight', '[]']).error, 'malformed settings accepted');
(async () => {
    const apiCatalog = await loadComponentCatalog(python);
    assert(apiCatalog.components.length > 200, 'TypeScript catalog API returned too few components');
    const apiPreview = await previewComponent(python, 'straight', { length: 11 });
    assert(apiPreview.geojson.features.length > 0, 'TypeScript preview API returned empty geometry');
    fs.unlinkSync(bundle);
    console.log(JSON.stringify({ status: 'passed', components: catalog.components.length, previews: 4, api: true }));
})().catch(error => { try { fs.unlinkSync(bundle); } catch {} process.nextTick(() => { throw error; }); });
