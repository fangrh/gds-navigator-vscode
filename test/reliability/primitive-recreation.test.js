const assert=require('assert/strict'),fs=require('fs'),path=require('path'),cp=require('child_process'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'logs/reliability/primitive-recreation');fs.mkdirSync(out,{recursive:true});
esbuild.buildSync({entryPoints:[path.join(root,'src/selectionExport.ts')],bundle:true,platform:'node',outfile:path.join(out,'export.cjs')});
const {selectionDocument,toYaml}=require(path.join(out,'export.cjs')),P=require('../../webview/layout-primitives.js');
const components=['taper','straight','pad'].map((kind,i)=>{const spec={...P.defaults(kind),length:25.123456,width1:3.75,width2:kind==='taper'?12.5:3.75,layer:[17+i,2],origin:[-32.5+i*50,11.75],rotationDeg:[-35,90,27][i]};return {provId:'proposal-'+i,drawn:true,layer:spec.layer.join('/'),primitive:spec,geometry:P.geometry(spec),intent:{action:'add',text:'Create this geometry',targetIds:[]}};});
const doc=selectionDocument('example.gds','example-hash',components,'TOP');assert.equal(doc.handoff.status,'context_complete');
fs.writeFileSync(path.join(out,'proposals.yaml'),toYaml(doc));
const python=process.env.GDS_TEST_PYTHON||path.join(root,'.venv-fork/Scripts/python.exe'),gds=path.join(out,'recreated.gds');
const script=`import json,sys\nimport gdsfactory as gf\ngf.gpdk.PDK.activate()\ndoc=json.load(sys.stdin)\nc=gf.Component('recreated_proposals')\nfor a in doc['annotations']:\n r=a['construction_recipe']\n assert r['operation']=='Component.add_polygon'\n c.add_polygon(points=r['points'],layer=tuple(r['layer']))\nc.write_gds(sys.argv[1])\n`;
fs.writeFileSync(path.join(out,'recreate.py'),script);
cp.execFileSync(python,[path.join(out,'recreate.py'),gds],{input:JSON.stringify(doc),encoding:'utf8',windowsHide:true,timeout:60000});
const parsed=JSON.parse(cp.execFileSync(python,[path.join(root,'python/parse_gds.py'),gds],{encoding:'utf8',windowsHide:true,timeout:60000}));
for(const a of doc.annotations){const recipe=a.construction_recipe;const f=parsed.features.find(f=>f.properties.layer===recipe.layer[0]&&f.properties.data_type===recipe.layer[1]);assert(f,'constructed layer missing');const actual=f.geometry.coordinates[0];for(const p of recipe.points)assert(actual.some(q=>Math.hypot(p[0]-q[0],p[1]-q[1])<=.002),'recreated vertex differs beyond GDS quantization');}
const report={status:'passed',components:3,reconstructedFrom:'exported construction recipes only',vertexToleranceUm:.002,gds};fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
