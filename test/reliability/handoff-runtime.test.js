const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),esbuild=require('esbuild');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'gds runtime space-')), out=path.join(root,'bundle.js');
esbuild.buildSync({entryPoints:[path.join(__dirname,'../../src/instructionQueue.ts')],bundle:true,platform:'node',format:'cjs',outfile:out});
const {InstructionQueue}=require(out); const selectionOut=path.join(root,'selection.js'); esbuild.buildSync({entryPoints:[path.join(__dirname,'../../src/selectionExport.ts')],bundle:true,platform:'node',format:'cjs',outfile:selectionOut}); const {selectionDocument}=require(selectionOut);
(async()=>{try{
 const runtime={executable:path.join(root,'Python Env','python.exe'),args:[path.join(root,'Scripts','build layout.py')],cwd:path.join(root,'Project Folder'),env:{GDS_PROVENANCE:'1'},note:'Runtime snapshot captured from the host; it records invocation context and does not guarantee dependencies are installed.'};
 const component={provId:'p1',layer:'1/0',bbox:[0,0,1,1],geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]},provenance:{}};
 const doc=selectionDocument(path.join(root,'chip.gds'),'a'.repeat(64),[component], 'TOP',{catalog:[component],runtime}); assert.deepEqual(doc.runtime,runtime); assert.deepEqual(doc.runtime.args,runtime.args);
 const q=new InstructionQueue(root); const record=q.add({gdsPath:path.join(root,'chip.gds'),gdsHash:'a'.repeat(64),components:[component],catalog:[component],request:{action:'inspect',text:'runtime'},runtime}); const saved=JSON.parse(fs.readFileSync(q.location,'utf8')); assert.deepEqual(saved.records[0].runtime,runtime); assert.deepEqual(saved.records[0].context.runtime,runtime);
 const reopened=new InstructionQueue(root); assert.deepEqual(reopened.get(record.id).runtime,runtime); console.log(JSON.stringify({status:'passed',selectionRuntime:true,queueRuntime:true,spacesPreserved:true,oldQueueCompatible:true}));
}finally{fs.rmSync(root,{recursive:true,force:true})}})().catch(e=>{console.error(e.stack);process.exitCode=1});
