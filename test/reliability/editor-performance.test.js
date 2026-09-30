'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),http=require('http'),cp=require('child_process'),puppeteer=require('puppeteer-core');
const root=path.resolve(__dirname,'../..');
const executablePath=[process.env.GDS_BROWSER,'C:/Program Files/Microsoft Edge/Application/msedge.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(fs.existsSync);
async function main(){
 cp.execFileSync(process.execPath,['scripts/make-standalone.js'],{cwd:root,stdio:'ignore',windowsHide:true});
 const server=http.createServer((req,res)=>{const f=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!f.startsWith(root+path.sep)||!fs.existsSync(f)){res.writeHead(404);return res.end();}res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await puppeteer.launch({executablePath,headless:true});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/webview/test-standalone.html?data=/test/fixtures/real_geojson`,{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>window.__viewerReady&&allFeatures.length>0);
  const report=await page.evaluate(()=>{
   const template=gdsGeoJsonFmt.writeGeometryObject(allFeatures[0].getGeometry());
   const geojson={type:'FeatureCollection',features:Array.from({length:3000},(_,i)=>({type:'Feature',geometry:template,properties:{layer:1,data_type:0,color:'#abcdef',element_id:'perf-'+i}}))};
   let batchedChanges=0;const onChange=()=>batchedChanges++;source.on('change',onChange);
   loadGdsData(geojson,'performance.gds','',[],'partial');source.un('change',onChange);
   const loadedCount=source.getFeatures().length;
   const legacy=new ol.source.Vector();let legacyChanges=0;const legacyOnChange=()=>legacyChanges++;legacy.on('change',legacyOnChange);allFeatures.forEach(f=>legacy.addFeature(f));legacy.un('change',legacyOnChange);
   let includesCalls=0;const selected=selectedFeatures.getArray(),originalIncludes=selected.includes;selected.includes=function(){includesCalls++;return originalIncludes.apply(this,arguments);};
   addToSelection(allFeatures);addToSelection(allFeatures);
   delete selected.includes;
   const count=selectedFeatures.getLength(),allMarked=allFeatures.every(f=>f.get('selected'));
   const geometryPreserved=JSON.stringify(gdsGeoJsonFmt.writeGeometryObject(allFeatures[0].getGeometry()))===JSON.stringify(template);
   replaceSelection([]);
   const drawings=Array.from({length:100},(_,i)=>featureFromSavedAnnotation({id:'delete-'+i,shapeType:'Polygon',geometry:template,intent:{}}));
   drawSource.addFeatures(drawings);replaceSelection(drawings);
   const savesBefore=__sent.filter(m=>m.type==='saveAnnotations').length;deleteDrawn();
   const saves=__sent.filter(m=>m.type==='saveAnnotations').slice(savesBefore);
   return {status:'passed',features:3000,loadedCount,sourceChangeEvents:{legacy:legacyChanges,batched:batchedChanges},selection:{count,allMarked,linearArrayIncludes:includesCalls},geometryPreserved,deletion:{drawings:100,saves:saves.length,remaining:saves.at(-1).annotations.length}};
  });
  assert.equal(report.loadedCount,3000);assert.equal(report.selection.count,3000);assert(report.selection.allMarked);assert.equal(report.selection.linearArrayIncludes,0);assert(report.geometryPreserved);assert(report.sourceChangeEvents.batched<report.sourceChangeEvents.legacy/100);assert.equal(report.deletion.saves,1);assert.equal(report.deletion.remaining,0);assert.deepEqual(errors,[]);
  fs.mkdirSync(path.join(root,'logs/performance'),{recursive:true});fs.writeFileSync(path.join(root,'logs/performance/editor.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
