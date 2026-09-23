const assert=require('assert/strict'),fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto'),os=require('os');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'logs/reliability/handoff-demo');fs.mkdirSync(out,{recursive:true});
const python=process.env.GDS_TEST_PYTHON||path.join(root,'.venv-fork/Scripts/python.exe');
const script=path.join(root,'test/examples/ai-handoff/layout.py'),gds=path.join(out,'layout.gds');
cp.execFileSync(python,[script,'--out',gds],{encoding:'utf8',timeout:60000,windowsHide:true});
const parsed=JSON.parse(cp.execFileSync(python,[path.join(root,'python/parse_gds.py'),gds],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024,windowsHide:true}));
const pads=parsed.features.filter(f=>f.properties.layer===4);assert.equal(pads.length,6);
for(let r=0;r<2;r++)for(let c=0;c<3;c++){
 const f=pads.find(f=>f.properties.provenance.instance_name===`pad_r${r}_c${c}`);assert(f);
 assert.deepEqual(f.properties.provenance.loop_index,[r,c]);assert.deepEqual(f.properties.bbox,[c*30,r*24,c*30+10,r*24+6]);
 assert.equal(path.resolve(f.properties.provenance.file).toLowerCase(),script.toLowerCase());
}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'gds-demo-export-'));
try{
 require('esbuild').buildSync({entryPoints:[path.join(root,'src/selectionExport.ts')],bundle:true,platform:'node',outfile:path.join(tmp,'export.js')});
 const {elementId,selectionDocument,toYaml}=require(path.join(tmp,'export.js'));
 const catalog=parsed.features.map((f,i)=>({provId:elementId(f,i),layer:f.properties.layer+'/'+f.properties.data_type,bbox:f.properties.bbox,geometry:f.geometry,provenance:f.properties.provenance}));
 const pad=catalog.find(c=>c.provenance.instance_name==='pad_r1_c2');
 const hash=crypto.createHash('sha256').update(fs.readFileSync(gds)).digest('hex');
 const doc=selectionDocument(gds,hash,[pad],parsed.top_cell,{catalog,request:{action:'move',text:'Move only pad_r1_c2 +3 um in x, 0 um in y. Preserve the other five pads.',targetIds:[pad.provId],snapshot:hash}});
 fs.writeFileSync(path.join(out,'selected-instance.yaml'),toYaml(doc)+'\n');
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({status:'passed',features:parsed.features.length,pads:6,selectedInstance:'pad_r1_c2',indices:pad.provenance.loop_index,gds,sha256:hash},null,2));
 console.log(JSON.stringify({status:'passed',features:parsed.features.length,loopInstances:pads.length,example:path.join(out,'selected-instance.yaml')}));
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
