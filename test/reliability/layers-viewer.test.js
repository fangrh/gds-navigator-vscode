#!/usr/bin/env node
'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),http=require('http'),cp=require('child_process'),puppeteer=require('puppeteer-core');
const ROOT=path.resolve(__dirname,'../..');
const BROWSER=[process.env.GDS_BROWSER,'C:/Program Files/Microsoft Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(fs.existsSync);
assert(BROWSER,'Set GDS_BROWSER to an installed browser');
const fixture={type:'FeatureCollection',features:Array.from({length:3000},(_,i)=>({type:'Feature',properties:{element_id:'layer-'+i,layer:i%3+1,data_type:0,color:'#89b4fa',provenance:{source:'fixture'}},geometry:{type:'Polygon',coordinates:[[[i,0],[i+0.5,0],[i+0.5,1],[i,1],[i,0]]]}}))};
async function main(){
 cp.execFileSync(process.execPath,[path.join(ROOT,'scripts/make-standalone.js')],{cwd:ROOT,stdio:'inherit',windowsHide:true});
 const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost').pathname;
  if(url==='/layers.json'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(fixture));}
  const file=path.resolve(ROOT,url.replace(/^\/+/,''));
  if(!file.startsWith(ROOT+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',path.extname(file)==='.html'?'text/html':path.extname(file)==='.js'?'application/javascript':'application/octet-stream');res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await puppeteer.launch({executablePath:BROWSER,headless:true,args:['--no-first-run']});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/webview/test-standalone.html?data=/layers`,{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>allFeatures.length===3000);
  const before=await page.evaluate(()=>{
   window.layerProbe={reads:0,writes:0,finished:0,first:allFeatures[0],geometry:JSON.stringify(allFeatures[0].getGeometry().getCoordinates())};
   allFeatures.forEach(f=>{const get=f.get,set=f.set;f.get=function(k){if(k==='layerKey')layerProbe.reads++;return get.call(this,k);};f.set=function(k,v,...args){if(k==='visible')layerProbe.writes++;return set.call(this,k,v,...args);};});
   replaceSelection([allFeatures[0],allFeatures[1]]);
   layerProbe.oldFinish=finishRouteDraft;finishRouteDraft=()=>layerProbe.finished++;setMode('route');
   return {sizes:Array.from(featuresByLayer.values(),a=>a.length),text:document.querySelector('.legend-row').textContent};
  });
  assert.deepEqual(before.sizes,[1000,1000,1000]);assert(before.text.includes('1000'));
  await page.focus('.legend-row');await page.keyboard.press('Enter');
  const hidden=await page.evaluate(()=>{
   const style=vectorLayer.getStyleFunction();allFeatures[0].set('selected',true);const hiddenStyle=style(allFeatures[0]);allFeatures[0].set('selected',false);
   addToSelection([allFeatures[0]]);
   return {reads:layerProbe.reads,writes:layerProbe.writes,finished:layerProbe.finished,selected:selectedFeatures.getArray().map(f=>f.get('elementId')),hidden:allFeatures[0].get('visible')===false,style:hiddenStyle===hiddenVectorStyle,identity:allFeatures[0]===layerProbe.first,geometry:JSON.stringify(allFeatures[0].getGeometry().getCoordinates())===layerProbe.geometry,checked:document.querySelector('.legend-row').getAttribute('aria-checked')};
  });
  assert.deepEqual(hidden,{reads:0,writes:1000,finished:0,selected:['layer-1'],hidden:true,style:true,identity:true,geometry:true,checked:'false'});
  await page.keyboard.press('Space');
  assert.deepEqual(await page.evaluate(()=>({writes:layerProbe.writes,selected:selectedFeatures.getArray().map(f=>f.get('elementId')),checked:document.querySelector('.legend-row').getAttribute('aria-checked')})),{writes:2000,selected:['layer-1'],checked:'true'});
  await page.evaluate(f=>{finishRouteDraft=layerProbe.oldFinish;setMode('select');loadGdsData(f,'reload.gds','',[],null);}, {type:'FeatureCollection',features:[fixture.features[2]]});
  assert.deepEqual(await page.evaluate(()=>({keys:Array.from(featuresByLayer.keys()),size:featuresByLayer.get('3/0').length,old:Array.from(featuresByLayer.values()).some(a=>a.includes(layerProbe.first)),rows:document.querySelectorAll('.legend-row').length})),{keys:['3/0'],size:1,old:false,rows:1});
  assert.deepEqual(errors,[]);
  const out=path.join(ROOT,'logs/reliability/layers');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({status:'passed',features:3000,layerSize:1000,layerKeyReads:0,visibilityWritesPerToggle:1000,keyboardIsolation:true,hiddenSelectionRemoved:true,reloadCleared:true},null,2));
  console.log('Layer browser reliability passed: 1000 writes, zero layer-key scans for 3000 features');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
