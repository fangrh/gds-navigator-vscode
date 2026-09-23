#!/usr/bin/env node
'use strict';

// Normal-use handoff contract: a user selects layout targets, attaches or
// edits a drawing instruction, and copies the combined request to an agent.
const assert = require('assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
const BROWSER = [process.env.GDS_BROWSER, 'C:/Program Files/Microsoft Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(fs.existsSync);
assert(BROWSER, 'Edge/Chrome required; set GDS_BROWSER');
const TINY = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { element_id: 'target-a', layer: 1, data_type: 0, color: '#f38ba8', bbox: [0, 0, 20, 20], provenance: { file: 'layout.py', line: 10 } }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]] } },
  { type: 'Feature', properties: { element_id: 'target-b', layer: 1, data_type: 0, color: '#89b4fa', bbox: [40, 0, 60, 20], provenance: { file: 'layout.py', line: 11 } }, geometry: { type: 'Polygon', coordinates: [[[40, 0], [60, 0], [60, 20], [40, 20], [40, 0]]] } },
  { type: 'Feature', properties: { element_id: 'target-c', layer: 2, data_type: 0, color: '#a6e3a1', bbox: [80, 0, 100, 20], provenance: { file: 'layout.py', line: 12 } }, geometry: { type: 'Polygon', coordinates: [[[80, 0], [100, 0], [100, 20], [80, 20], [80, 0]]] } }
] };

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const files = { '/tiny.json': null };
      let body, type;
      if (pathname === '/tiny.json') { body = JSON.stringify(TINY); type = 'application/json'; }
      else {
        const file = path.resolve(ROOT, pathname.replace(/^\/+/, ''));
        if (file !== ROOT && !file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
        body = fs.readFileSync(file); type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file).toLowerCase()] || 'application/octet-stream');
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
 childProcess.execFileSync(process.execPath,[path.join(ROOT,'scripts/make-standalone.js')],{cwd:ROOT,stdio:'inherit',windowsHide:true});
 const out=path.join(ROOT,'logs/reliability/primitives-viewer');fs.mkdirSync(out,{recursive:true});
 const {server,port}=await startServer();const browser=await puppeteer.launch({executablePath:BROWSER,headless:true,args:['--no-first-run']});
 try {
  const page=await browser.newPage();await page.setViewport({width:1400,height:950});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/webview/test-standalone.html?data=/tiny`,{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>allFeatures.length===3);
  await page.evaluate(()=>{currentLayoutHash='hash-a';document.getElementById('intent-action').value='move';document.getElementById('intent-text').value='Move an old target';});
  assert.equal(await page.$eval('#draw-toolbar',el=>el.firstElementChild.id),'shape-menu-btn');
  for(const [index,shape] of ['rectangle','circle','line','polygon','taper','straight','pad'].entries()){
   const trigger=index%2?'#shape-menu-btn':'#shape-menu-btn';
   await page.click(trigger);
   assert.equal(await page.$eval('#shape-choices',el=>el.children.length),7);
   assert.equal(await page.$eval('#shape-menu-btn',el=>el.getAttribute('aria-expanded')),'true');
   await page.click('[data-shape='+shape+']');
   if(index<4){assert.equal(await page.evaluate(()=>currentMode),shape);assert.equal(await page.$eval('#primitive-controls',el=>el.hidden),true);}
   else {assert.equal(await page.$eval('#primitive-kind',el=>el.value),shape);assert.equal(await page.$eval('#primitive-parameters',el=>el.hidden),false);}
   await page.keyboard.press('Escape');
   assert.equal(await page.$eval('#primitive-controls',el=>el.hidden),true);
   assert.equal(await page.$eval('#shape-menu-btn',el=>el.getAttribute('aria-expanded')),'false');
  }
  await page.click('#shape-menu-btn');await page.screenshot({path:path.join(out,'shape-menu.png')});await page.keyboard.press('Escape');
  const set=async(id,value)=>page.evaluate(({id,value})=>{const el=document.getElementById(id);el.value=String(value);el.dispatchEvent(new Event('change',{bubbles:true}));},{id,value});
  await page.click('#shape-menu-btn');await page.click('[data-shape=taper]');await set('primitive-length',23.456789);await set('primitive-width1',3.123456);await set('primitive-width2',8.765432);await set('primitive-rotation',-30);await set('primitive-layer','9/2');
  await page.click('#primitive-place');const rect=await page.$eval('#map',el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
  await page.mouse.click(rect.x+rect.width*.6,rect.y+rect.height*.45);
  await page.waitForFunction(()=>drawSource.getFeatures().length===1&&selectedFeatures.getLength()===1);
  await page.click('#copy-btn');
  const inserted=await page.evaluate(()=>window.__sent.filter(m=>m.type==='exportYaml').at(-1));
  const c=inserted.components[0];assert.equal(c.primitive.kind,'taper');assert.equal(c.intent.action,'add');assert.equal(c.layer,'9/2');assert.equal(c.primitive.length,23.456789);assert.equal(c.primitive.rotationDeg,-30);assert.equal(c.geometry.coordinates[0].length,5);
  assert.equal(inserted.request.action,'add');assert.equal(inserted.request.text,'');assert.equal(c.intent.text,'');
  const persisted=await page.evaluate(()=>window.__sent.filter(m=>m.type==='saveAnnotations').at(-1).annotations[0]);
  assert.deepEqual(persisted.primitive,c.primitive);
  const roundtrip=await page.evaluate(a=>exactGeometry(featureFromSavedAnnotation(a)),persisted);assert.deepEqual(roundtrip,c.geometry);
  await page.evaluate(()=>{drawSource.getFeatures()[0].getGeometry().translate(5,-7);persistAnnotations();copyYAML();});
  const moved=await page.evaluate(()=>window.__sent.filter(m=>m.type==='exportYaml').at(-1).components[0]);
  assert(Math.abs(moved.geometry.coordinates[0][0][0]-c.geometry.coordinates[0][0][0]-5)<1e-10);
  await page.evaluate(()=>{const f=drawSource.getFeatures()[0],g=f.getGeometry(),pts=g.getCoordinates();pts[0][1][1]+=2;g.setCoordinates(pts);persistAnnotations();copyYAML();});
  const edited=await page.evaluate(()=>window.__sent.filter(m=>m.type==='exportYaml').at(-1).components[0]);assert.notDeepEqual(edited.geometry,moved.geometry);
  for(const kind of ['straight','pad']){await page.click('#shape-menu-btn');await page.click('[data-shape=taper]');await page.select('#primitive-kind',kind);await page.click('#primitive-center');}
  assert.deepEqual(await page.evaluate(()=>drawSource.getFeatures().map(f=>f.get('primitive').kind)),['taper','straight','pad']);
  await page.click('#shape-menu-btn');await page.click('[data-shape=taper]');await set('primitive-length',-1);await page.click('#primitive-center');assert.equal(await page.evaluate(()=>drawSource.getFeatures().length),3);assert(await page.$eval('#primitive-error',el=>!!el.textContent));
  await set('primitive-length',20);await set('primitive-layer','bad');await page.click('#primitive-place');assert.equal(await page.evaluate(()=>currentMode),'select');
  await set('primitive-layer','4/0');await page.click('#primitive-place');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>currentMode),'select');assert.equal(await page.evaluate(()=>drawSource.getFeatures().length),3);
  assert.deepEqual(errors,[]);
  await page.click('#shape-menu-btn');await page.click('[data-shape=taper]');await page.screenshot({path:path.join(out,'component-tools.png')});
  fs.writeFileSync(path.join(out,'copy-payload.json'),JSON.stringify(inserted,null,2));fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({status:'passed',components:3,pointerPlacement:true,precision:true,copy:true,restore:true,editedGeometry:true,invalidInputs:true,cancel:true},null,2));
  console.log('Primitive browser insertion, exact copy, restore, edit and rejection tests passed');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
