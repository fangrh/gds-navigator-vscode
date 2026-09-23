#!/usr/bin/env node
// Diagnostic: is the synthetic-photo ground truth consistent with the
// alignment engine's pose convention? Generates one synthetic photo at a
// known rotated pose and evaluates the chamfer metric EXACTLY at the GT pose
// and at the mirrored rotation, plus a small translation jitter grid.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8793;
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
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ];
  for (const c of cands) { try { fs.accessSync(c); return c; } catch { /* next */ } }
  throw new Error('no browser');
}

(async function main() {
  const srv = await startServer();
  const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--no-first-run'] });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[page]', m.text()));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=../test/fixtures/chip285_markers_geo`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures && window.allFeatures.length > 100, { timeout: 30000, polling: 100 });

  const report = await page.evaluate(async () => {
    // --- generate synthetic photo at GT pose (same code as run-tests.js) ---
    const GT = { umPerPx: 6.0, rotDeg: 3.0, cx: -150, cy: 220 };
    function rngFactory(seed) { let s = seed >>> 0; return function () { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
    const r = rngFactory(99);
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

    // --- feed it through the real pipeline ---
    insertMicroImage(cv.toDataURL('image/jpeg', 0.9), 'dbg.jpg');
    await new Promise((res) => { const t0 = Date.now(); (function poll() { microImg ? res() : (Date.now() - t0 > 5000 ? res() : setTimeout(poll, 30)); })(); });

    // local scorer identical to refineCandidate's core (single offset)
    function scoreAtPose(pose, dxUm, dyUm) {
      const img = microImg.img;
      const Rx = img.naturalWidth * pose.umPerPx * 0.85 + 5, Ry = img.naturalHeight * pose.umPerPx * 0.85 + 5;
      const cx = pose.cx + dxUm, cy = pose.cy + dyUm;
      const region = [cx - Rx, cy - Ry, cx + Rx, cy + Ry];
      const FW = 384, FH = Math.max(48, Math.round(FW * (region[3] - region[1]) / (region[2] - region[0])));
      const L = layoutEdgeMap(region, FW, FH);
      const D = layoutOrientedDistMaps(L, FW, FH);
      const pts = imageEdgePoints(region, FW, FH, cx, cy, pose.umPerPx, pose.rotDeg, 6000);
      if (pts.length < 90) return { n: pts.length, fwd: -1, best: -1 };
      let best = -1, bestD = null;
      for (let dy2 = -4; dy2 <= 4; dy2 += 2) for (let dx2 = -4; dx2 <= 4; dx2 += 2) {
        const sc = scoreChamfer(D, FW, FH, pts, dx2, dy2, 1.0);
        if (sc.score > best) { best = sc.score; bestD = [dx2, dy2]; }
      }
      const fwd0 = scoreChamfer(D, FW, FH, pts, 0, 0, 1.0);
      return { n: pts.length / 3 | 0, fwd0: +fwd0.score.toFixed(4), best: +best.toFixed(4), bestD };
    }
    const rot = (d) => ({ umPerPx: GT.umPerPx, rotDeg: GT.rotDeg + d, cx: GT.cx, cy: GT.cy });
    return {
      atGT: scoreAtPose(rot(0), 0, 0),
      atNegRot: scoreAtPose(rot(-6.0), 0, 0),
      atZero: scoreAtPose({ umPerPx: GT.umPerPx, rotDeg: 0, cx: GT.cx, cy: GT.cy }, 0, 0),
      atGTshift50: scoreAtPose(rot(0), 50, 0),
      atGTshift200: scoreAtPose(rot(0), 200, 0),
    };
  });
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  srv.close();
})().catch((e) => { console.error('fatal:', e); process.exit(2); });
