const assert = require('assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '../..');
const bundle = path.join(os.tmpdir(), `gds-component-concurrency-${process.pid}.cjs`);
const jobs = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request !== 'child_process') return originalLoad.call(this, request, parent, isMain);
    const childProcess = originalLoad.call(this, request, parent, isMain);
    return {
        ...childProcess,
        spawn(python, args) {
            const proc = new EventEmitter();
            proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.killed = false;
            proc.kill = () => { proc.killed = true; };
            jobs.push({ proc, args, python });
            return proc;
        },
    };
};

function catalogPayload(id) { return { components: [{ name: `shape-${id}`, description: '', parameters: [] }], environment: { id } }; }
function finish(job, value = catalogPayload(jobs.indexOf(job)), code = 0) {
    job.proc.stdout.emit('data', Buffer.from(JSON.stringify(value)));
    job.proc.emit('close', code);
}
function fail(job) { job.proc.stderr.emit('data', Buffer.from('temporary failure')); job.proc.emit('close', 1); }
function waitForJobs(count, timeoutMs = 5000) { return new Promise((resolve, reject) => { const started = Date.now(); const check = () => { if (jobs.length >= count) return resolve(); if (Date.now() - started >= timeoutMs) return reject(new Error(`timed out waiting for ${count} jobs (saw ${jobs.length})`)); setImmediate(check); }; check(); }); }

try {
    require('esbuild').buildSync({ entryPoints: [path.join(root, 'src', 'componentCatalog.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
    const { loadComponentCatalog } = require(bundle);
    const python = process.execPath;
    (async () => {
        const first = loadComponentCatalog(python), second = loadComponentCatalog(python);
        await waitForJobs(1); assert.equal(jobs.length, 1, 'concurrent catalog misses should share one child');
        finish(jobs[0], catalogPayload('shared'));
        const [a, b] = await Promise.all([first, second]);
        a.components[0].name = 'mutated'; assert.equal(b.components[0].name, 'shape-shared', 'catalog consumers must receive cloned results');

        const old = loadComponentCatalog(python, undefined, undefined, true); await waitForJobs(2);
        const fresh = loadComponentCatalog(python, undefined, undefined, true); await waitForJobs(3);
        finish(jobs[2], catalogPayload('fresh')); finish(jobs[1], catalogPayload('old')); await Promise.all([old, fresh]);
        const cached = await loadComponentCatalog(python); assert.equal(cached.environment.id, 'fresh', 'older forced completion overwrote fresh cache'); assert.equal(jobs.length, 3, 'fresh forced result was not cached');

        const abortRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-component-abort-')); const survivorAbort = new AbortController(), survivor = loadComponentCatalog(python, survivorAbort.signal, abortRoot); const survivorPeer = loadComponentCatalog(python, undefined, abortRoot); await waitForJobs(4); survivorAbort.abort(); await assert.rejects(survivor, /cancelled/); assert.equal(jobs[3].proc.killed, false, 'one subscriber abort killed shared child'); finish(jobs[3], catalogPayload('survivor')); await survivorPeer;
        const allAbort = new AbortController(); const canceled = loadComponentCatalog(python, allAbort.signal, abortRoot, true); await waitForJobs(5); allAbort.abort(); await assert.rejects(canceled, /cancelled/); assert.equal(jobs[4].proc.killed, true, 'last subscriber abort did not kill child');
        const retry = loadComponentCatalog(python, undefined, undefined, true); await waitForJobs(6); finish(jobs[5], catalogPayload('retry')); await retry;

        const failed = loadComponentCatalog(python, undefined, undefined, true); await waitForJobs(7); fail(jobs[6]); await assert.rejects(failed, /component catalog failed|temporary failure/);
        const afterFailure = loadComponentCatalog(python, undefined, undefined, true); await waitForJobs(8); finish(jobs[7], catalogPayload('after-failure')); await afterFailure;

        const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-component-registry-'));
        const registry = path.join(registryRoot, 'gds_components.py'); fs.writeFileSync(registry, 'COMPONENTS = {}\n');
        const projectA = loadComponentCatalog(python, undefined, registryRoot), projectB = loadComponentCatalog(python, undefined, registryRoot); await waitForJobs(10); assert.equal(jobs.length, 10, 'registry-backed catalog calls must not share'); finish(jobs[8], catalogPayload('project-a')); finish(jobs[9], catalogPayload('project-b')); await Promise.all([projectA, projectB]);
        fs.unlinkSync(registry);
        const changing = loadComponentCatalog(python, undefined, registryRoot); await waitForJobs(11); fs.writeFileSync(registry, 'COMPONENTS = {}\n'); finish(jobs[10], catalogPayload('registry-added')); await changing;
        fs.unlinkSync(registry); const afterRegistry = loadComponentCatalog(python, undefined, registryRoot); await waitForJobs(12); assert.equal(jobs.length, 12, 'registry appearance during run must prevent stale cache'); finish(jobs[11], catalogPayload('after-registry')); await afterRegistry;
        fs.rmSync(registryRoot, { recursive: true, force: true }); fs.rmSync(abortRoot, { recursive: true, force: true });
        console.log(JSON.stringify({ status: 'passed', jobs: jobs.length, sharedCatalog: true, forcedFresh: true, cancellationIsolation: true, failureRetry: true, registryBypass: true }));
    })().catch(error => { process.nextTick(() => { throw error; }); });
} finally {
    Module._load = originalLoad;
    process.on('exit', () => { try { fs.unlinkSync(bundle); } catch {} });
}
