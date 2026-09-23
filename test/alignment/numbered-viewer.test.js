#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const childProcess = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..', '..');
const PARSER = path.join(ROOT, 'python', 'parse_gds.py');
const MAKE_STANDALONE = path.join(ROOT, 'scripts', 'make-standalone.js');
const REPORT_DIR = path.join(ROOT, 'logs', 'numbered-markers', 'viewer');

function usage() { return 'Usage: node test/alignment/numbered-viewer.test.js --image FILE [--gds FILE] [--python EXE]'; }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!['--image', '--gds', '--python'].includes(a)) throw new Error(`Unknown argument: ${a}\n${usage()}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${a}\n${usage()}`);
    out[a.slice(2)] = argv[++i];
  }
  if (!out.image) throw new Error(`Missing --image\n${usage()}`);
  out.image = path.resolve(out.image);
  out.gds = path.resolve(out.gds || path.join(ROOT, 'test', 'fixtures', 'jj_pad_center_100_test.gds'));
  out.python = out.python || 'python';
  for (const [name, file] of [['image', out.image], ['gds', out.gds]]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${name} does not exist or is not a file: ${file}`);
  }
  return out;
}
function parseGds(python, gds) {
  let stdout;
  try { stdout = childProcess.execFileSync(python, [PARSER, gds], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, windowsHide: true }); }
  catch (e) { throw new Error(`parse_gds.py failed: ${e.stderr ? String(e.stderr).trim() : e.message}`); }
  let parsed;
  try { parsed = JSON.parse(stdout); } catch (e) { throw new Error(`parse_gds.py produced invalid JSON: ${e.message}`); }
  if (parsed && parsed.error) throw new Error(String(parsed.error));
  if (!parsed || !Array.isArray(parsed.features)) throw new Error('parse_gds.py result has no features array');
  return parsed;
}
function dataUrl(file) {
  const mime = path.extname(file).toLowerCase() === '.jpg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}
function browserPath() {
  const candidates = [process.env.EDGE_PATH, process.env.CHROME_PATH,
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  for (const n of process.platform === 'win32' ? ['msedge.exe', 'chrome.exe'] : ['microsoft-edge', 'google-chrome', 'chromium']) {
    try { const p = childProcess.execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [n], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]; if (p && fs.existsSync(p)) return p; } catch (_) { /* try next */ }
  }
  throw new Error('Could not find Microsoft Edge or Chrome; set EDGE_PATH or CHROME_PATH');
}
function containment(file) { return file === ROOT || file.startsWith(ROOT + path.sep); }
function contentType(file) { return { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' }[path.extname(file).toLowerCase()] || 'application/octet-stream'; }
function startServer(parsed) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let file;
      if (url.pathname === '/data.json') {
        file = path.join(REPORT_DIR, 'parsed-data.json');
      } else {
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        file = path.resolve(ROOT, relative);
      }
      if (!containment(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (e) { res.writeHead(400); res.end(String(e.message || e)); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
function assert(condition, message) { if (!condition) throw new Error(message); }

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const parsed = parseGds(options.python, options.gds);
  fs.writeFileSync(path.join(REPORT_DIR, 'parsed-data.json'), JSON.stringify(parsed));
  childProcess.execFileSync(process.execPath, [MAKE_STANDALONE], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  const { server, port } = await startServer(parsed);
  const browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, protocolTimeout: 300000, args: ['--no-first-run'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });
  const report = { image: options.image, gds: options.gds, featureCount: parsed.features.length, checks: {}, pageErrors: [] };
  page.on('pageerror', e => report.pageErrors.push(String(e.message || e)));
  try {
    await page.goto(`http://127.0.0.1:${port}/webview/test-standalone.html?data=/data`, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.waitForFunction(() => Array.isArray(window.allFeatures) && window.allFeatures.length > 0, { timeout: 120000 });
    const image = dataUrl(options.image);
    await page.evaluate((url) => window.insertMicroImage(url, 'assigned-image'), image);
    await page.waitForFunction(() => window.microImg && window.microImg.img && window.microImg.img.complete && window.microImg.img.naturalWidth > 0 && window.microLayer, { timeout: 30000 });
    report.checks.sourceDecoded = await page.evaluate(() => ({ width: microImg.img.naturalWidth, height: microImg.img.naturalHeight }));
    await page.evaluate(() => window.autoAlignMicroImage());
    const initialStatus = await page.evaluate(() => ({result:window.__lastAlignDebug,feedback:window.imageFeedback,errors:window.__pageErrors}));
    if(initialStatus.result?.status !== 'aligned') throw new Error('Alignment failed: '+JSON.stringify(initialStatus));
    const aligned = await page.evaluate(() => ({
      debug: window.__lastAlignDebug,
      state: { cx: microImg.cx, cy: microImg.cy, umPerPx: microImg.umPerPx, rotDeg: microImg.rotDeg, markerTransform: microImg.markerTransform && microImg.markerTransform.slice() },
      layer: !!microLayer,
      extent: microLayer && microLayer.getSource().getImageExtent(),
      sent: window.__sent.slice()
    }));
    assert(aligned.layer, 'aligned image render layer was not created');
    assert(Array.isArray(aligned.state.markerTransform) && aligned.state.markerTransform.length === 9, 'markerTransform was not saved');
    assert(Array.isArray(aligned.debug.markers) && aligned.debug.markers.length === 4, `expected four markers, got ${aligned.debug.markers && aligned.debug.markers.length}`);
    assert(new Set(aligned.debug.markers.map(m => m.label)).size === 4, 'marker IDs are not unique');
    assert(aligned.debug.markers.every(m => ['0,0', '1,0', '0,-1', '1,-1'].includes(m.label)), 'unexpected marker ID');
    assert(Number(aligned.debug.boundaryRmsPx) < 2, `boundary RMS too high: ${aligned.debug.boundaryRmsPx}`);
    assert(aligned.sent.some(m => m && m.type === 'imageAligned' && m.alignmentMethod === 'numbered-markers'), 'imageAligned message missing numbered-markers method');
    report.checks.aligned = { markers: aligned.debug.markers.map(m => ({ label: m.label, rms: m.boundaryRmsPx })), boundaryRmsPx: aligned.debug.boundaryRmsPx, extent: aligned.extent };

    report.checks.imageUnderGds = await page.evaluate(async () => {
      microImg.opacity = 1; renderMicroLayer();
      fitMicroImage();
      map.renderSync();
      await new Promise(resolve => { const image = new Image(); image.onload = resolve; image.src = microLayer.getSource().getUrl(); });
      map.renderSync();
      return microLayer.getZIndex() < (vectorLayer.getZIndex() || 0);
    });
    assert(report.checks.imageUnderGds, 'microscope image must render beneath GDS elements');
    await page.screenshot({ path: path.join(REPORT_DIR, 'aligned-underlay.png'), fullPage: true });

    const workflow = await page.evaluate(async (geojson) => {
      const check=(v,m)=>{if(!v)throw new Error(m);};
      const saved=MicroscopeOverlay.serialize(microImg),originalUrl=microImg.img.src;
      microImg.imageId='workflow-test';currentLayoutHash='hash-a';
      const raster=microLayer._rendered;
      const opacity=document.getElementById('image-opacity');opacity.value='45';opacity.dispatchEvent(new Event('input'));
      check(microLayer._rendered===raster,'opacity rerasterized the image');
      check(microLayer.getOpacity()===.45,'opacity control not applied');
      const show=document.getElementById('image-visible');show.checked=false;show.dispatchEvent(new Event('change'));check(!microLayer.getVisible(),'visibility control not applied');
      show.checked=true;show.dispatchEvent(new Event('change'));
      const x=microImg.cx,y=microImg.cy;nudgeMicroImage(3,4);check(microImg.cx===x&&microImg.cy===y,'locked placement moved');
      const lock=document.getElementById('image-locked');lock.checked=false;lock.dispatchEvent(new Event('change'));
      nudgeMicroImage(3,4);check(microImg.quality.status==='adjusted','manual edits retained aligned quality');
      document.getElementById('image-reset').click();check(microImg.cx===saved.cx&&microImg.cy===saved.cy,'reset did not restore alignment');
      check(microImg.quality.status==='aligned'&&microImg.locked,'reset did not restore verified/locked state');
      saveImageState();await new Promise(r=>setTimeout(r,190));
      const message=window.__sent.filter(m=>m.type==='saveImageState').pop();check(message&&message.state.version===1&&!message.state.img&&!message.state.dataUrl,'compact save message missing');
      window.dispatchEvent(new MessageEvent('message',{data:{type:'imageStateSaved',imageId:'workflow-test',revision:message.revision-1}}));
      check(imageSaveStatus==='Saving…','stale save acknowledgement accepted');
      window.dispatchEvent(new MessageEvent('message',{data:{type:'imageStateSaved',imageId:'workflow-test',revision:message.revision}}));
      check(imageSaveStatus==='Saved in this workspace','save acknowledgement not shown');
      insertMicroImage(originalUrl,'restored-workflow','workflow-test',message.state);
      const deadline=Date.now()+3000;while(microImg.name!=='restored-workflow'){if(Date.now()>deadline)throw new Error('restore timeout');await new Promise(r=>setTimeout(r,20));}
      check(JSON.stringify(microImg.markerTransform)===JSON.stringify(saved.markerTransform),'restore changed transform');
      check(microImg.opacity===.45&&microImg.quality.status==='aligned','restore lost display or quality state');
      const appearance=document.getElementById('image-appearance');appearance.value='bright';appearance.dispatchEvent(new Event('change'));
      check(microImg.quality.status==='unverified','new settings retained old confidence');
      MicroscopeOverlay.restore(microImg,saved);
      check(microImg.quality.status==='aligned'&&microImg.markerTransform,'verified state was not restored before changed GDS');
      const transformBeforeChangedGds=JSON.stringify(microImg.markerTransform);
      window.dispatchEvent(new MessageEvent('message',{data:{type:'loadGds',geojson,gdsPath:'standalone.gds',layoutHash:'hash-b',annotations:[],mode:'full'}}));
      check(JSON.stringify(microImg.markerTransform)===transformBeforeChangedGds&&microImg.quality.status==='unverified','changed GDS did not preserve placement while invalidating verification');
      clearTimeout(imageSaveTimer);MicroscopeOverlay.restore(microImg,saved);microImg.imageId=null;imageFeedback='';imageSaveStatus='Local preview';renderMicroLayer();fitMicroImage();
      return {cachedOpacity:true,visibility:true,lock:true,manualQuality:true,reset:true,compactSave:true,staleAckRejected:true,restore:true,optionsInvalidateQuality:true,changedGdsStalesVerification:true};
    }, parsed);
    report.checks.workflow = workflow;
    await page.screenshot({ path: path.join(REPORT_DIR, 'engineered-workflow.png'), fullPage: true });

    const manual = await page.evaluate(() => {
      const before = microLayer.getSource().getImageExtent().slice(); const h = microImg.markerTransform.slice();
      microImg.cx += 37; microImg.cy -= 19; renderMicroLayer();
      const nudged = microLayer.getSource().getImageExtent().slice();
      microImg.umPerPx *= 1.1; microImg.rotDeg += 7; renderMicroLayer();
      const after = microLayer.getSource().getImageExtent().slice();
      return { before, nudged, after, h, currentH: microImg.markerTransform.slice(), centerDelta: [(nudged[0] + nudged[2] - before[0] - before[2]) / 2, (nudged[1] + nudged[3] - before[1] - before[3]) / 2], changedAfterScaleRotate: JSON.stringify(nudged) !== JSON.stringify(after) };
    });
    assert(Math.abs(manual.centerDelta[0] - 37) < 1e-6 && Math.abs(manual.centerDelta[1] + 19) < 1e-6, `manual translation was not reflected in image extent: ${manual.centerDelta}`);
    assert(manual.changedAfterScaleRotate, 'manual scale/rotation did not update image extent');
    assert(JSON.stringify(manual.h) === JSON.stringify(manual.currentH), 'manual edit lost markerTransform H');
    report.checks.manualEdit = manual;

    const failure = await page.evaluate(async () => {
      const original = microImg.img, before = { cx: microImg.cx, cy: microImg.cy, umPerPx: microImg.umPerPx, rotDeg: microImg.rotDeg, h: microImg.markerTransform.slice() }, n = window.__sent.length;
      const blank = document.createElement('canvas'); blank.width = original.naturalWidth; blank.height = original.naturalHeight; const c = blank.getContext('2d'); c.fillStyle = '#777'; c.fillRect(0, 0, blank.width, blank.height);
      const replacement = new Image(); replacement.src = blank.toDataURL('image/png'); await replacement.decode(); microImg.img = replacement; await autoAlignMicroImage();
      const messages = window.__sent.slice(n); const after = { cx: microImg.cx, cy: microImg.cy, umPerPx: microImg.umPerPx, rotDeg: microImg.rotDeg, h: microImg.markerTransform.slice() };
      microImg.img = original; renderMicroLayer();
      return { before, after, messages, failed: !messages.some(m => m && m.type === 'imageAligned'), failureMessage: messages.find(m => m && m.type === 'imageTransform' && String(m.note || '').includes('auto-align failed')) };
    });
    assert(failure.failed, 'blank replacement unexpectedly emitted imageAligned');
    assert(JSON.stringify(failure.before) === JSON.stringify(failure.after), 'failed alignment changed prior placement or H');
    assert(failure.failureMessage, 'failed alignment did not preserve/report failure message');
    report.checks.failurePreservesPlacement = true;
    await page.screenshot({ path: path.join(REPORT_DIR, 'viewer.png'), fullPage: true });
    report.pageErrors = (await page.evaluate(() => window.__pageErrors || [])).concat(report.pageErrors);
    assert(report.pageErrors.length === 0, `page errors: ${report.pageErrors.join('; ')}`);
    fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify({ status: 'passed', ...report }, null, 2) + '\n');
    console.log(JSON.stringify({ status: 'passed', report: path.join(REPORT_DIR, 'report.json'), screenshot: path.join(REPORT_DIR, 'viewer.png') }));
  } catch (error) {
    report.pageErrors = await page.evaluate(() => window.__pageErrors || []).catch(() => report.pageErrors);
    fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify({ status: 'failed', error: error.message, ...report }, null, 2) + '\n');
    console.error(JSON.stringify({ status: 'failed', error: error.message, report: path.join(REPORT_DIR, 'report.json') }, null, 2));
    process.exitCode = 1;
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { parseArgs, parseGds };
