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
  [1, 0, 0, 0, 18, 18], [2, 0, 24, 0, 12, 10], [3, 1, -20, 0, 8, 14]
].map(([layer, data_type, x, y, w, h], i) => ({ type: 'Feature', properties: { element_id: 'tiny-' + i, layer, data_type, color: ['#f38ba8', '#89b4fa', '#a6e3a1'][i] }, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]] } })) };

function server() {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      let body, type;
      if (p === '/tiny.json') { body = JSON.stringify(TINY); type = 'application/json'; }
      else {
        const f = path.resolve(ROOT, p.replace(/^\/+/, ''));
        if ((f !== ROOT && !f.startsWith(ROOT + path.sep)) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('not found'); }
        body = fs.readFileSync(f); type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f).toLowerCase()] || 'application/octet-stream');
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body);
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port }));
  });
}

async function main() {
  cp.execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-standalone.js')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  const out = path.join(ROOT, 'logs/reliability/eda-workbench'); fs.mkdirSync(out, { recursive: true });
  const { s, port } = await server(); const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-first-run'] });
  try {
    const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/webview/test-standalone.html?data=/tiny`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => Array.isArray(allFeatures) && allFeatures.length === 3);
    await page.waitForSelector('#eda-header');
    const inspectorBurst=await page.evaluate(async()=>{
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      const oldFrame=window.requestAnimationFrame,oldResize=map.updateSize,oldSave=vscode.setState;
      let callbacks=[],resizes=0,saves=0;
      window.requestAnimationFrame=callback=>{callbacks.push(callback);return 9000+callbacks.length;};
      map.updateSize=()=>resizes++;vscode.setState=state=>{saves++;oldSave(state);};
      try{
        for(let i=0;i<201;i++)edaWorkbench.activate(i%2?'images':'review');
        const scheduled=callbacks.length;callbacks.splice(0).forEach(fn=>fn());
        const burst={scheduled,resizes,saves,active:document.querySelector('#eda-dock-content').getAttribute('aria-labelledby'),state:window.__state.workbench.active};
        resizes=0;saves=0;
        for(let i=0;i<201;i++)edaWorkbench.activate('review');
        const repeated={scheduled:callbacks.length,resizes,saves};
        return {burst,repeated};
      }finally{window.requestAnimationFrame=oldFrame;map.updateSize=oldResize;vscode.setState=oldSave;edaWorkbench.activate('images');}
    });
    assert.deepEqual(inspectorBurst,{burst:{scheduled:2,resizes:1,saves:1,active:'eda-tab-review',state:'review'},repeated:{scheduled:0,resizes:0,saves:0}});
    // Exercise the actual key handler, including focused fields and modifiers.
    const navigation = await page.evaluate(() => {
      const oldFit=fitView,oldSelection=contextMenuFitSelection,oldProperties=showShapeProperties;
      let fit=0,selection=0,properties=0;
      fitView=()=>fit++;contextMenuFitSelection=()=>selection++;showShapeProperties=()=>properties++;
      const key=(target,k,options={})=>target.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true,...options}));
      addToSelection([allFeatures[0]]);
      key(document.body,'F2');key(document.body,'F2',{shiftKey:true});key(document.body,'e');
      const input=document.querySelector('#intent-text');key(input,'F2');key(input,'e');
      key(document.body,'e',{ctrlKey:true});key(document.body,'F2',{altKey:true});
      const editable=document.createElement('div');editable.contentEditable='true';document.body.append(editable);key(editable,'e');editable.remove();
      fitView=oldFit;contextMenuFitSelection=oldSelection;showShapeProperties=oldProperties;clearSelection();
      return {fit,selection,properties};
    });
    assert.deepEqual(navigation,{fit:1,selection:1,properties:1});
    const coordinates = await page.evaluate(async () => {
      const label=document.querySelector('#eda-coordinates');let writes=0;
      const observer=new MutationObserver(records=>writes+=records.length);observer.observe(label,{childList:true});
      for(let i=0;i<201;i++)edaWorkbench.coordinates([i,-i]);
      await new Promise(requestAnimationFrame);await Promise.resolve();
      const burstWrites=writes,final=label.textContent;
      edaWorkbench.coordinates([200,-200]);await new Promise(requestAnimationFrame);await Promise.resolve();
      const repeatWrites=writes;
      edaWorkbench.coordinates([1,2]);edaWorkbench.coordinates(null);await new Promise(requestAnimationFrame);await Promise.resolve();
      observer.disconnect();return {burstWrites,repeatWrites,final,leave:label.textContent};
    });
    assert.deepEqual(coordinates,{burstWrites:1,repeatWrites:1,final:'X 200.000   Y -200.000 µm',leave:'X —   Y — µm'});
    const shell = await page.evaluate(() => {
      const rect = id => { const r = document.querySelector(id).getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
      return { header: rect('#eda-header'), body: rect('#eda-body'), dock: rect('#eda-dock'), map: rect('#map'), tabs: !!document.querySelector('#eda-tabs'), shapeInToolbar: document.querySelector('#draw-toolbar #shape-menu-btn') !== null, shapeInHeader: document.querySelector('#eda-header #shape-menu-btn') !== null, imageHidden: document.querySelector('#image-controls').hidden };
    });
    assert(shell.tabs && shell.shapeInToolbar && !shell.shapeInHeader, 'EDA shell/header toolbar placement is incorrect');
    assert(shell.dock.left >= shell.map.right - 1, 'inspector dock overlaps the map'); assert(shell.imageHidden, 'image controls should be hidden without an image');
    const visiblePanels = await page.$$eval('#eda-dock-content > *', els => els.filter(el => !el.hidden && getComputedStyle(el).display !== 'none' && el.id !== 'eda-empty').map(el => el.id));
    assert.deepEqual(visiblePanels, [], 'only actual visible panels should be mounted initially');
    for (const tab of ['images', 'properties', 'components', 'changes']) { await page.click('#eda-tab-' + tab); assert.equal(await page.$eval('#eda-tab-' + tab, el => el.getAttribute('aria-selected')), 'true'); }
    await page.click('#eda-tab-images');await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'eda-tab-properties');
    assert.equal(await page.$eval('#eda-dock-content',el=>el.getAttribute('aria-labelledby')),'eda-tab-properties');
    assert.equal(await page.$eval('#eda-tab-properties',el=>el.getAttribute('aria-controls')),'eda-dock-content');
    await page.click('#eda-dock-close');assert.equal(await page.evaluate(()=>document.activeElement.id),'eda-dock-toggle');
    await page.keyboard.press('Enter');assert(await page.$eval('#eda-dock',el=>getComputedStyle(el).display!=='none'));
    await page.click('#eda-tab-components'); await page.waitForFunction(() => !document.querySelector('#primitive-controls').hidden);
    const requestId = await page.evaluate(() => window.__sent.filter(m => m.type === 'requestComponentCatalog').at(-1).requestId);
    const longDescription = 'Tall component documentation '.repeat(160);
    await page.evaluate(({ requestId, longDescription }) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'componentCatalog', requestId, result: { components: [{ name: 'straight', description: longDescription, parameters: [] }, { name: 'bend', description: 'Bend', parameters: [] }] } } })), { requestId, longDescription });
    assert(await page.$eval('#primitive-controls', el => !el.hidden), 'component chooser did not open in the dock');
    await page.click('#primitive-close'); assert(await page.$eval('#primitive-controls', el => el.hidden), 'component chooser did not close');
    const annotation = { id: 'draw-eda', shapeType: 'polygon', geometry: { type: 'Polygon', coordinates: [[[30, 30], [36, 30], [36, 34], [30, 34], [30, 30]]] }, layer: '7/3', intent: { action: 'add', text: 'shape', targetIds: [], snapshot: 'eda-hash', documentPath: 'standalone.gds' } };
    await page.evaluate(a => { currentLayoutHash = 'eda-hash'; window.dispatchEvent(new MessageEvent('message', { data: { type: 'restoreAnnotations', layoutHash: 'eda-hash', annotations: [a] } })); }, annotation);
    await page.evaluate(() => { map.updateSize(); map.getView().fit([0, 0, 40, 40], { size: map.getSize(), padding: [80, 80, 80, 80], duration: 0 }); map.renderSync(); });
    const click = await page.evaluate(() => { const p = map.getPixelFromCoordinate([33, 32]), r = map.getTargetElement().getBoundingClientRect(); return [p[0] + r.left, p[1] + r.top]; });
    await page.mouse.click(click[0], click[1]); await page.waitForFunction(() => selectedFeatures.getLength() === 1 && selectedFeatures.item(0).get('isDrawn'));
    await page.keyboard.press('Tab'); await page.waitForFunction(() => shapeProperties.isOpen());
    assert.equal(await page.evaluate(() => document.activeElement.dataset.field), 'x', 'Tab properties did not focus numeric x field');
    await page.click('#eda-tab-images'); await page.evaluate(()=>map.getTargetElement().focus()); await page.keyboard.press('Tab'); assert.equal(await page.$eval('#eda-tab-properties',el=>el.getAttribute('aria-selected')),'true'); assert.equal(await page.evaluate(()=>document.activeElement.dataset.field),'x');
    const propParent = await page.$eval('#shape-properties', el => el.parentElement.id); assert.equal(propParent, 'eda-dock-content');
    await page.screenshot({ path: path.join(out, 'desktop.png') });
    await page.click('#eda-layers-toggle'); const layerGrowth = await page.evaluate(() => ({ before: document.querySelector('#sidebar').getBoundingClientRect().width, map: document.querySelector('#map').getBoundingClientRect().width, collapsed: document.body.classList.contains('layers-collapsed') })); assert(layerGrowth.collapsed && layerGrowth.map >= 180, 'layers toggle did not grow the map');
    await page.click('#eda-reset'); assert.equal(await page.$eval('#sidebar', el => el.getBoundingClientRect().width > 0), true, 'reset did not restore layer panel');
    for (const width of [800, 500]) {
      await page.setViewport({ width, height: 620 }); await page.click('#eda-dock-toggle');
      const compact = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, map: document.querySelector('#map').getBoundingClientRect().width, collapsed: document.body.classList.contains('dock-collapsed') }));
      assert(compact.collapsed && !compact.overflow && compact.map >= 180, `compact ${width}px layout overflow or map collapse`);
      await page.click('#eda-dock-toggle'); await page.click('#eda-dock-close'); assert(await page.$eval('#eda-dock', el => getComputedStyle(el).display === 'none'));
      await page.click('#eda-dock-toggle'); await page.click('#eda-tab-components'); await page.waitForFunction(() => !document.querySelector('#primitive-controls').hidden); await page.waitForSelector('#component-catalog input[type=search]');
      const scroll = await page.evaluate(() => { document.querySelector('#component-catalog').style.minHeight = '900px'; const n = document.querySelector('#eda-dock-content'); n.scrollTop = n.scrollHeight; return { tall: n.scrollHeight > n.clientHeight, moved: n.scrollTop > 0 }; });
      assert(scroll.tall && scroll.moved, `compact ${width}px inspector content did not scroll`); await page.click('#primitive-close');
      await page.click('#eda-tab-properties'); assert(await page.$eval('#intent-text',el=>el.getBoundingClientRect().width>=180),'instruction input too narrow'); await page.screenshot({path:path.join(out,`compact-${width}.png`)});
    }
    await page.setViewport({ width: 1400, height: 900 }); await page.screenshot({ path: path.join(out, 'compact-final.png') });
    await page.evaluate(()=>{const s=document.documentElement.style;s.setProperty('--vscode-editor-background','#ffffff');s.setProperty('--vscode-sideBar-background','#f3f3f3');s.setProperty('--vscode-foreground','#222222');s.setProperty('--vscode-input-background','#ffffff');s.setProperty('--vscode-editorWidget-background','#ececec');s.setProperty('--vscode-descriptionForeground','#555555');}); await page.screenshot({path:path.join(out,'light-theme.png')}); assert.equal(await page.$eval('#intent-text',el=>getComputedStyle(el).color),'rgb(34, 34, 34)');
    assert.deepEqual(errors, []); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ status: 'passed', viewports: [1400, 800, 500], layersToggle: true, numericFocus: true, screenshots: ['desktop.png', 'compact-800.png', 'compact-500.png', 'light-theme.png'] }, null, 2)); console.log('EDA workbench browser reliability passed');
  } finally { await browser.close(); await new Promise(resolve => s.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
