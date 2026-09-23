#!/usr/bin/env node
'use strict';
// Evaluate a seeded image corpus against its independent generating transform.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),puppeteer=require('puppeteer-core');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'logs/numbered-markers/random100');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const inverse=a=>{const b=[a[4]*a[8]-a[5]*a[7],a[2]*a[7]-a[1]*a[8],a[1]*a[5]-a[2]*a[4],a[5]*a[6]-a[3]*a[8],a[0]*a[8]-a[2]*a[6],a[2]*a[3]-a[0]*a[5],a[3]*a[7]-a[4]*a[6],a[1]*a[6]-a[0]*a[7],a[0]*a[4]-a[1]*a[3]],d=a[0]*b[0]+a[1]*b[3]+a[2]*b[6];return b.map(x=>x/d);};
const project=(h,p)=>{const z=h[6]*p[0]+h[7]*p[1]+h[8];return [(h[0]*p[0]+h[1]*p[1]+h[2])/z,(h[3]*p[0]+h[4]*p[1]+h[5])/z];};
async function main(){
 const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
 if(manifest.cases.length!==100)throw Error('Expected exactly 100 generated images');
 const fixture=path.join(root,'test/fixtures/jj_pad_center_50_geo.json'),solver=path.join(root,'webview/numbered-marker-alignment.js');
 const features=JSON.parse(fs.readFileSync(fixture,'utf8')).features;
 const browserPath=process.env.GDS_BROWSER||['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(fs.existsSync);
 if(!browserPath)throw Error('Edge/Chrome required; set GDS_BROWSER');
 const report={status:'running',startedAt:new Date().toISOString(),solverSha256:hash(solver),fixtureSha256:hash(fixture),manifestSha256:hash(path.join(out,'manifest.json')),gates:{boundaryRmsPx:2,perMarkerRmsPx:4,groundTruthRmsPx:2,groundTruthMaxPx:4},cases:[]};
 const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));save();
 const browser=await puppeteer.launch({executablePath:browserPath,headless:true,protocolTimeout:120000});
 try{
  const page=await browser.newPage();await page.addScriptTag({path:solver});
  for(const spec of manifest.cases){
   const imagePath=path.resolve(out,spec.image),url='data:image/png;base64,'+fs.readFileSync(imagePath).toString('base64'),started=Date.now();
   const result=await page.evaluate(async({url,features})=>{const image=new Image();image.src=url;await image.decode();return NumberedMarkerAlignment.align({image,features});},{url,features});
   const entry={id:spec.id,severity:spec.severity,expected:spec.expected,image:imagePath,imageSha256:hash(imagePath),elapsedMs:Date.now()-started,result};
   if(result.status==='aligned'){
    const inv=inverse(result.transform),probes=[[160,160],[360,160],[560,160],[160,360],[360,360],[560,360],[160,560],[360,560],[560,560]];
    const errors=probes.map(p=>{const q=project(inv,project(spec.transform,p));return Math.hypot(q[0]-p[0],q[1]-p[1]);});
    entry.groundTruthRmsPx=Math.sqrt(errors.reduce((s,e)=>s+e*e,0)/errors.length);entry.groundTruthMaxPx=Math.max(...errors);
    const labelCenters={'0,0':[-200,-200],'1,0':[0,-200],'0,-1':[-200,-400],'1,-1':[0,-400]};
    const validLabels=new Set(Object.keys(labelCenters));
    const markers=result.markers||[];
    const correct=markers.length>=3&&new Set(markers.map(m=>m.label)).size===markers.length&&markers.every(m=>validLabels.has(m.label)&&m.boundaryRmsPx<=4&&Math.hypot(m.layoutCenter[0]-labelCenters[m.label][0],m.layoutCenter[1]-labelCenters[m.label][1])<.01)&&result.boundaryRmsPx<=2&&result.validationBoundaryRmsPx<=2&&entry.groundTruthRmsPx<=2&&entry.groundTruthMaxPx<=4;
    entry.outcome=spec.expected==='reject'||!correct?'false_accept':'accurate_alignment';
   }else entry.outcome=spec.expected==='align'?'unexpected_rejection':spec.expected==='reject'?'correct_rejection':'challenge_rejection';
   report.cases.push(entry);save();
   if(report.cases.length%5===0)console.log(JSON.stringify({completed:report.cases.length,total:100,last:entry.id,outcome:entry.outcome}));
  }
  report.summary={};for(const c of report.cases){const s=report.summary[c.severity]||{total:0,accurate_alignment:0,correct_rejection:0,challenge_rejection:0,unexpected_rejection:0,false_accept:0};s.total++;s[c.outcome]++;report.summary[c.severity]=s;}
  report.status=report.cases.some(c=>['false_accept','unexpected_rejection'].includes(c.outcome))?'failed':'passed';report.finishedAt=new Date().toISOString();save();
  fs.writeFileSync(path.join(out,'report-'+Date.now()+'.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:report.status,summary:report.summary,report:path.join(out,'report.json')}));process.exitCode=report.status==='passed'?0:1;
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
