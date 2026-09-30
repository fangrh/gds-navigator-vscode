const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const extensionRoot = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-starter-'));
try {
    const bundle = path.join(temp, 'starter.cjs');
    esbuild.buildSync({ entryPoints: [path.join(extensionRoot, 'src/starterProject.ts')], outfile: bundle, bundle: true, platform: 'node' });
    const { initializeGdsProject, createMarkerExample } = require(bundle);
    const root = path.join(temp, 'project'); fs.mkdirSync(root);
    const initialized = initializeGdsProject(root);
    assert.equal(initialized.created.length, 5);
    for (const folder of ['scripts', 'layouts', 'images']) assert(fs.statSync(path.join(root, folder)).isDirectory());
    const guide = fs.readFileSync(initialized.guide, 'utf8');
    assert.match(guide, /Create marker template \(50 µm JJ pad\)/);
    assert.match(guide, /gds_components.py/);
    const library = path.join(root, 'gds_components.py');
    const librarySource = fs.readFileSync(library, 'utf8');
    assert.match(librarySource, /COMPONENTS =/);
    assert.deepEqual(initializeGdsProject(root).created, []);
    assert.equal(fs.readFileSync(initialized.guide, 'utf8'), guide);
    fs.writeFileSync(library, '# user-edited library\n' + librarySource);
    initializeGdsProject(root);
    assert.equal(fs.readFileSync(library, 'utf8'), '# user-edited library\n' + librarySource, 'initialization overwrote a custom component library');
    const python = process.env.GDS_TEST_PYTHON || path.join(extensionRoot, '.venv-fork', 'Scripts', 'python.exe');
    assert(fs.existsSync(python), 'fork Python required to validate starter geometry');
    const preview = JSON.parse(require('child_process').execFileSync(python, [path.join(extensionRoot, 'python/component_catalog.py'), '--project-root', root, '--preview', 'project:electrical_strip', '{"length":30,"layer":[2,0]}'], { encoding: 'utf8', timeout: 60000 }));
    assert(preview.geojson.features.length > 0);
    assert.equal(preview.ports.length, 2);
    assert.equal(preview.ports[1].center[0], 30);
    assert.deepEqual(preview.ports[1].layer, [2, 0]);

    const example = createMarkerExample(root, extensionRoot);
    assert.equal(example.created, true);
    assert.deepEqual(fs.readFileSync(example.script), fs.readFileSync(path.join(extensionRoot, 'templates/generate_jj_pad_center_50.py')));
    assert.deepEqual(fs.readFileSync(example.gds), fs.readFileSync(path.join(extensionRoot, 'templates/jj_pad_center_50_test.gds')));
    assert.deepEqual(fs.readFileSync(example.gds), fs.readFileSync(path.join(extensionRoot, 'test/fixtures/jj_pad_center_50_test.gds')));
    assert.equal(createMarkerExample(root, extensionRoot).created, false);
    assert.equal(fs.readFileSync(initialized.guide, 'utf8'), guide);

    const partial = path.join(temp, 'partial'); fs.mkdirSync(partial); fs.mkdirSync(path.join(partial, 'scripts'));
    fs.writeFileSync(path.join(partial, 'scripts/generate_jj_pad_center_50.py'), 'user file');
    assert.throws(() => createMarkerExample(partial, extensionRoot), /already exists/);
    assert.equal(fs.readFileSync(path.join(partial, 'scripts/generate_jj_pad_center_50.py'), 'utf8'), 'user file');
    assert(!fs.existsSync(path.join(partial, 'layouts/jj_pad_center_50_test.gds')));

    const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
    assert(manifest.contributes.viewsContainers.activitybar.some(view => view.id === 'gdsNavigator' && fs.existsSync(path.join(extensionRoot, view.icon))));
    assert(manifest.contributes.viewsWelcome.some(view => view.view === 'gdsNavigator.start' && view.contents.includes('gdsNavigator.createMarkerExample')));
    console.log('starter project tests passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
