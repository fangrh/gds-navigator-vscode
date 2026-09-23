#!/usr/bin/env node
// ARIZ step-1 validation: pose-voting curve on the jj fixture photo.
// Votes: photo blob pairs x layout marker nodes -> (s, theta) buckets, best
// translation-bucket vote count per scale. PASS = sharp peak at ~2.1 um/px
// (>=8 votes), <=3 votes near 17.9.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.join(__dirname, '..', '..'), PORT = 8830;
const srv = http.createServer((q, r) => { const fp = path.normalize(path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname))); fs.readFile(fp, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200); r.end(d); }); });
srv.listen(PORT, '127.0.0.1', async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-first-run'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (/^VOTE/.test(m.text())) console.log(m.text()); });
  await page.goto('http://127.0.0.1:' + PORT + '/webview/test-standalone.html?data=../test/fixtures/jj_pad_center_50_geo', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures && window.allFeatures.length > 100, { timeout: 30000, polling: 100 });
  const out = await page.evaluate(async () => {
    // layout marker-node table (snap feature centers to 200um lattice)
    const nodes = new Map();
    allFeatures.forEach(function (f) {
      if (f.get('isDrawn') || f.get('visible') === false) return;
      const e = f.getGeometry().getExtent();
      const cxm = (e[0] + e[2]) / 2, cym = (e[1] + e[3]) / 2;
      const i = Math.round(cxm / 200), j = Math.round(cym / 200);
      nodes.set(i + ',' + j, [i * 200, j * 200]);
    });
    const nodeList = Array.from(nodes.values());
    // photo blobs (512 canvas, bright local maxima + centroid)
    const img = new Image(); img.src = '/test/fixtures/jj_pad_center_photo.png'; await img.decode();
    const W = 512, H = 512;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cx2 = cv.getContext('2d'); cx2.drawImage(img, 0, 0, W, H);
    const d = cx2.getImageData(0, 0, W, H).data;
    const gray = new Float32Array(W * H); let mean = 0;
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) { gray[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; mean += gray[i]; }
    mean /= gray.length;
    const blobs = [];
    for (let y = 5; y < H - 5; y++) for (let x = 5; x < W - 5; x++) {
      const v = gray[y * W + x];
      if (v < mean + 18) continue;
      let isMax = true;
      for (let dy = -3; dy <= 3 && isMax; dy++) for (let dx = -3; dx <= 3; dx++) { if ((dx || dy) && gray[(y + dy) * W + x + dx] > v) { isMax = false; break; } }
      if (!isMax) continue;
      let sw = 0, sx = 0, sy = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const w = gray[(y + dy) * W + x + dx] - mean; sw += w; sx += (x + dx) * w; sy += (y + dy) * w; }
      blobs.push([sx / sw, sy / sw]);
      for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && xx < W && yy >= 0 && yy < H) gray[yy * W + xx] = -1e9; }
    }
    blobs.sort((a, b) => 0);
    const top = blobs.slice(0, 40);
    // vote curve: per scale (rot assumed ~0 for speed; theta voting next step)
    const results = [];
    for (let si = 3; si <= 185; si++) {           // 0.3 .. 18.5 um/px (step 0.1)
      const s = si / 10;
      const acc = new Map();
      for (const b of top) {
        const bu = (b[0] - W / 2) * s, bv = -(b[1] - H / 2) * s;
        for (const nd of nodeList) {
          const tx = nd[0] - bu, ty = nd[1] - bv;
          if (Math.abs(tx) > 2600 || Math.abs(ty) > 2600) continue;
          const k = Math.round(tx / 20) + ',' + Math.round(ty / 20);
          acc.set(k, (acc.get(k) || 0) + 1);
        }
      }
      let best = 0;
      for (const v of acc.values()) if (v > best) best = v;
      results.push([s, best]);
    }
    return { nNodes: nodeList.length, nBlobs: top.length, curve: results };
  });
  const curve = out.curve;
  const peak = curve.reduce((a, b) => (b[1] > a[1] ? b : a));
  const at179 = curve.filter(r => Math.abs(r[0] - 17.9) < 0.35).map(r => r[1]);
  console.log('nodes:', out.nNodes, 'blobs:', out.nBlobs);
  console.log('PEAK: s=' + peak[0].toFixed(2) + 'um/px votes=' + peak[1]);
  console.log('near 17.9:', JSON.stringify(at179));
  console.log('curve(s:votes):', curve.filter((r, i) => i % 4 === 0).map(r => r[0].toFixed(1) + ':' + r[1]).join(' '));
  await browser.close(); srv.close();
});
