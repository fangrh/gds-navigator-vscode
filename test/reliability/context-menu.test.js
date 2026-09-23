#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '../..');
const BROWSER = [process.env.GDS_BROWSER, 'C:/Program Files/Microsoft Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(fs.existsSync);
assert(BROWSER, 'Edge/Chrome required; set GDS_BROWSER');
const TINY = { type: 'FeatureCollection', features: [
  ['target-a', 1, 0, 0, 18, 18], ['target-b', 2, 24, 0, 12, 10], ['target-c', 3, -20, 0, 8, 14]
].map(([element_id, layer, x, y, w, h]) => ({ type: 'Feature', properties: { element_id, layer, data_type: 0, color: '#89b4fa' }, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]] } })) };
function startServer() { return new Promise(resolve => { const server = http.createServer((req, res) => { const p = new URL(req.url, 'http://127.0.0.1').pathname; let body, type; if (p === '/tiny.json') { body = JSON.stringify(TINY); type = 'application/json'; } else { const file = path.resolve(ROOT, p.replace(/^\/+/, '')); if ((file !== ROOT && !file.startsWith(ROOT + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); } body = fs.readFileSync(file); type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file).toLowerCase()] || 'application/octet-stream'); } res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); }); server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })); }); }
async function main() {
  cp.execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-standalone.js')], {cwd: ROOT, stdio:'inherit', windowsHide:true});
  const out=path.join(ROOT,'logs/reliability/context-menu');fs.mkdirSync(out,{recursive:true});
  const {server,port}=await startServer();const browser=await puppeteer.launch({executablePath:BROWSER,headless:true,args:['--no-first-run']});
  let page;
  try {
    page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.setViewport({width:1400,height:900});await page.goto(`http://127.0.0.1:${port}/webview/test-standalone.html?data=/tiny`,{waitUntil:'networkidle0'});await page.waitForFunction(()=>allFeatures.length===3);
    const menu='#canvas-context-menu';const button=id=>`${menu} [data-action="${id}"]`;
    const visible=()=>page.$$eval('#canvas-context-menu button',xs=>xs.filter(x=>!x.hidden&&getComputedStyle(x).display!=='none').map(x=>x.dataset.action));
    async function rightAt(coord){const p=await page.evaluate(c=>{map.renderSync();const p=map.getPixelFromCoordinate(c),r=map.getTargetElement().getBoundingClientRect();return [p[0]+r.left,p[1]+r.top];},coord);await page.mouse.click(...p,{button:'right'});await page.waitForSelector(menu,{visible:true});}
    await rightAt([9,9]);assert.deepEqual(await page.evaluate(()=>selectedFeatures.getArray().map(f=>f.get('elementId'))),['target-a']);
    assert((await visible()).includes('new-work-order'));assert(!(await visible()).includes('delete-drawing'));assert(!(await visible()).includes('source-navigation'));
    await page.click(button('inspect-properties'));assert(await page.evaluate(()=>shapeProperties.isOpen()));assert(await page.$eval('#shape-properties input',e=>e.disabled),'GDS properties editable');
    await page.evaluate(()=>shapeProperties.hide());await rightAt([9,9]);
    await page.click(button('new-work-order'));assert.equal(await page.evaluate(()=>document.activeElement.id),'intent-text');
    await page.evaluate(()=>replaceSelection([allFeatures[0],allFeatures[1]]));await rightAt([9,9]);assert.equal(await page.evaluate(()=>selectedFeatures.getLength()),2,'right-click lost multi-selection');
    await page.screenshot({path:path.join(out,'gds-selection.png')});await page.keyboard.press('Escape');
    await rightAt([-16,7]);assert.deepEqual(await page.evaluate(()=>selectedFeatures.getArray().map(f=>f.get('elementId'))),['target-c']);
    await page.click(button('copy-selection'));assert(await page.evaluate(()=>__sent.some(m=>m.type==='exportYaml')),'copy action did not reach host');
    await page.evaluate(()=>{clearSelection();document.getElementById('map').focus();});await page.keyboard.down('Shift');await page.keyboard.press('F10');await page.keyboard.up('Shift');await page.waitForSelector(menu,{visible:true});
    assert((await visible()).includes('empty-route'));await page.keyboard.press('End');await page.keyboard.press('Home');assert(await page.evaluate(()=>document.activeElement.closest('#canvas-context-menu')!==null));await page.keyboard.press('Escape');
    await page.focus('#intent-text');await page.keyboard.down('Shift');await page.keyboard.press('F10');await page.keyboard.up('Shift');assert(await page.$eval(menu,e=>e.hidden),'text field menu hijacked');await page.keyboard.press('Escape');
    const drawing={id:'context-drawing',shapeType:'polygon',geometry:{type:'Polygon',coordinates:[[[3,3],[8,3],[8,8],[3,8],[3,3]]]},intent:{action:'add',targetIds:[]}};
    await page.evaluate(a=>window.dispatchEvent(new MessageEvent('message',{data:{type:'restoreAnnotations',layoutHash:currentLayoutHash,annotations:[a]}})),drawing);
    await rightAt([5,5]);await page.click(button('review-select'));assert((await visible()).includes('delete-drawing'));await page.click(button('delete-drawing'));assert.equal(await page.evaluate(()=>drawSource.getFeatures().length),0);assert.equal(await page.evaluate(()=>allFeatures.length),3,'deleted source geometry');
    await page.evaluate(()=>{const c=document.createElement('canvas');c.width=40;c.height=20;c.getContext('2d').fillRect(0,0,40,20);insertMicroImage(c.toDataURL(),'context-image','image-context');});await page.waitForFunction(()=>microImg&&microImg.imageId==='image-context');
    await page.evaluate(()=>{microImg.cx=20;microImg.cy=14;microImg.umPerPx=0.1;renderMicroLayer();});await rightAt([20,14]);assert((await visible()).includes('image-properties'));await page.click(button('image-properties'));assert.equal(await page.$eval('#image-controls',e=>e.hidden),false);
    await rightAt([20,14]);await page.click(button('image-place-view'));assert.match(await page.evaluate(()=>imageFeedback),/current GDS view/);
    await page.evaluate(()=>{microImg.visible=false;renderMicroLayer();});await rightAt([20,14]);assert(!(await visible()).includes('image-remove'),'hidden image targeted');await page.keyboard.press('Escape');
    await page.evaluate(()=>{clearSelection();setMode('rectangle');});await rightAt([9,9]);assert((await visible()).includes('cancel-tool'));await page.click(button('cancel-tool'));assert.equal(await page.evaluate(()=>currentMode),'select');
    await rightAt([9,9]);await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'layoutLoading'}})));assert(await page.$eval(menu,e=>e.hidden),'menu survived rebuild');
    await page.evaluate(g=>window.dispatchEvent(new MessageEvent('message',{data:{type:'loadGds',geojson:g,gdsPath:'standalone.gds',annotations:[],mode:'full'}})),TINY);
    await page.setViewport({width:500,height:650});await page.evaluate(()=>{clearSelection();map.updateSize();fitView();});await new Promise(r=>setTimeout(r,350));
    const pos=await page.$eval('#map',el=>{const r=el.getBoundingClientRect();return [r.right-3,r.bottom-3];});await page.mouse.click(...pos,{button:'right'});await page.waitForSelector(menu,{visible:true});
    assert(await page.$eval(menu,e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}),'menu outside viewport');await page.screenshot({path:path.join(out,'compact.png')});
    await page.click('#intent-text');assert(await page.$eval(menu,e=>e.hidden),'outside click failed');assert.deepEqual(errors,[]);
    assert(await page.evaluate(()=>__sent.some(m=>m.type==='usageEvent'&&m.control==='context.copy-selection')),'menu action not logged');
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({status:'passed',cases:['pointer-selection','readonly-inspect','multi-selection','work-order-focus','copy-host-message','keyboard','text-input','drawing-delete-only','image-properties','image-place-view','hidden-image','cancel-tool','rebuild-dismiss','compact-bounds','outside-dismiss','automatic-usage-event']},null,2));console.log('Context menu browser checks passed');
  } catch(e){if(page)await page.screenshot({path:path.join(out,'failure.png')});throw e;} finally {await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
