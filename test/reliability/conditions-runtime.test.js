const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const root=path.resolve(__dirname,'../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'gds-conditions-')),out=path.join(root,'logs/reliability/conditions');fs.mkdirSync(out,{recursive:true});
for(const name of ['pythonRunner','sidecar'])require('esbuild').buildSync({entryPoints:[path.join(root,'src',name+'.ts')],bundle:true,platform:'node',external:['vscode'],outfile:path.join(tmp,name+'.js')});
const Module=require('module'),old=Module._load;Module._load=function(n,...args){return n==='vscode'?{window:{showErrorMessage(){}}}:old.call(this,n,...args);};
const {runPythonScript}=require(path.join(tmp,'pythonRunner.js'));Module._load=old;
const {deriveScriptFromSidecar}=require(path.join(tmp,'sidecar.js'));
const sandbox={};vm.runInNewContext(fs.readFileSync(path.join(root,'webview/microscope-overlay.js'),'utf8'),sandbox);const overlay=sandbox.MicroscopeOverlay;
const python=process.env.GDS_TEST_PYTHON||path.join(root,'.venv-fork/Scripts/python.exe'),cases=[];
async function check(id,name,fn){try{await fn();cases.push({id,name,status:'passed'});}catch(e){cases.push({id,name,status:'failed',error:String(e.stack)});} }
async function build(id,code,options={}){const dir=path.join(tmp,id);fs.mkdirSync(dir);const script=path.join(dir,'design with spaces.py');fs.writeFileSync(script,code);return runPythonScript(python,script,dir,{show(){},appendLine(){}},{timeoutMs:60000,...options});}
function side(id,entries,files){const dir=path.join(tmp,id);fs.mkdirSync(dir);for(const f of files){fs.mkdirSync(path.dirname(path.join(dir,f)),{recursive:true});fs.writeFileSync(path.join(dir,f),'');}const gds=path.join(dir,'chip.gds');fs.writeFileSync(gds,'');fs.writeFileSync(path.join(dir,'chip.provenance.json'),JSON.stringify({entries}));return {gds,dir};}
const saved={version:1,imageSizePx:[100,80],cx:7,cy:8,umPerPx:.4,rotDeg:2,opacity:.5,visible:false,locked:false,markerTransform:null,markerPose:null,quality:{status:'unverified',boundaryRmsPx:null,markerCount:0},options:{markerAppearance:'yellow',markerLayers:['1/0']}};
(async()=>{
await check('C36','Build script using argparse defaults',async()=>{const r=await build('36','import argparse\nargparse.ArgumentParser().parse_args()\nopen("chip.gds","w").write("ok")');assert.equal(r.ok,true,r.reason);});
await check('C37','Unicode and spaces in output path',async()=>{const r=await build('37','import pathlib\np=pathlib.Path("器件 folder");p.mkdir();(p/"chip.GDS").write_text("ok")');assert.equal(r.ok,true,r.reason);assert.match(r.gdsPath,/器件 folder/);});
await check('C38','Successful script without output',async()=>{const r=await build('38','print("done")');assert.equal(r.ok,false);assert.match(r.reason,/no new/);});
await check('C39','Multiple outputs require choice',async()=>{const r=await build('39','open("a.gds","w").write("a")\nopen("b.gds","w").write("b")');assert.equal(r.ok,false);assert.equal(r.candidates.length,2);});
await check('C40','Failure after writing partial output',async()=>{const r=await build('40','open("partial.gds","w").write("partial")\nraise RuntimeError("intentional")');assert.equal(r.ok,false);assert.equal(r.gdsPath,undefined);});
await check('C41','Already cancelled build never executes',async()=>{const c=new AbortController();c.abort();const r=await build('41','open("side-effect.txt","w").write("bad")',{signal:c.signal});assert.match(r.reason,/cancelled/);assert.equal(fs.existsSync(path.join(tmp,'41','side-effect.txt')),false);});
await check('C42','Missing interpreter returns useful failure',async()=>{const r=await runPythonScript(path.join(tmp,'missing.exe'),'none.py',tmp,{show(){},appendLine(){}});assert.equal(r.ok,false);assert.match(r.reason,/Failed to start/);});
await check('C43','Excessive stderr is bounded',async()=>{const r=await build('43','import sys\nsys.stderr.write("x"*100000)',{maxOutputBytes:100});assert.equal(r.ok,false);assert.match(r.reason,/output exceeded/);});
await check('C44','Relative provenance resolves beside GDS',()=>{const s=side('44',[{file:'scripts/build.py'}],['scripts/build.py']);assert.equal(deriveScriptFromSidecar(s.gds),path.join(s.dir,'scripts/build.py'));});
await check('C45','Missing relative path never substitutes same basename',()=>{const s=side('45',[{file:'missing/build.py'}],['build.py']);assert.equal(deriveScriptFromSidecar(s.gds),undefined);});
await check('C46','Malformed file entry does not hide valid source',()=>{const s=side('46',[{file:42},{file:'build.py'}],['build.py']);assert.equal(deriveScriptFromSidecar(s.gds),path.join(s.dir,'build.py'));});
await check('C47','Equally likely source scripts stay ambiguous',()=>{const s=side('47',[{file:'a.py'},{file:'b.py'}],['a.py','b.py']);assert.equal(deriveScriptFromSidecar(s.gds),undefined);});
await check('C48','Invalid image opacity preserves current placement',()=>{const state={img:{naturalWidth:100,naturalHeight:80},cx:123};const before=JSON.stringify(state);assert.throws(()=>overlay.restore(state,{...saved,opacity:2}));assert.equal(JSON.stringify(state),before);});
await check('C49','Restored image options do not alias saved data',()=>{const payload=JSON.parse(JSON.stringify(saved)),state={img:{naturalWidth:100,naturalHeight:80}};overlay.restore(state,payload);payload.options.markerLayers.push('4/0');assert.equal(state.options.markerLayers.length,1);});
await check('C50','Perspective horizon across image is rejected',()=>{const payload={...saved,markerTransform:[1,0,0,0,1,0,-.02,0,1],markerPose:{cx:0,cy:0,umPerPx:1,rotDeg:0}};assert.equal(overlay.validateSaved(payload,100,80),false);});
const report={status:cases.every(c=>c.status==='passed')?'passed':'failed',cases};fs.writeFileSync(path.join(out,'runtime.json'),JSON.stringify(report,null,2));if(report.status==='failed')fs.writeFileSync(path.join(out,'runtime-failure-'+Date.now()+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exitCode=report.status==='passed'?0:1;
fs.rmSync(tmp,{recursive:true,force:true});
})().catch(e=>{console.error(e);process.exitCode=1;});
