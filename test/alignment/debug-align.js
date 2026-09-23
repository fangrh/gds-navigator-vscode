#!/usr/bin/env node
// Focused alignment debugger: dumps the engine's internal pipeline state
// (window.__lastAlignDebug) and posted messages for three probes:
//   1. the real fixture photo
//   2. a blank photo (must fail cleanly)
//   3. a synthetic photo at rot=+30deg (sign convention check: no mirror
//      ambiguity at that angle — whichever rotation scores high is the truth)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8794;
const MIME = { '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.css': 'text/css' };

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, rsp) => {
      let p;
      try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rsp.writeHead(400); rsp.end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const fp = path.normalize(path.join(ROOT, p));
      if (!fp.startsWith(ROOT)) { rsp.writeHead(403); rsp.end(); return; }
      fs.readFile(fp, (err, data) => {
        if (err) { rsp.writeHead(404); rsp.end(); return; }
        rsp.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
        rsp.end(data);
      });
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}
function findBrowser() {
  if (process.env.GDS_BROWSER) return process.env.GDS_BROWSER;
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of cands) { try { fs.accessSync(c); return c; } catch { /* next */ } }
  throw new Error('no browser');
}

(async function main() {
  const srv = await startServer();
  const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--no-first-run'] });
  const page = await browser.newPage();
  page.on('console', (m) => { console.log('[page:' + m.type() + ']', m.text()); });
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=../test/fixtures/chip285_markers_geo`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures && window.allFeatures.length > 100, { timeout: 30000, polling: 100 });
  await page.evaluate(() => { window.__ALIGN_VERBOSE = true; });

  async function runAlign(dataUrl, name, initial) {
    return page.evaluate(async (dataUrl2, name2, initial2) => {
      insertMicroImage(dataUrl2, name2);
      const ok = await new Promise((res) => {
        const t0 = Date.now();
        (function poll() { (microImg && microImg.name === name2) ? res(true) : (Date.now() - t0 > 15000 ? res(false) : setTimeout(poll, 40)); })();
      });
      if (!ok) return { error: 'load timeout' };
      if (initial2) { microImg.cx = initial2.cx; microImg.cy = initial2.cy; microImg.umPerPx = initial2.umPerPx; microImg.rotDeg = initial2.rotDeg || 0; }
      window.__sent.length = 0;
      const t0 = Date.now();
      await autoAlignMicroImage();
      return {
        sent: window.__sent.slice(),
        debug: window.__lastAlignDebug || null,
        elapsedMs: Date.now() - t0,
        errors: window.__pageErrors.slice(),
      };
    }, dataUrl, name, initial || null);
  }

  // --- probe 1: real photo ---
  const realDataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'nbse2_sample1-1_micro.jpg')).toString('base64');
  console.log('=== real photo ===');
  console.log(JSON.stringify(await runAlign(realDataUrl, 'dbg-real', null), (k, v) => (k === 're' || k === 'im') ? undefined : v, 1));

  // --- probe 2: blank ---
  const blank = await page.evaluate(() => {
    const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 1200;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#cfcabc'; ctx.fillRect(0, 0, 1200, 1200);
    return cv.toDataURL('image/jpeg', 0.9);
  });
  console.log('\n=== blank ===');
  console.log(JSON.stringify(await runAlign(blank, 'dbg-blank', null), null, 1));

  // --- probe 3: rot=+30 synthetic (sign check) ---
  const signReport = await page.evaluate(async () => {
    const GT = { umPerPx: 6.0, rotDeg: 30.0, cx: -150, cy: 220 };
    const S = 1200;
    const feat = document.createElement('canvas'); feat.width = S; feat.height = S;
    const fx = feat.getContext('2d');
    fx.fillStyle = '#fff'; fx.fillRect(0, 0, S, S);
    const k = 1 / GT.umPerPx, th = GT.rotDeg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    fx.setTransform(k * c, -k * s, -k * s, k * c, S / 2, S / 2);
    fx.fillStyle = '#4a4640';
    allFeatures.forEach(function (f) {
      if (f.get('isDrawn') || f.get('visible') === false) return;
      const ring = f.getGeometry().getCoordinates()[0];
      if (!ring || ring.length < 3) return;
      fx.beginPath();
      for (let i = 0; i < ring.length; i++) { if (i === 0) fx.moveTo(ring[i][0], ring[i][1]); else fx.lineTo(ring[i][0], ring[i][1]); }
      fx.closePath(); fx.fill();
    });
    const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#d6d2c8'; ctx.fillRect(0, 0, S, S);
    ctx.filter = 'blur(0.8px)'; ctx.drawImage(feat, 0, 0); ctx.filter = 'none';
    insertMicroImage(cv.toDataURL('image/jpeg', 0.9), 'dbg-sign');
    await new Promise((res) => { const t0 = Date.now(); (function poll() { microImg ? res() : (Date.now() - t0 > 5000 ? res() : setTimeout(poll, 30)); })(); });
    function scoreAtPose(rotDeg) {
      const img = microImg.img;
      const Rx = img.naturalWidth * GT.umPerPx * 0.85 + 5, Ry = img.naturalHeight * GT.umPerPx * 0.85 + 5;
      const region = [GT.cx - Rx, GT.cy - Ry, GT.cx + Rx, GT.cy + Ry];
      const FW = 384, FH = Math.max(48, Math.round(FW * (region[3] - region[1]) / (region[2] - region[0])));
      const L = layoutEdgeMap(region, FW, FH);
      const D = layoutOrientedDistMaps(L, FW, FH);
      const pts = imageEdgePoints(region, FW, FH, GT.cx, GT.cy, GT.umPerPx, rotDeg, 6000);
      if (pts.length < 90) return { n: pts.length / 3 | 0, fwd: -1 };
      const fwd0 = scoreChamfer(D, FW, FH, pts, 0, 0, 1.0);
      return { n: pts.length / 3 | 0, fwd: +fwd0.score.toFixed(4) };
    }
    return { atPlus30: scoreAtPose(30), atMinus30: scoreAtPose(-30), atZero: scoreAtPose(0) };
  });
  console.log('\n=== rot=+30 sign check ===');
  console.log(JSON.stringify(signReport, null, 1));

  // --- probe 2: occluder synthetic (currently failing case) ---
  const occluderUrl = await page.evaluate(() => {
    // must mirror run-tests.js pageMakeSyntheticPhoto (incl. GT transform fix)
    const spec2 = { umPerPx: 6.0, rotDeg: 2.5, cx: 320, cy: -180, seed: 22 };
    function rngFactory(seed) { let s = seed >>> 0; return function () { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
    const r = rngFactory(spec2.seed);
    const S = 1200;
    const feat = document.createElement('canvas'); feat.width = S; feat.height = S;
    const fx = feat.getContext('2d');
    fx.fillStyle = '#fff'; fx.fillRect(0, 0, S, S);
    const k = 1 / spec2.umPerPx, th = spec2.rotDeg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    const e = S / 2 - k * (c * spec2.cx - s * spec2.cy);
    const f = S / 2 + k * (s * spec2.cx + c * spec2.cy);
    fx.setTransform(k * c, -k * s, -k * s, -k * c, e, f);
    fx.fillStyle = '#4a4640';
    allFeatures.forEach(function (fl) {
      if (fl.get('isDrawn') || fl.get('visible') === false) return;
      const ring = fl.getGeometry().getCoordinates()[0];
      if (!ring || ring.length < 3) return;
      fx.beginPath();
      for (let i = 0; i < ring.length; i++) { if (i === 0) fx.moveTo(ring[i][0], ring[i][1]); else fx.lineTo(ring[i][0], ring[i][1]); }
      fx.closePath(); fx.fill();
    });
    const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#d6d2c8'; ctx.fillRect(0, 0, S, S);
    ctx.filter = 'blur(0.8px)'; ctx.drawImage(feat, 0, 0); ctx.filter = 'none';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const fxp = S * (0.30 + 0.4 * r()), fyp = S * (0.30 + 0.4 * r());
    const nn = 10, baseR = S * (0.10 + 0.05 * r());
    ctx.beginPath();
    for (let i = 0; i < nn; i++) { const ang = (i / nn) * 2 * Math.PI; const rad = baseR * (0.55 + 0.6 * r()); const px = fxp + rad * Math.cos(ang), py = fyp + rad * Math.sin(ang) * 0.8; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(72,82,165,0.85)'; ctx.fill();
    ctx.strokeStyle = 'rgba(28,38,115,0.95)'; ctx.lineWidth = 2.5; ctx.stroke();
    const oxp = S * (0.25 + 0.5 * r()), oyp = S * (0.25 + 0.5 * r());
    ctx.fillStyle = 'rgba(214,196,120,0.8)';
    for (let i = 0; i < 7; i++) { ctx.beginPath(); ctx.arc(oxp + (r() - 0.5) * S * 0.22, oyp + (r() - 0.5) * S * 0.22, S * (0.03 + 0.05 * r()), 0, 2 * Math.PI); ctx.fill(); }
    for (let i = 0; i < 90; i++) {
      const dark = r() > 0.5;
      ctx.fillStyle = dark ? 'rgba(60,55,50,0.7)' : 'rgba(245,243,238,0.8)';
      ctx.beginPath(); ctx.arc(r() * S, r() * S, 0.5 + 2.2 * r(), 0, 2 * Math.PI); ctx.fill();
    }
    const id = ctx.getImageData(0, 0, S, S); const d = id.data;
    for (let i = 0; i < d.length; i += 4) { const nz = (r() - 0.5) * 16; d[i] += nz; d[i + 1] += nz; d[i + 2] += nz; }
    ctx.putImageData(id, 0, 0);
    return cv.toDataURL('image/jpeg', 0.88);
  });
  console.log('\n=== occluder synthetic (gt 6.0um/px, +2.5deg, (320,-180)) ===');
  console.log(JSON.stringify(await runAlign(occluderUrl, 'dbg-occl', null), null, 1));

  await browser.close();
  srv.close();
})().catch((e) => { console.error('fatal:', e); process.exit(2); });
