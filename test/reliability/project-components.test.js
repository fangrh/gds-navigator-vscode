const assert = require('assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const python = process.env.GDS_TEST_PYTHON || path.join(root, '.venv-fork', 'Scripts', 'python.exe');
if (!fs.existsSync(python)) { console.log(JSON.stringify({ status: 'skipped', reason: 'fork Python unavailable' })); process.exit(0); }
const script = path.join(root, 'python', 'component_catalog.py');
const bundle = path.join(os.tmpdir(), `gds-project-components-${process.pid}.cjs`);
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src', 'componentCatalog.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { loadComponentCatalog, previewComponent, requestComponentThumbnails } = require(bundle);
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-project-components-'));
fs.writeFileSync(path.join(projectRoot, 'helper.py'), 'def scale(value):\n    return value\n');
fs.writeFileSync(path.join(projectRoot, 'lazy_helper.py'), 'def adjust(value):\n    return value+2\n');
fs.writeFileSync(path.join(projectRoot, 'gds_components.py'), [
    'import gdsfactory as gf',
    'from helper import scale',
    'def demo(length=7, width=1):',
    '    from lazy_helper import adjust',
    '    print("factory diagnostic")',
    '    return gf.components.straight(length=adjust(scale(length)), width=width)',
    'def collision(length=3):',
    '    return gf.components.straight(length=length)',
    'COMPONENTS = {"demo": demo, "straight": collision, "bad-value": 3}',
    ''.trim(),
].join('\n'));
function call(args) {
    try { return JSON.parse(cp.execFileSync(python, [script, ...args], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 })); }
    catch (error) { return JSON.parse(String(error.stdout || '{}')); }
}
try {
    const builtin = call(['--catalog']);
    assert(builtin.components.some(x => x.name === 'straight'));
    assert(!builtin.components.some(x => x.name === 'project:demo'), 'project component leaked without project root');

    const catalog = call(['--catalog', '--project-root', projectRoot]);
    const demo = catalog.components.find(x => x.name === 'project:demo');
    assert(demo, 'project factory missing from catalog');
    assert.equal(demo.source, 'project');
    assert.deepEqual(demo.library, { module: 'gds_components', exportName: 'demo' });
    assert.equal(demo.category, 'Project components');
    assert(catalog.warnings.some(x => x.includes('bad-value')), 'invalid registry warning missing');
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-broken-components-'));
    fs.writeFileSync(path.join(brokenRoot, 'gds_components.py'), 'raise RuntimeError("broken registry sentinel")\n');
    const broken = call(['--catalog', '--project-root', brokenRoot]);
    assert(broken.components.some(x => x.name === 'straight'), 'broken registry removed builtins');
    assert(broken.warnings.some(x => x.includes('broken registry sentinel')), 'broken registry warning missing');
    fs.rmSync(brokenRoot, { recursive: true, force: true });

    const preview = call(['--preview', 'project:demo', JSON.stringify({ length: 12, width: 2 }), '--project-root', projectRoot]);
    assert(!preview.error, `custom preview failed: ${preview.error}`);
    assert.equal(preview.library.exportName, 'demo');
    assert(preview.geojson.features.length > 0 && preview.ports.length >= 2, 'custom preview geometry or ports missing');
    assert.equal(preview.geojson.bbox[2] - preview.geojson.bbox[0], 14, 'custom setting did not change geometry');
    fs.writeFileSync(path.join(projectRoot, 'lazy_helper.py'), 'def adjust(value):\n    return value+3\n');
    const refreshed = call(['--preview', 'project:demo', JSON.stringify({ length: 10, width: 2 }), '--project-root', projectRoot]);
    assert.equal(refreshed.geojson.bbox[2] - refreshed.geojson.bbox[0], 13, 'fresh project source was not loaded');
    assert(call(['--preview', 'project:demo', JSON.stringify({ unknown: 1 }), '--project-root', projectRoot]).error, 'unknown custom setting accepted');
    const thumbnails = call(['--thumbnails', JSON.stringify(['project:demo']), '--project-root', projectRoot]);
    assert.deepEqual(thumbnails.items[0].library, preview.library, 'thumbnail lost library metadata');
    assert(thumbnails.items[0].geojson.features.length > 0 && thumbnails.items[0].ports.length >= 2);

    (async () => {
        const apiCatalog = await loadComponentCatalog(python, undefined, projectRoot);
        assert(apiCatalog.components.some(x => x.name === 'project:demo'));
        const apiPreview = await previewComponent(python, 'project:demo', { length: 10 }, undefined, projectRoot);
        assert.deepEqual(apiPreview.library, preview.library);
        const apiThumbs = await requestComponentThumbnails(python, ['project:demo'], undefined, projectRoot);
        assert.deepEqual(apiThumbs.items[0].library, preview.library);
        console.log(JSON.stringify({ status: 'passed', custom: true, warnings: catalog.warnings.length, api: true }));
    })().catch(error => { process.nextTick(() => { throw error; }); });
} finally {
    process.on('exit', () => { try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {} try { fs.unlinkSync(bundle); } catch {} });
}
