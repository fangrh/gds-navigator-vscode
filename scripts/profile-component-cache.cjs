'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const ROOT = path.resolve(__dirname, '..');
const python = process.env.GDS_PYTHON;
assert(python && fs.existsSync(python), 'Set GDS_PYTHON to Python with gdsfactory');
const before = path.resolve(process.argv[2] || path.join(ROOT, 'logs/next-performance/before/componentCatalog.ts'));
assert(fs.existsSync(before), 'Save the original componentCatalog.ts before comparison');
const out = path.resolve(process.env.GDS_COMPONENT_PROFILE_OUT || path.join(ROOT, 'logs/next-performance/components'));
fs.mkdirSync(out, { recursive: true });
const current = path.join(ROOT, 'src/componentCatalog.ts');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];

async function main() {
    let canonical;
    const samples = [];
    for (const [index, variant] of ['before','after','after','before'].entries()) {
        const source = variant === 'before' ? before : current;
        const bundle = path.join(out, `${index}-${variant}.cjs`);
        buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
        let spawns = 0;
        const original = Module._load;
        Module._load = function (name,parent,isMain) {
            const value = original.call(this,name,parent,isMain);
            if (name !== 'child_process') return value;
            return {...value,spawn(...args){spawns++;return value.spawn(...args);}};
        };
        let api;
        try { api = require(bundle); } finally { Module._load = original; }
        const times = [];
        for (let repeat=0;repeat<4;repeat++) {
            const start=performance.now();const value=await api.loadComponentCatalog(python);times.push(performance.now()-start);
            const encoded=JSON.stringify(value);
            if(canonical)assert.equal(encoded,canonical,'catalog metadata changed');else canonical=encoded;
        }
        samples.push({variant,coldMs:times[0],repeatMs:times.slice(1),pythonChildren:spawns});
    }
    const summarize=variant=>{const rows=samples.filter(s=>s.variant===variant);return{coldMedianMs:median(rows.map(s=>s.coldMs)),repeatMedianMs:median(rows.flatMap(s=>s.repeatMs)),pythonChildren:rows.map(s=>s.pythonChildren)};};
    const report={status:'passed',at:new Date().toISOString(),order:samples.map(s=>s.variant),python,beforeSha256:hash(before),afterSha256:hash(current),catalogSha256:crypto.createHash('sha256').update(canonical).digest('hex'),samples,before:summarize('before'),after:summarize('after'),limits:'Real local gdsfactory subprocesses; builtin catalog with no project registry. Fresh module cache per alternating run. Repeated calls use a bounded 30-second cache; cold Python startup is not accelerated. Catalog JSON is identical. Project registry requests bypass this cache.'};
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({report:path.join(out,'report.json'),before:report.before,after:report.after},null,2));
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
