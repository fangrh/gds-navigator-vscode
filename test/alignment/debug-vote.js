#!/usr/bin/env node
// Prototype of Hough pose voting (fingerprint-minutiae / star-tracker style)
// for the real fixture photo. Independent of the engine flow: detect blob
// centers in the photo, vote (blob x design-node) correspondences into a
// translation accumulator per scale, and report the winning pose.
// Success criterion: votes concentrate at scale ~= 0.466 um/px and
// translation ~= (3, 28) um — the visually confirmed ground truth.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8798;
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
  page.on('console', (m) => { if (/^VOTE/.test(m.text())) console.log('[page]', m.text()); });
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=../test/fixtures/chip285_markers_geo`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures && window.allFeatures.length > 100, { timeout: 30000, polling: 100 });

  const report = await page.evaluate(async () => {
    const realUrl = '../test/fixtures/nbse2_sample1-1_micro.jpg'.replace('../', '../'); // not fetched; use canvas path below
    // fetch the real photo
    const resp = await fetch('../test/fixtures/nbse2_sample1-1_micro.jpg');
    const buf = await resp.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const dataUrl = 'data:image/jpeg;base64,' + btoa(binary);
    insertMicroImage(dataUrl, 'vote.jpg');
    await new Promise((res) => { const t0 = Date.now(); (function poll() { microImg ? res() : (Date.now() - t0 > 8000 ? res() : setTimeout(poll, 30)); })(); });
    const img = microImg.img;

    // --- occupied 200um design nodes (centers of all features, snapped) ---
    const nodes = new Map(); // "i,j" -> [x,y]
    allFeatures.forEach(function (f) {
      if (f.get('isDrawn') || f.get('visible') === false) return;
      const ring = f.getGeometry().getCoordinates()[0];
      if (!ring || ring.length < 3) return;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = 0; i < ring.length; i++) {
        x0 = Math.min(x0, ring[i][0]); x1 = Math.max(x1, ring[i][0]);
        y0 = Math.min(y0, ring[i][1]); y1 = Math.max(y1, ring[i][1]);
      }
      const i = Math.round(((x0 + x1) / 2) / 200), j = Math.round(((y0 + y1) / 2) / 200);
      const k2 = i + ',' + j;
      if (!nodes.has(k2)) nodes.set(k2, [i * 200, j * 200]);
    });
    const nodeList = Array.from(nodes.values());
    console.log('VOTE design nodes: ' + nodeList.length);

    // --- photo blob detection at 512 (grayscale local maxima) ---
    const W = 512, H = 512;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cx2 = cv.getContext('2d');
    cx2.drawImage(img, 0, 0, W, H);
    const d = cx2.getImageData(0, 0, W, H).data;
    const gray = new Float32Array(W * H);
    let mean = 0;
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) { gray[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; mean += gray[i]; }
    mean /= gray.length;
    let sd = 0;
    for (let i = 0; i < gray.length; i++) sd += (gray[i] - mean) * (gray[i] - mean);
    sd = Math.sqrt(sd / gray.length);
    const blobs = [];
    for (let y = 4; y < H - 4; y++) {
      for (let x = 4; x < W - 4; x++) {
        const v = gray[y * W + x];
        if (v < mean + 2.2 * sd) continue;
        let isMax = true;
        for (let dy = -3; dy <= 3 && isMax; dy++) for (let dx = -3; dx <= 3; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (gray[(y + dy) * W + (x + dx)] > v) { isMax = false; break; }
        }
        if (isMax) {
          // sub-pixel centroid in 3px window
          let sw = 0, sx = 0, sy = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const wgt = gray[(y + dy) * W + (x + dx)] - mean;
            sw += wgt; sx += (x + dx) * wgt; sy += (y + dy) * wgt;
          }
          blobs.push([sx / sw, sy / sw, v - mean]);
          for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && xx < W && yy >= 0 && yy < H) gray[yy * W + xx] = -1e9;
          }
        }
      }
    }
    blobs.sort(function (a, b) { return b[2] - a[2]; });
    const top = blobs.slice(0, 40);
    console.log('VOTE photo blobs: ' + top.length);

    // --- voting per scale hypothesis ---
    // photo px (u,v) -> um offset at scale s, rot 0: ( (u-W/2)*s, -(v-H/2)*s )
    // blob i on node j  =>  image-center t = node_j - offset_i. Vote in 20um bins.
    const results = [];
    for (let si = 42; si <= 52; si++) {
      const s = si / 100; // um/px 0.42..0.52
      const acc = new Map();
      for (let bi = 0; bi < top.length; bi++) {
        const bu = (top[bi][0] - W / 2) * s, bv = -(top[bi][1] - H / 2) * s;
        for (let nj = 0; nj < nodeList.length; nj++) {
          const tx = nodeList[nj][0] - bu, ty = nodeList[nj][1] - bv;
          if (Math.abs(tx) > 4600 || Math.abs(ty) > 4600) continue;
          const k2 = Math.round(tx / 20) + ',' + Math.round(ty / 20);
          acc.set(k2, (acc.get(k2) || 0) + 1);
        }
      }
      let bk = null, bv2 = 0;
      for (const [k2, v] of acc) if (v > bv2) { bv2 = v; bk = k2; }
      if (!bk) continue;
      const parts = bk.split(',');
      // refine: mean translation over votes in peak bin
      let sx = 0, sy = 0, n = 0;
      for (let bi = 0; bi < top.length; bi++) {
        const bu = (top[bi][0] - W / 2) * s, bv = -(top[bi][1] - H / 2) * s;
        for (let nj = 0; nj < nodeList.length; nj++) {
          const tx = nodeList[nj][0] - bu, ty = nodeList[nj][1] - bv;
          if (Math.abs(tx - (+parts[0]) * 20) <= 10 && Math.abs(ty - (+parts[1]) * 20) <= 10) { sx += tx; sy += ty; n++; }
        }
      }
      results.push({ s: s, cx: +(sx / n).toFixed(1), cy: +(sy / n).toFixed(1), votes: bv2, blobs: top.length });
    }
    results.sort(function (a, b) { return b.votes - a.votes; });
    return results.slice(0, 5);
  });
  console.log(JSON.stringify(report, null, 1));
  console.log('GT check: expect scale ~0.4657, center ~ (3, 28)');
  await browser.close();
  srv.close();
})().catch((e) => { console.error('fatal:', e); process.exit(2); });
