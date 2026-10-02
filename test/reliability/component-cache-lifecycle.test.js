'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { buildSync } = require('esbuild');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'gds-cache-lifecycle-'));
fs.mkdirSync(path.join(temp,'dist'));fs.mkdirSync(path.join(temp,'python'));
const script=path.join(temp,'python/component_catalog.py');fs.writeFileSync(script,'# mock bridge\n');
const bundle=path.join(temp,'dist/catalog.cjs');
buildSync({entryPoints:[path.resolve(__dirname,'../../src/componentCatalog.ts')],bundle:true,platform:'node',outfile:bundle});
const jobs=[],originalLoad=Module._load;
Module._load=function(name,parent,isMain){const real=originalLoad.call(this,name,parent,isMain);if(name!=='child_process')return real;return {...real,spawn(python,args){const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.kill=()=>{p.killed=true;};jobs.push({p,args});return p;}};};
const api=require(bundle);Module._load=originalLoad;
function complete(index,id){const job=jobs[index];const value=job.args[1]==='--catalog'?{components:[{name:id,parameters:[]}],environment:{id}}:{name:'straight',settings:{length:4},ports:[],geojson:{type:'FeatureCollection',features:[]},id};job.p.stdout.emit('data',Buffer.from(JSON.stringify(value)));job.p.emit('close',0);}

async function main(){
    const python=process.execPath;
    const first=api.loadComponentCatalog(python);assert.equal(jobs.length,1);complete(0,'normal');await first;
    assert.equal((await api.loadComponentCatalog(python)).environment.id,'normal');assert.equal(jobs.length,1,'first normal request did not seed cache');
    const aborted=new AbortController();aborted.abort();await assert.rejects(api.loadComponentCatalog(python,aborted.signal),/cancelled/);assert.equal(jobs.length,1);
    const refresh=api.loadComponentCatalog(python,undefined,undefined,true),peer=api.loadComponentCatalog(python);assert.equal(jobs.length,2,'normal caller reused stale completed cache during refresh');complete(1,'refresh');assert.equal((await peer).environment.id,'refresh');await refresh;
    const oldAbort=new AbortController();const superseded=api.loadComponentCatalog(python,oldAbort.signal,undefined,true);const current=api.loadComponentCatalog(python,undefined,undefined,true);assert.equal(jobs.length,4);oldAbort.abort();await assert.rejects(superseded,/cancelled/);assert(jobs[2].p.killed,'replaced abandoned child remained alive');assert(!jobs[3].p.killed);complete(3,'current');await current;
    const older=api.loadComponentCatalog(python,undefined,undefined,true);const olderIndex=jobs.length-1;
    for(let i=0;i<12;i++){const root=path.join(temp,'root-'+i);fs.mkdirSync(root);const pending=api.loadComponentCatalog(python,undefined,root);complete(jobs.length-1,'other-'+i);await pending;}
    const latest=api.loadComponentCatalog(python,undefined,undefined,true);complete(jobs.length-1,'latest');await latest;complete(olderIndex,'older');await older;
    assert.equal((await api.loadComponentCatalog(python)).environment.id,'latest','older completion overwrote fresh cache after eviction');
    const previewOld=api.previewComponent(python,'straight',{length:4});const oldIndex=jobs.length-1;
    fs.appendFileSync(script,'# changed\n');const previewNew=api.previewComponent(python,'straight',{length:4});const newIndex=jobs.length-1;assert(newIndex>oldIndex,'changed bridge joined old in-flight preview');complete(newIndex,'new-preview');await previewNew;complete(oldIndex,'old-preview');await previewOld;
    assert.equal((await api.previewComponent(python,'straight',{length:4})).id,'new-preview','old bridge output repopulated current preview cache');
    const thumbnail=api.requestComponentThumbnails(python,['straight']);const thumbIndex=jobs.length-1;
    const catalogRefresh=api.loadComponentCatalog(python,undefined,undefined,true);const refreshIndex=jobs.length-1;
    complete(refreshIndex,'thumbnail-refresh');await catalogRefresh;
    const staleThumb={items:[{name:'straight',settings:{length:4},ports:[],geojson:{features:[{id:'stale-thumb'}]}}]};jobs[thumbIndex].p.stdout.emit('data',Buffer.from(JSON.stringify(staleThumb)));jobs[thumbIndex].p.emit('close',0);await thumbnail;
    const unseeded=api.previewComponent(python,'straight',{length:4});const cleanIndex=jobs.length-1;assert(cleanIndex>refreshIndex,'late thumbnail repopulated the refreshed preview cache');complete(cleanIndex,'clean-preview');assert.equal((await unseeded).id,'clean-preview');
    const missingRoot=path.join(temp,'formerly-missing');const missing=api.loadComponentCatalog(python,undefined,missingRoot);complete(jobs.length-1,'missing');await missing;fs.mkdirSync(missingRoot);
    const created=api.loadComponentCatalog(python,undefined,missingRoot);const count=jobs.length;complete(count-1,'created');assert.equal((await created).environment.id,'created','missing root warning survived creation');
    assert.equal((await api.loadComponentCatalog(python,undefined,missingRoot)).environment.id,'created');assert.equal(jobs.length,count);
    console.log(JSON.stringify({status:'passed',jobs:jobs.length,normalCache:true,abortBeforeCache:true,forcedRefreshSharing:true,supersededCancellation:true,lateCompletion:true,scriptContext:true,rootCreation:true}));
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
