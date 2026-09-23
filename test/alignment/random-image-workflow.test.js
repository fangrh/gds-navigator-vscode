#!/usr/bin/env node
'use strict';

// Browser workflow coverage: exercise the real toolbar buttons while the
// native file chooser is represented by a deterministic host response.
const fs = require('fs');
const http = require('http');
const path = require('path');
const childProcess = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..', '..');
const CORPUS = path.join(ROOT, 'logs', 'numbered-markers', 'random100');
const REPORT_DIR = path.join(CORPUS, 'workflow');
const fixture = path.join(ROOT, 'test', 'fixtures', 'jj_pad_center_50_geo.json');

function browserPath() {
  const candidates = [process.env.GDS_BROWSER, 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Edge/Chrome required; set GDS_BROWSER');
}
function mime(file) { return { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css' }[path.extname(file).toLowerCase()] || 'application/octet-stream'; }
function server() {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      let file = u.pathname === '/data.json' ? fixture : path.resolve(ROOT, decodeURIComponent(u.pathname).replace(/^\/+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': mime(file), 'Cache-Control': 'no-store' }); fs.createReadStream(file).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port }));
  });
}
function dataUrl(file) { return 'data:image/png;base64,' + fs.readFileSync(path.resolve(CORPUS, file)).toString('base64'); }
function assert(ok, message) { if (!ok) throw new Error(message); }

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8'));
  const mild = manifest.cases.find(c => c.id === 'random-002');
  const unreadable = [...manifest.cases].reverse().find(c => c.expected === 'reject');
  assert(mild && unreadable, 'manifest must contain an expected-align mild case and expected-reject case');
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  childProcess.execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-standalone.js')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  const { s, port } = await server();
  const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, protocolTimeout: 300000 });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });
  const report = { status: 'running', nativeChooser: 'simulated by dispatching host loadImage response', cases: {}, pageErrors: [] };
  page.on('pageerror', e => report.pageErrors.push(String(e.message || e)));
  try {
    await page.goto(`http://127.0.0.1:${port}/webview/test-standalone.html?data=/data`, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.waitForFunction(() => Array.isArray(window.allFeatures) && window.allFeatures.length > 0, { timeout: 30000 });
    await page.evaluate(()=>{const original=vscode.postMessage.bind(vscode);vscode.postMessage=function(message){original(message);if(message.type==='saveImageState')setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'imageStateSaved',imageId:message.imageId,revision:message.revision}})),0);};});
    const choose = async (spec, name) => {
      await page.evaluate(() => { window.__sent = []; });
      await page.click('#img-insert-btn');
      await page.waitForFunction(() => window.__sent.some(m => m && m.type === 'insertImage'), { timeout: 5000 });
      await page.evaluate(({url, name}) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'loadImage', dataUrl: url, fileName: name, imageId: name,append:true } })), { url: dataUrl(spec.image), name });
      await page.waitForFunction(name => window.microImg && window.microLayer && microImg.imageId===name, { timeout: 30000 }, name);
    };
    await choose(mild, 'mild-first.png');
    const inserted = await page.evaluate(() => ({ visible: !document.querySelector('#image-controls').hidden, zImage: microLayer.getZIndex(), zGds: vectorLayer.getZIndex() || 0, extent: microLayer.getSource().getImageExtent().slice(), view: map.getView().calculateExtent(map.getSize()) }));
    assert(inserted.visible, 'image controls are not visible after host response');
    assert(inserted.zImage < inserted.zGds, 'image layer must remain beneath GDS layer');
    await page.click('#image-fit');
    const fitted = await page.evaluate(() => ({ extent: microLayer.getSource().getImageExtent().slice(), view: map.getView().calculateExtent(map.getSize()) }));
    assert(fitted.view[0] <= fitted.extent[0] && fitted.view[1] <= fitted.extent[1] && fitted.view[2] >= fitted.extent[2] && fitted.view[3] >= fitted.extent[3], 'Fit image does not contain image extent');
    await page.click('#image-align');
    const busy = await page.evaluate(() => ({ flag: imageBusy, text: document.querySelector('#image-quality').textContent }));
    assert(busy.flag && busy.text.includes('Matching numbered markers'), 'Align did not expose busy feedback');
    await page.waitForFunction(() => document.querySelector('#image-quality').textContent.includes('Matching numbered markers') || window.__lastAlignDebug, { timeout: 30000 });
    await page.waitForFunction(() => !document.querySelector('#image-quality').textContent.includes('Matching numbered markers'), { timeout: 120000 });
    const aligned = await page.evaluate(() => ({ quality: microImg.quality, h: microImg.markerTransform, busy: imageBusy,feedback:imageFeedback,debug:window.__lastAlignDebug }));
    assert(aligned.quality.status === 'aligned', 'mild workflow did not align: ' + JSON.stringify(aligned));
    assert(!aligned.busy && Array.isArray(aligned.h) && aligned.h.length === 9, 'alignment did not settle with transform');
    report.cases.mild = { inserted, fitted, busy, aligned };
    await page.screenshot({path:path.join(REPORT_DIR,'mild-aligned.png')});
    await choose(unreadable, 'unreadable-last.png');
    assert(await page.evaluate(()=>microImages.length===2),'inserting a second image replaced the first');
    await page.evaluate(()=>{const slider=document.querySelector('#image-opacity');slider.value='35';slider.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.click('#image-visible');
    assert(await page.evaluate(()=>microImages[0].opacity===1&&microImages[0].visible!==false&&microImg.opacity===.35&&microImg._layer.getVisible()===false),'opacity/visibility leaked between images');
    await page.click('#image-visible');
    await page.click('#image-lower');
    assert(await page.evaluate(()=>microImages[0]===microImg&&microImages[0]._layer.getZIndex()<microImages[1]._layer.getZIndex()),'lower image did not reorder layers');
    await page.click('#image-raise');
    await page.select('#image-select','0');
    assert(await page.evaluate(()=>microImg.imageId==='mild-first.png'&&microImg.quality.status==='aligned'&&microImg.opacity===1),'switch image lost independent alignment');
    await page.select('#image-select','1');
    await page.select('#image-fit-scope','view');
    await page.evaluate(()=>{map.getView().setCenter([-100,-300]);map.getView().setResolution(.6);map.renderSync();});
    const viewBefore=await page.evaluate(()=>map.getView().calculateExtent(map.getSize()));
    await page.click('#image-place');
    const placement=await page.evaluate(()=>({view:map.getView().calculateExtent(map.getSize()),extent:microLayer.getSource().getImageExtent()}));
    assert(JSON.stringify(viewBefore)===JSON.stringify(placement.view),'fit current view moved viewport');
    assert(placement.extent[0]>=viewBefore[0]-.001&&placement.extent[1]>=viewBefore[1]-.001&&placement.extent[2]<=viewBefore[2]+.001&&placement.extent[3]<=viewBefore[3]+.001,'image not contained in current view');
    await page.select('#image-fit-scope','global');await page.click('#image-place');
    assert(await page.evaluate(()=>{const e=source.getExtent();return Math.abs(microImg.cx-(e[0]+e[2])/2)<.001&&Math.abs(microImg.cy-(e[1]+e[3])/2)<.001;}),'global placement did not center within full layout');
    report.cases.multiImage={count:2,independentOpacity:true,independentVisibility:true,ordering:true,selection:true,currentViewPlacement:placement,globalPlacement:true};
    const before = await page.evaluate(() => ({ cx: microImg.cx, cy: microImg.cy, umPerPx: microImg.umPerPx, rotDeg: microImg.rotDeg }));
    await page.click('#image-align');
    const rejectBusy = await page.evaluate(() => ({ flag: imageBusy, text: document.querySelector('#image-quality').textContent }));
    assert(rejectBusy.flag && rejectBusy.text.includes('Matching numbered markers'), 'Rejecting Align did not expose busy feedback');
    await page.waitForFunction(() => !document.querySelector('#image-quality').textContent.includes('Matching numbered markers'), { timeout: 120000 });
    const failure = await page.evaluate(() => ({ before: { cx: microImg.cx, cy: microImg.cy, umPerPx: microImg.umPerPx, rotDeg: microImg.rotDeg }, quality: microImg.quality, feedback: imageFeedback, busy: imageBusy }));
    assert(failure.quality.status !== 'aligned', 'unreadable image was falsely aligned');
    assert(JSON.stringify(before) === JSON.stringify(failure.before), 'failed alignment changed image placement');
    assert(/auto-align failed/i.test(failure.feedback), 'failed alignment did not report a user-visible reason');
    report.cases.unreadable = { before, rejectBusy, failure };
    await page.screenshot({path:path.join(REPORT_DIR,'unreadable-rejected.png')});
    await page.click('#image-remove');
    assert(await page.evaluate(()=>microImages.length===1&&microImg.imageId==='mild-first.png'&&microImg.quality.status==='aligned'),'removing one image affected another');
    await page.click('#image-remove');
    await page.waitForFunction(() => !window.microImg && document.querySelector('#image-controls').hidden, { timeout: 5000 });
    report.pageErrors = (await page.evaluate(() => window.__pageErrors || [])).concat(report.pageErrors);
    assert(!report.pageErrors.length, 'page errors: ' + report.pageErrors.join('; '));
    report.status = 'passed';
    fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, report: path.join(REPORT_DIR, 'report.json') }));
  } catch (e) {
    report.status = 'failed'; report.error = e.message; report.pageErrors = await page.evaluate(() => window.__pageErrors || []).catch(() => report.pageErrors);
    fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n'); throw e;
  } finally { await browser.close(); await new Promise(resolve => s.close(resolve)); }
}
if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { main };
