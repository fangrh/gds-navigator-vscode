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
  const initial=await page.evaluate(()=>{
   const geometry=gdsGeoJsonFmt.writeGeometryObject(allFeatures[0].getGeometry());
   const center=[40,20];
   const geojson={type:'FeatureCollection',features:[{type:'Feature',geometry,properties:{layer:1,data_type:0,color:'#abcdef',element_id:'shape-1'}}],ports:[{id:'port-1',name:'optical_in',center,width:0.5,orientation:90,layer:[1,0],coordinate_frame:'layout',provenance:{cell:'TOP'}}]};
   loadGdsData(geojson,'ports.gds','',[],'partial');
   map.getView().setCenter(center);map.getView().setResolution(1);map.updateSize();map.renderSync();
   return {count:portSource.getFeatures().length,marker:portFeatureById.get('port-1')?.get('port'),pixel:map.getPixelFromCoordinate(center),rect:map.getTargetElement().getBoundingClientRect().toJSON()};
  });
  assert.equal(initial.count,1);assert.equal(initial.marker.name,'optical_in');
  await page.mouse.click(initial.rect.x+initial.pixel[0],initial.rect.y+initial.pixel[1]);
  await page.waitForFunction(()=>selectedFeatures.getArray().some(f=>f.get('port')?.id==='port-1'));
  const selected=await page.evaluate(()=>({port:selectedFeatures.getArray().find(f=>f.get('port'))?.get('port'),message:__sent.filter(m=>m.type==='selectComponents').at(-1)}));
  assert.equal(selected.port.id,'port-1');assert.equal(selected.message.components[0].port.name,'optical_in');
  await page.evaluate(()=>{const e=document.getElementById('port-names-visible');e.click();});
  assert.equal(await page.evaluate(()=>portNamesVisible),false);
  await page.evaluate(()=>{document.getElementById('ports-visible').click();});
  assert.deepEqual(await page.evaluate(()=>({visible:portLayer.getVisible(),selected:selectedFeatures.getArray().some(f=>f.get('port'))})),{visible:false,selected:false});
  await page.mouse.click(initial.rect.x+initial.pixel[0],initial.rect.y+initial.pixel[1]);
  assert.equal(await page.evaluate(()=>selectedFeatures.getArray().some(f=>f.get('port'))),false);
  await page.evaluate(()=>loadGdsData({type:'FeatureCollection',features:[]},'other.gds','',[],'partial'));
  assert.equal(await page.evaluate(()=>portSource.getFeatures().length),0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'passed',selectedPort:selected.port.id,hiddenPortsUnselectable:true,reloadClearsPorts:true}));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
