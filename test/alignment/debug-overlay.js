#!/usr/bin/env node
// Visual diagnostic: renders layout-over-photo overlays for candidate poses
// of the real fixture photo into test/alignment/out/*.png so alignment
// quality can be judged by eye.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8796;
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
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=../test/fixtures/chip285_markers_geo`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures && window.allFeatures.length > 100, { timeout: 30000, polling: 100 });

  const realDataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'nbse2_sample1-1_micro.jpg')).toString('base64');

  const poses = [
    // pad-derived high-mag interpretation, then snapped by the engine's hiRes refiner
    { label: 'pad-derived-0.47', umPerPx: 0.4728, rotDeg: 0, cx: 7.7, cy: 25.4 },
  ];

  const shots = await page.evaluate(async (realDataUrl2, poses2) => {
    insertMicroImage(realDataUrl2, 'ovl.jpg');
    await new Promise((res) => { const t0 = Date.now(); (function poll() { microImg ? res() : (Date.now() - t0 > 10000 ? res() : setTimeout(poll, 40)); })(); });
    const out = [];
    for (const pose of poses2) {
      // snap translation/scale/rotation with the engine's own hiRes refiner
      microImg.cx = pose.cx; microImg.cy = pose.cy;
      microImg.umPerPx = pose.umPerPx; microImg.rotDeg = pose.rotDeg;
      const ref = refineCandidate({ score: 0, cx: pose.cx, cy: pose.cy,
        umPerPx: pose.umPerPx, rotDeg: pose.rotDeg, _hiRes: true }, false);
      // magnification fit: sweep scale, re-snap translation per step
      let bestP = multiWindowPolish(ref), bestS = bestP.score;
      for (let m = 0.97; m <= 1.0301; m += 0.005) {
        let r2 = refineCandidate({ score: 0, cx: pose.cx, cy: pose.cy,
          umPerPx: pose.umPerPx * m, rotDeg: pose.rotDeg, _hiRes: true }, false);
        r2 = multiWindowPolish(r2);
        if (r2.score > bestS) { bestS = r2.score; bestP = r2; }
      }
      const P = { label: pose.label, cx: bestP.cx, cy: bestP.cy, umPerPx: bestP.umPerPx, rotDeg: bestP.rotDeg };
      console.log('REFINED ' + pose.label + ': ' + JSON.stringify({ cx: +ref.cx.toFixed(2), cy: +ref.cy.toFixed(2), umPerPx: +ref.umPerPx.toFixed(4), rotDeg: +ref.rotDeg.toFixed(3), fwd: ref.fwdScore, cov: ref.coverage }));
      const img = microImg.img;
      const S = 900;
      const cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      const ctx = cv.getContext('2d');
      const kImg = S / img.naturalWidth;
      ctx.drawImage(img, 0, 0, S, S);
      // layout edges at the pose, engine convention:
      // image px offset of um offset (dx,dy) = ((c*dx - s*dy)/u, (-s*dx - c*dy)/u)
      const u = P.umPerPx, rad = P.rotDeg * Math.PI / 180;
      const c = Math.cos(rad), s = Math.sin(rad);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = 'rgba(255,40,40,0.95)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      allFeatures.forEach(function (f) {
        if (f.get('isDrawn') || f.get('visible') === false) return;
        const ring = f.getGeometry().getCoordinates()[0];
        if (!ring || ring.length < 3) return;
        for (let i = 0; i < ring.length; i++) {
          const dx = ring[i][0] - P.cx, dy = ring[i][1] - P.cy;
          const a = (c * dx - s * dy) / u * kImg;
          const b = (-s * dx - c * dy) / u * kImg;
          const X = S / 2 + a, Y = S / 2 + b;
          if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        }
        ctx.closePath();
      });
      ctx.stroke();
      out.push({ label: pose.label, cx: +P.cx.toFixed(2), cy: +P.cy.toFixed(2), umPerPx: +P.umPerPx.toFixed(4), rotDeg: +P.rotDeg.toFixed(3), url: cv.toDataURL('image/png') });
    }
    return out;
  }, realDataUrl, poses);

  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  for (const s of shots) {
    fs.writeFileSync(path.join(outDir, s.label + '.png'), Buffer.from(s.url.split(',')[1], 'base64'));
    console.log('wrote', s.label + '.png  pose:', JSON.stringify({cx:s.cx,cy:s.cy,umPerPx:s.umPerPx,rotDeg:s.rotDeg}));
  }
  await browser.close();
  srv.close();
})().catch((e) => { console.error('fatal:', e); process.exit(2); });
