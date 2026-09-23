#!/usr/bin/env node
// Minimal: measure the big pad (350x350 um) blob in the photo -> true scale.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const ROOT = path.join(__dirname, '..', '..');
const PORT = 8826;
const srv = http.createServer((q, r) => {
  const fp = path.normalize(path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)));
  fs.readFile(fp, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200); r.end(d); });
});
srv.listen(PORT, '127.0.0.1', async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-first-run'] });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + PORT + '/webview/test-standalone.html', { waitUntil: 'load' });
  const m = await page.evaluate(async () => {
    const img = new Image();
    img.src = '/test/fixtures/jj_pad_center_photo.png';
    await img.decode();
    const W = img.naturalWidth, H = img.naturalHeight;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, W, H).data;
    const gray = new Float32Array(W * H); let mean = 0;
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) { gray[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; mean += gray[i]; }
    mean /= gray.length;
    const dark = new Uint8Array(W * H);
    for (let i = 0; i < gray.length; i++) dark[i] = gray[i] > mean + 25 ? 1 : 0;
    const lbl = new Int32Array(W * H);
    let bestSz = 0, bestMin = [0, 0], bestMax = [0, 0], bestC = [0, 0], next = 1;
    const blobs = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i0 = y * W + x;
      if (!dark[i0] || lbl[i0]) continue;
      const stack = [i0]; lbl[i0] = next;
      let sz = 0, sx = 0, sy = 0, mnx = W, mxx = 0, mny = H, mxy = 0;
      while (stack.length) {
        const qq = stack.pop(); const qx = qq % W, qy = (qq / W) | 0;
        sz++; sx += qx; sy += qy;
        if (qx < mnx) mnx = qx; if (qx > mxx) mxx = qx;
        if (qy < mny) mny = qy; if (qy > mxy) mxy = qy;
        for (const n of [qq - 1, qq + 1, qq - W, qq + W]) {
          if (n < 0 || n >= W * H) continue;
          const nx = n % W;
          if ((n === qq - 1 && nx === W - 1) || (n === qq + 1 && nx === 0)) continue;
          if (dark[n] && !lbl[n]) { lbl[n] = next; stack.push(n); }
        }
      }
      blobs.push({ sz, min: [mnx, mny], max: [mxx, mxy] });
      if (sz > bestSz) { bestSz = sz; bestMin = [mnx, mny]; bestMax = [mxx, mxy]; bestC = [sx / sz, sy / sz]; }
      next++;
    }
    blobs.sort((a, b) => b.sz - a.sz);
    const padW = bestMax[0] - bestMin[0], padH = bestMax[1] - bestMin[1];
    return {
      photo: [W, H],
      bigPad: { bbox: [bestMin, bestMax], wPx: padW, hPx: padH, center: bestC.map(v => +v.toFixed(1)) },
      topBlobs: blobs.slice(0, 4).map(b => ({ sz: b.sz, w: b.max[0] - b.min[0], h: b.max[1] - b.min[1] })),
      umPerPxFrom350: +(350 / Math.max(padW, padH)).toFixed(4),
      fovUm: +(W * 350 / Math.max(padW, padH)).toFixed(0),
    };
  });
  console.log(JSON.stringify(m, null, 1));
  await browser.close(); srv.close();
});
