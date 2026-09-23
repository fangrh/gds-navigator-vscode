#!/usr/bin/env node
// Align the real device photo (jj_pad_center_photo.png) onto the
// jj_pad_center_50 fixture via the engine's autoAlignMicroImage(), then:
//  - report the pose + metrics,
//  - render photo + layout overlay at the aligned pose,
//  - map the design's small pad (-100,-50) into photo pixels and report the
//    residual vs. the photo's visible small pad (marker-gap center).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8819;
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
  page.on('console', (m) => { if (/ALIGN-DEBUG/.test(m.text())) console.log('[page]', m.text()); });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=../test/fixtures/jj_pad_center_50_geo`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures && window.allFeatures.length > 100, { timeout: 30000, polling: 100 });

  const out = await page.evaluate(async () => {
    const resp = await fetch('../test/fixtures/jj_pad_center_photo.png');
    const buf = await resp.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const dataUrl = 'data:image/png;base64,' + btoa(binary);
    insertMicroImage(dataUrl, 'jj_photo.png');
    await new Promise((res) => { const t0 = Date.now(); (function poll() { microImg ? res() : (Date.now() - t0 > 10000 ? res() : setTimeout(poll, 30)); })(); });
    window.__sent.length = 0;
    const t0 = Date.now();
    await autoAlignMicroImage();
    const aligned = window.__sent.filter((m) => m.type === 'imageAligned').pop() || null;

    // overlay render at the aligned pose
    let overlay = null;
    if (microImg) {
      const img = microImg.img;
      const S = 900;
      const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#222'; ctx.fillRect(0, 0, S, S);
      // photo fills the square along its larger side, centered
      const k = S / Math.max(img.naturalWidth, img.naturalHeight);
      const px = (S - img.naturalWidth * k) / 2, py = (S - img.naturalHeight * k) / 2;
      ctx.drawImage(img, px, py, img.naturalWidth * k, img.naturalHeight * k);
      // layout edges at pose: photo px (u,v) -> um: ((u-w/2)*s*? ) engine convention:
      // um offset = R(theta) applied... inverse: u = k'*(c*dx - s*dy)/umPerPx + w/2*k ; v = k'*(-s*dx - c*dy)/umPerPx + h/2*k
      const u0 = microImg.umPerPx, rad = microImg.rotDeg * Math.PI / 180;
      const c = Math.cos(rad), s = Math.sin(rad);
      const colors = { '8/0': 'rgba(255,60,60,0.95)', '9/0': 'rgba(255,210,70,0.95)', '1/0': 'rgba(120,170,255,0.8)', '4/0': 'rgba(60,255,120,0.95)' };
      const order = { '1/0': 0, '9/0': 1, '8/0': 2, '4/0': 3 };
      const polys = allFeatures.map(function (f) {
        return { l: f.get('layer'), ring: f.getGeometry().getCoordinates()[0] };
      }).sort(function (a, b) { return (order[a.l] ?? 9) - (order[b.l] ?? 9); });
      for (const p of polys) {
        if (!p.ring) continue;
        ctx.strokeStyle = colors[p.l] || '#fff';
        ctx.lineWidth = p.l === '4/0' ? 2 : 1;
        ctx.beginPath();
        for (let i = 0; i < p.ring.length; i++) {
          const dx = p.ring[i][0] - microImg.cx, dy = p.ring[i][1] - microImg.cy;
          const X = px + (img.naturalWidth / 2 + (c * dx - s * dy) / u0) * k;
          const Y = py + (img.naturalHeight / 2 + (-s * dx - c * dy) / u0) * k;
          if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        }
        ctx.closePath(); ctx.stroke();
      }
      overlay = cv.toDataURL('image/png');

      // design small pad (-100,-50) position in ORIGINAL photo px
      const dx = -100 - microImg.cx, dy = -50 - microImg.cy;
      const padPx = [img.naturalWidth / 2 + (c * dx - s * dy) / u0,
                     img.naturalHeight / 2 + (-s * dx - c * dy) / u0];
      return { aligned, elapsedMs: Date.now() - t0, padPx: [+padPx[0].toFixed(1), +padPx[1].toFixed(1)],
               imgSize: [img.naturalWidth, img.naturalHeight], overlay };
    }
    return { aligned, elapsedMs: Date.now() - t0, overlay };
  });

  console.log('aligned:', JSON.stringify(out.aligned, null, 1));
  console.log('elapsed:', (out.elapsedMs / 1000).toFixed(1) + 's');
  if (out.padPx) console.log('design small pad (-100,-50) maps to photo px:', JSON.stringify(out.padPx), 'of', JSON.stringify(out.imgSize));
  if (out.overlay) {
    fs.writeFileSync(path.join(__dirname, 'out', 'jj_photo_aligned.png'), Buffer.from(out.overlay.split(',')[1], 'base64'));
    console.log('wrote jj_photo_aligned.png');
  }
  await browser.close();
  srv.close();
})().catch((e) => { console.error('fatal:', e); process.exit(2); });
