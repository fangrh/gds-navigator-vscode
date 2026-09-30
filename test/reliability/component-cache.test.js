const assert = require('assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const root = path.resolve(__dirname, '../..');
const bundle = path.join(os.tmpdir(), `gds-component-cache-${process.pid}.cjs`);
let spawns = 0;
const spawnRoots = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'child_process') {
        const childProcess = originalLoad.call(this, request, parent, isMain);
        return {
            ...childProcess,
            spawn(python, args) {
                spawns++;
                const rootIndex = args.indexOf('--project-root');
                const projectRoot = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
                spawnRoots.push(projectRoot);
                const proc = new EventEmitter();
                proc.stdout = new EventEmitter();
                proc.stderr = new EventEmitter();
                proc.kill = () => {};
                setImmediate(() => {
                    if (args[1] === '--thumbnails') {
                        const names = JSON.parse(args[2]);
                        proc.stdout.emit('data', Buffer.from(JSON.stringify({ items: names.map(name => ({ name, settings: {}, geojson: { features: [{ id: 77 }] }, ports: [{ name: 'o1' }] })) })));
                    } else {
                        const name = args[2];
                        const settings = JSON.parse(args[3]);
                        proc.stdout.emit('data', Buffer.from(JSON.stringify({ name, settings, geojson: { features: [{ id: spawns }] }, ports: [], ...(name.startsWith('project:') ? { library: { module: 'gds_components', exportName: name.slice(8) } } : {}) })));
                    }
                    proc.emit('close', 0);
                });
                return proc;
            }
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
try {
    require('esbuild').buildSync({ entryPoints: [path.join(root, 'src', 'componentCatalog.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
    const { previewComponent } = require(bundle);
    const python = process.execPath;
    (async () => {
        const first = await previewComponent(python, 'straight', { length: 11, width: 2 });
        assert.equal(spawns, 1, 'first preview should spawn Python');
        first.settings.length = 999;
        const reordered = await previewComponent(python, 'straight', { width: 2, length: 11 });
        assert.equal(spawns, 1, 'reordered settings should hit the cache');
        assert.equal(reordered.settings.length, 11, 'cached result must be isolated from host mutation');
        await previewComponent(python, 'straight', { length: 12, width: 2 });
        assert.equal(spawns, 2, 'changed settings must use a separate cache entry');
        const { requestComponentThumbnails } = require(bundle);
        const thumbnails = await requestComponentThumbnails(python, ['thumb']);
        const thumbnailPreview = await previewComponent(python, 'thumb', {});
        assert.deepEqual(thumbnailPreview.geojson, thumbnails.items[0].geojson, 'thumbnail and preview geometry should match');
        assert.deepEqual(thumbnailPreview.ports, thumbnails.items[0].ports, 'thumbnail and preview ports should match');
        assert.equal(spawns, 3, 'complete thumbnail should seed the preview cache');
        const customRoot = path.join(os.tmpdir(), 'component-cache-custom');
        await previewComponent(python, 'project:demo', { length: 11 }, undefined, customRoot);
        await previewComponent(python, 'project:demo', { length: 11 }, undefined, customRoot);
        assert.equal(spawns, 5, 'project previews must rebuild even with identical settings');
        const builtinRootA = path.join(os.tmpdir(), 'component-cache-root-a');
        const builtinRootB = path.join(os.tmpdir(), 'component-cache-root-b');
        await previewComponent(python, 'straight', { length: 13 }, undefined, builtinRootA);
        await previewComponent(python, 'straight', { length: 13 }, undefined, builtinRootB);
        assert.equal(spawns, 7, 'builtin cache entries must be isolated by project root');
        await requestComponentThumbnails(python, ['project:thumb'], undefined, customRoot);
        await previewComponent(python, 'project:thumb', {}, undefined, customRoot);
        assert.equal(spawns, 9, 'custom thumbnails must not seed preview cache');
        const aborted = new AbortController();
        aborted.abort();
        await assert.rejects(() => requestComponentThumbnails(python, ['thumb'], aborted.signal), /cancelled/);
        await assert.rejects(() => previewComponent(python, 'straight', { length: 11, width: 2 }, aborted.signal), /cancelled/);
        assert.equal(spawns, 9, 'aborted requests must not spawn or return cached values');
        for (let i = 0; i < 33; i++) await previewComponent(python, 'eviction', { value: i });
        const before = spawns;
        await previewComponent(python, 'eviction', { value: 0 });
        assert.equal(spawns, before + 1, 'oldest entry should be evicted at the entry bound');
        assert(spawnRoots.includes(customRoot), 'custom project root was not forwarded');
        assert(spawnRoots.includes(builtinRootA) && spawnRoots.includes(builtinRootB), 'root-specific cache calls were not forwarded');
        console.log(JSON.stringify({ status: 'passed', spawns, cacheHit: true, canonicalSettings: true, safeCopy: true, boundedEviction: true, projectIsolation: true, abortedThumbnails: true }));
    })().catch(error => { process.nextTick(() => { throw error; }); });
} finally {
    Module._load = originalLoad;
    process.on('exit', () => { try { fs.unlinkSync(bundle); } catch {} });
}
