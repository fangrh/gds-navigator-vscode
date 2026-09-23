#!/usr/bin/env node
// Brute-force phase search at a FIXED (s, theta) using the global dark
// content NCC — ground-truth discovery for a real fixture photo.
// Usage: node test/alignment/debug-phase.js [jj|chip285] <umPerPx> <rotDeg>
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const WHICH = process.argv[2] || 'chip285';
const S = parseFloat(process.argv[3] || '0.466');
const TH = parseFloat(process.argv[4] || '0');
const CASES = {
  jj: { data: '../test/fixtures/jj_pad_center_50_geo', photo: 'jj_pad_center_photo.png', mime: 'png' },
  chip285: { data: '../test/fixtures/chip285_markers_geo', photo: 'nbse2_sample1-1_micro.jpg', mime: 'jpeg' },
};
const CASE = CASES[WHICH];
const PORT = 8834;

const srv = http.createServer((q, r) => {
  const fp = path.normalize(path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)));
  fs.readFile(fp, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200); r.end(d); });
});
srv.listen(PORT, '127.0.0.1', async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-standalone.js')], { stdio: 'inherit' });
  const browser = await puppeteer.launch({
    executablePath: process.env.GDS_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--no-first-run'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=${CASE.data}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures, { timeout: 30000, polling: 100 });
  const b64 = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', CASE.photo)).toString('base64');
  const out = await page.evaluate(async (dataUrl, S2, TH2) => {
    insertMicroImage(dataUrl, 'phase-probe');
    await new Promise((res) => { const t0 = Date.now(); (function poll() { if (microImg && microImg.name === 'phase-probe') res(); else if (Date.now() - t0 > 10000) res(); else setTimeout(poll, 40); })(); });
    // layout bbox
    let rx = 1e18, ry = 1e18, RX = -1e18, RY = -1e18;
    allFeatures.forEach((f) => { const e = f.getGeometry().getExtent(); rx = Math.min(rx, e[0]); ry = Math.min(ry, e[1]); RX = Math.max(RX, e[2]); RY = Math.max(RY, e[3]); });
    const img = microImg.img;
    // FFT phase probe at (S2, TH2): coarseCorrelate gives the exact
    // translation peak; report the top peak + normalized score
    let rx2 = 1e18, ry2 = 1e18, RX2 = -1e18, RY2 = -1e18;
    allFeatures.forEach((f) => { if (f.get('isDrawn')) return; const e = f.getGeometry().getExtent(); rx2 = Math.min(rx2, e[0]); ry2 = Math.min(ry2, e[1]); RX2 = Math.max(RX2, e[2]); RY2 = Math.max(RY2, e[3]); });
    const mx2 = (RX2 - rx2) * 0.2 + 1, my2 = (RY2 - ry2) * 0.2 + 1;
    const region = [rx2 - mx2, ry2 - my2, RX2 + mx2, RY2 + my2];
    const regionW = region[2] - region[0];
    window.__regionW = regionW;
    const cx0 = (region[0] + region[2]) / 2, cy0 = (region[1] + region[3]) / 2;
    const lay2 = coarseLayoutFFT(region);
    const B2 = coarseImageFFT(region, cx0, cy0, S2, TH2);
    const pxPerUmC = COARSE_CONTENT / regionW;
    const pks2 = coarseCorrelate(lay2, B2, 3);
    const fovArea = img.naturalWidth * S2 * img.naturalHeight * S2;
    const nLayInFov = lay2.nEdges * Math.min(1, fovArea / (regionW * (region[3] - region[1])));
    const norm2 = Math.sqrt(Math.max(1, B2.nPts * nLayInFov));
    const fftOut = pks2.map((pk) => {
      let dx = pk[1], dy = pk[2];
      if (dx > COARSE_PX / 2) dx -= COARSE_PX;
      if (dy > COARSE_PX / dy === 0 && dy > COARSE_PX / 2) dy -= COARSE_PX;
      return { v: +pk[0].toFixed(1), norm: +(pk[0] / norm2).toFixed(4),
               cx: Math.round(cx0 + dx / pxPerUmC), cy: Math.round(cy0 - dy / pxPerUmC) };
    });
    const sideUm = Math.min(img.naturalWidth, img.naturalHeight) * S2;
    // coarse phase grid: 100um steps within the layout (FOV-aware margin)
    const results = [];
    for (let cx = rx + sideUm / 2; cx <= RX - sideUm / 2; cx += 100) {
      for (let cy = ry + sideUm / 2; cy <= RY - sideUm / 2; cy += 100) {
        const v = _elGlobalContentNCC({ umPerPx: S2, rotDeg: TH2, cx, cy });
        results.push([+v.toFixed(4), Math.round(cx), Math.round(cy)]);
      }
    }
    results.sort((a, b) => b[0] - a[0]);
    return { S: S2, TH: TH2, fftPeaks: fftOut, nPts: B2.nPts,
             gridTop: results.slice(0, 4), grid: [Math.round(rx), Math.round(ry), Math.round(RX), Math.round(RY)], sideUm: Math.round(sideUm) };
  }, 'data:image/' + CASE.mime + ';base64,' + b64, S, TH);
  console.log(JSON.stringify(out, null, 1));
  await browser.close(); srv.close();
});
