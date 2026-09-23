const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),Module=require('module'),cp=require('child_process');
const root=path.resolve(__dirname,'../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'gds-provider-handoff-'));
require('esbuild').buildSync({entryPoints:[path.join(root,'src/gdsEditor.ts')],bundle:true,platform:'node',external:['vscode'],outfile:path.join(tmp,'provider.js')});
const original=Module._load;let clipboard='',writes=[],messages=[];
const vscode={window:{createTextEditorDecorationType:()=>({}),showErrorMessage(){},setStatusBarMessage(){}},OverviewRulerLane:{Right:4},env:{clipboard:{writeText:async text=>{await new Promise(r=>setTimeout(r,15));clipboard=text;writes.push(text);},readText:async()=>clipboard}}};
let Provider;
try{Module._load=function(name,...args){if(name==='vscode')return vscode;if(name==='child_process')return {spawn(){throw Error('Unexpected external clipboard/process fallback in test');}};return original.call(this,name,...args);};Provider=require(path.join(tmp,'provider.js')).GdsEditorProvider;}finally{Module._load=original;}
const geometry={type:'Polygon',coordinates:[[[0,0],[10,0],[10,6],[0,6],[0,0]]]};
const target={provId:'target-a',layer:'4/0',bbox:[0,0,10,6],geometry,provenance:{file:'D:/demo/build.py',line:20}};
const values=new Map();const provider=new Provider({workspaceState:{get:k=>values.get(k),update:async(k,v)=>values.set(k,v)}},{},{appendLine(){}});
const entry=(file,hash)=>({gdsPath:file,gdsHash:hash,topCell:'DEMO',loading:false,lastSelection:[],elementCatalog:[target],panel:{webview:{postMessage:async m=>{messages.push(m);return true;}}}});
const a=entry('D:/a/chip.gds','hash-a'),b=entry('D:/b/chip.gds','hash-b');
const decode=text=>JSON.parse(cp.execFileSync('python',['-c','import sys,json,yaml;print(json.dumps(yaml.safe_load(sys.stdin.read())))'],{input:text,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}}));
(async()=>{
 try{
  const drawn={provId:'drawing',drawn:true,geometry,intent:{action:'move',text:'Use this area.',targetIds:['target-a'],snapshot:'hash-a'}};
  await provider.onMessage(a,{type:'exportYaml',layoutHash:'hash-a',components:[drawn],request:{action:'move',text:'Move linked pad.',targetIds:['target-a'],snapshot:'hash-a'}});
  let doc=decode(clipboard);assert.equal(doc.elements.length,0);assert.equal(doc.referenced_elements[0].provenance.line,20);assert.equal(doc.request.text,'Move linked pad.');
  // Quick copies from two tabs must finish in request order, without fallback rewrites.
  await Promise.all([provider.onMessage(a,{type:'exportYaml',layoutHash:'hash-a',components:[target],request:{action:'inspect',text:'Tab A'}}),provider.onMessage(b,{type:'exportYaml',layoutHash:'hash-b',components:[target],request:{action:'inspect',text:'Tab B'}})]);
  assert.equal(decode(writes[1]).document.path,a.gdsPath);assert.equal(decode(writes[2]).document.path,b.gdsPath);assert.equal(decode(clipboard).request.text,'Tab B');
  const before=clipboard;await provider.onMessage(a,{type:'exportYaml',layoutHash:'old',components:[target]});assert.equal(clipboard,before);assert(messages.some(m=>!m.ok&&/changed/i.test(m.error||'')));
  assert(messages.filter(m=>m.type==='copyResult'&&m.ok).every(m=>m.handoff.status==='context_complete'));
  console.log(JSON.stringify({status:'passed',checks:['drawing-only-target-context','direct-request','two-tab-copy-order','stale-copy-preserves-clipboard']}));
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
