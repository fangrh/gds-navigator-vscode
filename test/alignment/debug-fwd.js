#!/usr/bin/env node
// Throwaway probe: fwd scores at specific poses, hiRes vs screening.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const ROOT = path.join(__dirname, '..', '..');
const PORT = 8797;
const MIME = { '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((req, rsp) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rsp.writeHead(400); rsp.end(); return; }
  const fp = path.normalize(path.join(ROOT, p));
  if (!fp.startsWith(ROOT)) { rsp.writeHead(403); rsp.end(); return; }
  fs.readFile(fp, (e, d) => {
    if (e) { rsp.writeHead(404); rsp.end(); return; }
    rsp.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'app/oct' });
    rsp.end(d);
  });
});
srv.listen(PORT, '127.0.0.1', async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.GDS_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, args: ['--no-first-run'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:' + PORT + '/webview/test-standalone.html?data=../test/fixtures/chip285_markers_geo', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures && window.allFeatures.length > 100, { timeout: 30000, polling: 100 });
  const realDataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'nbse2_sample1-1_micro.jpg')).toString('base64');
  const out = await page.evaluate(async (realUrl) => {
    insertMicroImage(realUrl, 'probe.jpg');
    await new Promise((res) => { const t0 = Date.now(); (function p() { microImg ? res() : (Date.now() - t0 > 8000 ? res() : setTimeout(p, 30)); })(); });
    function fwdAt(cxx, cyy, um, r0, hi, sigOverride) {
      const img = microImg.img;
      const m = hi ? 0.62 : 0.85;
      const Rx = img.naturalWidth * um * m + 5, Ry = img.naturalHeight * um * m + 5;
      const region = [cxx - Rx, cyy - Ry, cxx + Rx, cyy + Ry];
      const FW = hi ? 960 : 384, FH = Math.max(48, Math.round(FW * (region[3] - region[1]) / (region[2] - region[0])));
      const L = layoutEdgeMap(region, FW, FH);
      const D = layoutOrientedDistMaps(L, FW, FH);
      const pts = imageEdgePoints(region, FW, FH, cxx, cyy, um, r0, 6000);
      const sig = sigOverride || 1.0;
      const f0 = scoreChamfer(D, FW, FH, pts, 0, 0, sig);
      let best = -1, bd = null;
      for (let dy = -6; dy <= 6; dy += 2) for (let dx = -6; dx <= 6; dx += 2) {
        const s = scoreChamfer(D, FW, FH, pts, dx, dy, sig);
        if (s.score > best) { best = s.score; bd = [dx, dy]; }
      }
      return { n: (pts.length / 3) | 0, fwd0: +f0.score.toFixed(4), best: +best.toFixed(4), bd };
    }
    return {
      trueHyp_hi_s12: fwdAt(157, 346, 5.9, 0, true, 1.2),
      trueHyp_hi_s18: fwdAt(157, 346, 5.9, 0, true, 1.8),
      winner_hi_s18: fwdAt(1281.38, -1074.99, 5.9329, 0, true, 1.8),
      center_hi_s18: fwdAt(0, 0, 6.0, 0, true, 1.8),
      shift1_hi_s18: fwdAt(357, 346, 5.9, 0, true, 1.8),
    };
  }, realDataUrl);
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  srv.close();
});
