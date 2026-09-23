#!/usr/bin/env node
// Anchor-based fit: measure the BIG PAD (350x350 um, unique large dark blob)
// in the photo -> exact scale + position seed -> engine refine/polish/sweep.
// This is what the fixture was designed for: unique non-periodic anchors.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8821;
const MIME = { '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };

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
  const cands = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
  for (const c of cands) { try { fs.accessSync(c); return c; } catch { /* next */ } }
  throw new Error('no browser');
}

(async function main() {
  const srv = await startServer();
  const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, protocolTimeout: 300000, args: ['--no-first-run'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (/FIT-DEBUG/.test(m.text())) console.log('[page]', m.text()); });
  await page.setViewport({ width: 1280, height: 900 });
  const data = process.argv[2] || '../test/fixtures/jj_pad_center_50_geo';
  await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=${data}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures && window.allFeatures.length > 100, { timeout: 30000, polling: 100 });

  const out = await page.evaluate(async () => {
    const resp = await fetch('../test/fixtures/jj_pad_center_photo.png');
    const buf = await resp.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    insertMicroImage('data:image/png;base64,' + btoa(binary), 'jj_photo.png');
    await new Promise((res) => { const t0 = Date.now(); (function poll() { microImg ? res() : (Date.now() - t0 > 10000 ? res() : setTimeout(poll, 30)); })(); });
    const img = microImg.img;
    const W = img.naturalWidth, H = img.naturalHeight;

    // --- find the big pad: largest dark connected blob ---
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, W, H).data;
    const gray = new Float32Array(W * H);
    let mean = 0;
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) { gray[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; mean += gray[i]; }
    mean /= gray.length;
    const dark = new Uint8Array(W * H);
    for (let i = 0; i < gray.length; i++) dark[i] = gray[i] < mean - 25 ? 1 : 0;
    // largest connected component (iterative flood fill)
    const lbl = new Int32Array(W * H);
    let bestSz = 0, bestMin = [0, 0], bestMax = [0, 0], bestC = [0, 0], next = 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i0 = y * W + x;
      if (!dark[i0] || lbl[i0]) continue;
      const stack = [i0]; lbl[i0] = next;
      let sz = 0, sx = 0, sy = 0, mnx = W, mxx = 0, mny = H, mxy = 0;
      while (stack.length) {
        const q = stack.pop(); const qx = q % W, qy = (q / W) | 0;
        sz++; sx += qx; sy += qy;
        if (qx < mnx) mnx = qx; if (qx > mxx) mxx = qx;
        if (qy < mny) mny = qy; if (qy > mxy) mxy = qy;
        const nb = [q - 1, q + 1, q - W, q + W];
        for (const n of nb) {
          if (n < 0 || n >= W * H) continue;
          const nx = n % W;
          if ((n === q - 1 && nx === W - 1) || (n === q + 1 && nx === 0)) continue;
          if (dark[n] && !lbl[n]) { lbl[n] = next; stack.push(n); }
        }
      }
      if (sz > bestSz) { bestSz = sz; bestMin = [mnx, mny]; bestMax = [mxx, mxy]; bestC = [sx / sz, sy / sz]; }
      next++;
    }
    const padW = bestMax[0] - bestMin[0], padH = bestMax[1] - bestMin[1];
    console.log('FIT-DEBUG bigpad blob: sz', bestSz, 'bbox', bestMin, bestMax, 'center', bestC.map(function (v) { return v.toFixed(1); }));
    const umPerPx = 350 / Math.max(padW, padH);   // design pad is 350x350
    console.log('FIT-DEBUG scale from pad:', umPerPx.toFixed(4), 'um/px (pad ' + padW + 'x' + padH + ' px)');

    // pose from anchor: big pad center in photo (u,v) <-> design (-100,-1550)
    const du = bestC[0] - W / 2, dv = bestC[1] - H / 2;
    const cx = -100 - du * umPerPx, cy = -1550 + dv * umPerPx;  // rot 0 assumed
    console.log('FIT-DEBUG anchor pose: cx', cx.toFixed(1), 'cy', cy.toFixed(1));

    let best = null;
    for (const rot0 of [0, 1, -1, 2, -2]) {
      let r = refineCandidate({ score: 0, cx: cx, cy: cy, umPerPx: umPerPx, rotDeg: rot0, _hiRes: true }, false);
      if (r.fwdScore < 0.05) continue;
      r = multiWindowPolish(r);
      r = magnificationSweep(r);
      if (!best || r.score > best.score) best = r;
      console.log('FIT-DEBUG rot', rot0, '-> score', +r.score.toFixed(3), 'fwd', +(r.fwdScore || 0).toFixed(3), 'cov', +(r.coverage || 0).toFixed(2), 'um', +r.umPerPx.toFixed(4), 'rot', +r.rotDeg.toFixed(2), 'pos', +r.cx.toFixed(1), +r.cy.toFixed(1));
    }
    if (!best) return { error: 'no basin from anchor' };

    microImg.cx = best.cx; microImg.cy = best.cy; microImg.umPerPx = best.umPerPx; microImg.rotDeg = best.rotDeg;
    // overlay render
    const S = 900;
    const cv2 = document.createElement('canvas'); cv2.width = S; cv2.height = S;
    const c2 = cv2.getContext('2d');
    c2.fillStyle = '#222'; c2.fillRect(0, 0, S, S);
    const k = S / Math.max(W, H);
    const px = (S - W * k) / 2, py = (S - H * k) / 2;
    c2.drawImage(img, px, py, W * k, H * k);
    const u0 = best.umPerPx, rad = best.rotDeg * Math.PI / 180;
    const cc = Math.cos(rad), ss = Math.sin(rad);
    const colors = { '8/0': 'rgba(255,60,60,0.95)', '9/0': 'rgba(255,210,70,0.95)', '1/0': 'rgba(120,170,255,0.7)', '4/0': 'rgba(60,255,120,1)' };
    const order = { '1/0': 0, '9/0': 1, '8/0': 2, '4/0': 3 };
    const polys = allFeatures.map(function (f) { return { l: f.get('layer'), ring: f.getGeometry().getCoordinates()[0] }; })
      .sort(function (a, b) { return (order[a.l] ?? 9) - (order[b.l] ?? 9); });
    for (const p of polys) {
      if (!p.ring) continue;
      c2.strokeStyle = colors[p.l] || '#fff';
      c2.lineWidth = p.l === '4/0' ? 2.2 : 1;
      c2.beginPath();
      for (let i = 0; i < p.ring.length; i++) {
        const dx = p.ring[i][0] - best.cx, dy = p.ring[i][1] - best.cy;
        const X = px + (W / 2 + (cc * dx - ss * dy) / u0) * k;
        const Y = py + (H / 2 + (-ss * dx - cc * dy) / u0) * k;
        if (i === 0) c2.moveTo(X, Y); else c2.lineTo(X, Y);
      }
      c2.closePath(); c2.stroke();
    }
    // small pad position in photo px
    const ddx = -100 - best.cx, ddy = -50 - best.cy;
    const padPx = [W / 2 + (cc * ddx - ss * ddy) / u0, H / 2 + (-ss * ddx - cc * ddy) / u0];
    return {
      best: { score: +best.score.toFixed(3), fwd: +best.fwdScore.toFixed(3), cov: +best.coverage.toFixed(3),
              umPerPx: +best.umPerPx.toFixed(4), rotDeg: +best.rotDeg.toFixed(3), cx: +best.cx.toFixed(2), cy: +best.cy.toFixed(2) },
      padPx: [+padPx[0].toFixed(1), +padPx[1].toFixed(1)],
      overlay: cv2.toDataURL('image/png'),
    };
  });

  if (out.error) { console.log('ERROR:', out.error); }
  else {
    console.log(JSON.stringify(out.best, null, 1));
    console.log('design small pad (-100,-50) -> photo px:', JSON.stringify(out.padPx), '(photo 568x589, center 284x294.5)');
    fs.writeFileSync(path.join(__dirname, 'out', 'jj_photo_fit.png'), Buffer.from(out.overlay.split(',')[1], 'base64'));
    console.log('wrote jj_photo_fit.png');
  }
  await browser.close();
  srv.close();
})().catch((e) => { console.error('fatal:', e); process.exit(2); });
