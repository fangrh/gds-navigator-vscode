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
const TINY = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { element_id: 'target-a', layer: 1, data_type: 0, color: '#f38ba8' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]] } }] };
function server() { return new Promise(resolve => { const s = http.createServer((req, res) => { const p = new URL(req.url, 'http://127.0.0.1').pathname; let body, type; if (p === '/tiny.json') { body = JSON.stringify(TINY); type = 'application/json'; } else { const f = path.resolve(ROOT, p.replace(/^\/+/, '')); if ((f !== ROOT && !f.startsWith(ROOT + path.sep)) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('not found'); } body = fs.readFileSync(f); type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f).toLowerCase()] || 'application/octet-stream'); } res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); }); s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port })); }); }
async function main() {
  cp.execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-standalone.js')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  const out = path.join(ROOT, 'logs/reliability/shape-properties'); fs.mkdirSync(out, { recursive: true }); const { s, port } = await server(); const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 950 }); const errors = []; page.on('pageerror', e => errors.push(e.message)); await page.goto(`http://127.0.0.1:${port}/webview/test-standalone.html?data=/tiny`, { waitUntil: 'networkidle0' }); await page.waitForFunction(() => allFeatures.length === 1); await page.evaluate(() => { currentLayoutHash = 'hash-a'; });
    const annotation = { id: 'draw-1', shapeType: 'polygon', geometry: { type: 'Polygon', coordinates: [[[30, 30], [36, 30], [36, 34], [30, 34], [30, 30]]] }, layer: '7/3', intent: { action: 'add', text: 'shape', targetIds: ['target-a'], snapshot: 'hash-a', documentPath: 'standalone.gds' } };
    await page.evaluate(a => window.dispatchEvent(new MessageEvent('message', { data: { type: 'restoreAnnotations', layoutHash: 'hash-a', annotations: [a] } })), annotation);
    await page.evaluate(() => { map.updateSize();map.getView().cancelAnimations();map.getView().fit([0,0,40,40],{size:map.getSize(),padding:[80,80,80,80],duration:0});map.renderSync(); });
    await new Promise(r=>setTimeout(r,50));
    const click=await page.evaluate(()=>{var px=map.getPixelFromCoordinate([33,32]),r=map.getTargetElement().getBoundingClientRect();return [px[0]+r.left,px[1]+r.top];});
    await page.mouse.click(click[0],click[1]);
    await page.waitForFunction(()=>selectedFeatures.getLength()===1&&selectedFeatures.item(0).get('isDrawn'),{timeout:3000});
    await page.keyboard.press('Tab');await page.waitForFunction(()=>shapeProperties.isOpen(),{timeout:3000});
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.field),'x');
    const before = await page.evaluate(() => { const f = drawSource.getFeatures()[0], e = f.getGeometry().getExtent(); return { cx: (e[0] + e[2]) / 2, cy: (e[1] + e[3]) / 2, w: e[2] - e[0], h: e[3] - e[1], n: window.__sent.filter(m => m.type === 'saveAnnotations').length }; });
    await page.$$eval('#shape-properties input', (els) => { const values = { x: 10, y: 20, width: 8, height: 4, rotation: 30 }; els.forEach(el => { el.value = String(values[el.dataset.field]); }); }); await page.$$eval('#shape-properties button', buttons => buttons.find(button => button.textContent === 'Apply').click());
    const after = await page.evaluate(() => { const f = drawSource.getFeatures()[0], g = f.getGeometry(), e = g.getExtent(); return { cx: (e[0] + e[2]) / 2, cy: (e[1] + e[3]) / 2, w: e[2] - e[0], h: e[3] - e[1], rotation: f.get('editRotation'), saves: window.__sent.filter(m => m.type === 'saveAnnotations').length }; });
    assert(Math.abs(after.cx - 10) < 1e-8 && Math.abs(after.cy - 20) < 1e-8 && Math.abs(after.w - (8 * Math.cos(Math.PI / 6) + 4 * Math.sin(Math.PI / 6))) < 1e-6 && Math.abs(after.h - (8 * Math.sin(Math.PI / 6) + 4 * Math.cos(Math.PI / 6))) < 1e-6); assert.equal(after.rotation, 30); assert.equal(after.saves, before.n + 1);
    const pagePoint = async coordinate => page.evaluate(c => { const p = map.getPixelFromCoordinate(c), r = map.getTargetElement().getBoundingClientRect(); return [p[0] + r.left, p[1] + r.top]; }, coordinate);
    const moveBefore = await page.evaluate(() => ol.extent.getCenter(drawSource.getFeatures()[0].getGeometry().getExtent())); await page.click('#shape-properties button[data-mode="move"]'); const center = await pagePoint(moveBefore); await page.mouse.move(center[0], center[1]); await page.mouse.down(); await page.mouse.move(center[0] + 50, center[1] - 30, { steps: 4 }); await page.mouse.up(); await new Promise(resolve => setTimeout(resolve, 80)); const moveAfter = await page.evaluate(() => ol.extent.getCenter(drawSource.getFeatures()[0].getGeometry().getExtent())); assert(Math.abs(moveAfter[0] - moveBefore[0]) > 1e-6 || Math.abs(moveAfter[1] - moveBefore[1]) > 1e-6, 'move drag did not update geometry');
    const rotationBefore = await page.evaluate(() => drawSource.getFeatures()[0].get('editRotation') || 0); await page.click('#shape-properties button[data-mode="rotate"]'); const rotateWorld = await page.evaluate(() => { const e = drawSource.getFeatures()[0].getGeometry().getExtent(), c = ol.extent.getCenter(e); return [c[0] + (e[2] - e[0]) * .3, c[1]]; }); const rotateCenter = await pagePoint(rotateWorld); await page.mouse.move(rotateCenter[0], rotateCenter[1]); await page.mouse.down(); await page.mouse.move(rotateCenter[0], rotateCenter[1] - 35, { steps: 4 }); await page.mouse.up(); await new Promise(resolve => setTimeout(resolve, 80)); const rotationAfter = await page.evaluate(() => drawSource.getFeatures()[0].get('editRotation') || 0); assert(Math.abs(rotationAfter - rotationBefore) > 1, 'rotate drag did not update rotation');
    await page.click('#shape-properties button[data-mode="resize"]'); const resizeWorld = await page.evaluate(() => { const e = drawSource.getFeatures()[0].getGeometry().getExtent(), c = ol.extent.getCenter(e); return [c[0] + (e[2] - e[0]) * .3, c[1]]; }); const resizeCenter = await pagePoint(resizeWorld); const resizeBefore = await page.evaluate(() => { const e = drawSource.getFeatures()[0].getGeometry().getExtent(); return e[2] - e[0]; }); const saveBeforeResize = await page.evaluate(() => window.__sent.filter(m => m.type === 'saveAnnotations').length); await page.mouse.move(resizeCenter[0], resizeCenter[1]); await page.mouse.down(); await page.mouse.move(resizeCenter[0] + 30, resizeCenter[1] + 20, { steps: 4 }); await page.mouse.up(); await new Promise(resolve => setTimeout(resolve, 80)); const resizeAfter = await page.evaluate(() => { const e = drawSource.getFeatures()[0].getGeometry().getExtent(); return e[2] - e[0]; }); assert(Math.abs(resizeAfter - resizeBefore) > 1e-6, 'resize drag did not update dimensions'); assert.equal(await page.evaluate(() => window.__sent.filter(m => m.type === 'saveAnnotations').length), saveBeforeResize + 1);
    await page.screenshot({path:path.join(out,'properties-editable.png')});
    const saved=await page.evaluate(()=>window.__sent.filter(m=>m.type==='saveAnnotations').at(-1).annotations);assert.equal(typeof saved[0].editRotation,'number');
    await page.evaluate(annotations=>window.dispatchEvent(new MessageEvent('message',{data:{type:'restoreAnnotations',layoutHash:'hash-a',annotations}})),saved);
    assert.equal(await page.evaluate(()=>drawSource.getFeatures()[0].get('editRotation')),saved[0].editRotation);
    await page.evaluate(()=>{replaceSelection([drawSource.getFeatures()[0]]);showShapeProperties();});
    await page.click('#shape-properties button[aria-label="Close shape properties"]'); assert.equal(await page.evaluate(() => shapeProperties.isOpen()), false);
    await page.evaluate(() => { replaceSelection([drawSource.getFeatures()[0]]); showShapeProperties(); }); await page.click('#shape-properties button[data-mode="move"]'); const restoreGeometry = await page.evaluate(() => drawSource.getFeatures()[0].getGeometry().getCoordinates()); const restoreRotation = await page.evaluate(() => drawSource.getFeatures()[0].get('editRotation') || 0); const p = await pagePoint(await page.evaluate(() => ol.extent.getCenter(drawSource.getFeatures()[0].getGeometry().getExtent()))); await page.mouse.move(p[0], p[1]); await page.mouse.down(); await page.mouse.move(p[0] + 70, p[1] + 10, { steps: 3 }); await page.keyboard.press('Escape'); await page.mouse.up(); await new Promise(resolve => setTimeout(resolve, 50)); assert.deepEqual(await page.evaluate(() => drawSource.getFeatures()[0].getGeometry().getCoordinates()), restoreGeometry); assert.equal(await page.evaluate(() => drawSource.getFeatures()[0].get('editRotation') || 0), restoreRotation);
    await page.evaluate(() => replaceSelection([allFeatures[0]])); await page.evaluate(() => showShapeProperties()); assert.equal(await page.$eval('#shape-properties input[data-field="x"]', el => el.disabled), true); assert.equal(await page.$eval('#shape-properties .help', el => el.textContent.includes('read-only')), true);
    // A factory has multiple polygons/layers but is one editable placement.
    await page.evaluate(() => {
      shapeProperties.hide();clearSelection();drawSource.clear();
      [0,10].forEach((x,i)=>{const f=new ol.Feature(new ol.geom.Polygon([[[x,0],[x+4,0],[x+4,4],[x,4],[x,0]]]));f.setProperties({isDrawn:true,annotationId:'factory-'+i,shapeType:'polygon',layer:i+'/0',factory:{name:'coupler',groupId:'group-test',pieceIndex:i,pieceCount:2},intent:{action:'add'}});drawSource.addFeature(f);});
      replaceSelection([drawSource.getFeatures()[0]]);onSelectionChanged();map.getTargetElement().focus();
    });
    assert.equal(await page.evaluate(()=>selectedFeatures.getLength()),2);
    assert.equal(await page.evaluate(()=>editableDrawings.getLength()),0,'factory must not expose individual vertex edits');
    await page.keyboard.press('Tab');await page.waitForFunction(()=>shapeProperties.isOpen());
    await page.$$eval('#shape-properties input',els=>{const v={x:30,y:40,width:28,height:8,rotation:90};els.forEach(el=>el.value=String(v[el.dataset.field]));});
    await page.$$eval('#shape-properties button',bs=>bs.find(b=>b.textContent==='Apply').click());
    const grouped=await page.evaluate(()=>({metrics:shapeMetrics(selectedShape()),layers:drawSource.getFeatures().map(f=>f.get('layer')),centers:drawSource.getFeatures().map(f=>ol.extent.getCenter(f.getGeometry().getExtent()))}));
    for(const [key,value] of Object.entries({x:30,y:40,width:28,height:8,rotation:90}))assert(Math.abs(grouped.metrics[key]-value)<1e-8,key);
    assert.deepEqual(grouped.layers,['0/0','1/0']);assert(Math.abs(grouped.centers[1][1]-grouped.centers[0][1]-20)<1e-8);
    await page.evaluate(()=>{map.getView().fit([15,15,45,65],{size:map.getSize(),padding:[100,100,100,100],duration:0});map.renderSync();});
    await page.click('#shape-properties button[data-mode="move"]');
    await new Promise(r=>setTimeout(r,80));
    const groupPoint=await pagePoint(grouped.centers[0]);await page.mouse.move(...groupPoint);await page.mouse.down();await page.mouse.move(groupPoint[0]+25,groupPoint[1]+20,{steps:3});await page.mouse.up();
    const moved=await page.evaluate(()=>drawSource.getFeatures().map(f=>ol.extent.getCenter(f.getGeometry().getExtent())));
    assert(Math.abs(moved[0][0]-grouped.centers[0][0])>1e-6);assert(Math.abs((moved[1][0]-grouped.centers[1][0])-(moved[0][0]-grouped.centers[0][0]))<1e-8);
    await page.screenshot({ path: path.join(out, 'viewer.png') }); assert.deepEqual(errors, []); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ status: 'passed', numericApply: true, mouseModes: ['move', 'rotate', 'resize'], factoryGroup: true, cancel: true, readonlyGds: true }, null, 2)); console.log('Shape properties browser interactions passed');
  } finally { await browser.close(); await new Promise(resolve => s.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
