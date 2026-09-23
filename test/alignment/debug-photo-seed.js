#!/usr/bin/env node
// Seed-based fit of the device photo onto the jj fixture: scale seeds from
// (layout pitch x photo pitch), then the verified refine/polish/sweep chain
// inside each seed's basin. Reports the best pose, the overlay, and where the
// design's small pad lands in photo pixels.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8820;
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
  const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--no-first-run'] });
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

    const pitchL = estimateLayoutPitch();
    const pitchP = estimateImagePitches();
    console.log('FIT-DEBUG pitchL(um):', JSON.stringify(pitchL), ' pitchP(px):', JSON.stringify(pitchP));
    // layout region (same rule as autoAlignMicroImage)
    var rx = Infinity, ry = Infinity, RX = -Infinity, RY = -Infinity;
    allFeatures.forEach(function (f) {
      if (f.get('isDrawn')) return;
      var e = f.getGeometry().getExtent();
      rx = Math.min(rx, e[0]); ry = Math.min(ry, e[1]);
      RX = Math.max(RX, e[2]); RY = Math.max(RY, e[3]);
    });
    var mx = (RX - rx) * 0.2 + 1, my = (RY - ry) * 0.2 + 1;
    var region = [rx - mx, ry - my, RX + mx, RY + my];
    var regionW = region[2] - region[0];
    var cx0 = (region[0] + region[2]) / 2, cy0 = (region[1] + region[3]) / 2;
    var pxPerUmC = COARSE_CONTENT / regionW;

    // scale seeds: ladder around the visual estimate (photo shows the 200um
    // marker grid at ~57px -> ~3.5 um/px)
    const seeds = [0.40, 0.44, 0.48];
    const lay = coarseLayoutFFT(region);
    let best = null;
    for (const s0 of seeds) {
      for (const rot0 of [0]) {
        const B = coarseImageFFT(region, cx0, cy0, s0, rot0);
        if (B.nPts < 25) continue;
        const pks = coarseCorrelate(lay, B, 1);
        for (const pk of pks) {
          let ddx = pk[1], ddy = pk[2];
          if (ddx > COARSE_PX / 2) ddx -= COARSE_PX;
          if (ddy > COARSE_PX / 2) ddy -= COARSE_PX;
          const cand = { score: 0, cx: cx0 + ddx / pxPerUmC, cy: cy0 - ddy / pxPerUmC, umPerPx: s0, rotDeg: rot0 };
          let r = refineCandidate(cand, true);
          if (r.fwdScore < 0.05) continue;
          r = refineCandidate({ score: 0, cx: r.cx, cy: r.cy, umPerPx: r.umPerPx, rotDeg: r.rotDeg, _hiRes: true }, false);
          r = multiWindowPolish(r);
          if (!best || r.score > best.score) best = r;
          console.log('FIT-DEBUG seed', s0.toFixed(1), 'rot', rot0, 'pk', pk[0] | 0, '-> score', +r.score.toFixed(3), 'fwd', +(r.fwdScore || 0).toFixed(3), 'cov', +(r.coverage || 0).toFixed(2), 'um', +r.umPerPx.toFixed(3), 'rot', +r.rotDeg.toFixed(2), 'pos', Math.round(r.cx), Math.round(r.cy));
        }
      }
    }
    if (!best) return { error: 'no basin' };
    console.log('FIT-DEBUG BEST:', JSON.stringify({ score: +best.score.toFixed(3), fwd: +best.fwdScore.toFixed(3), cov: +best.coverage.toFixed(3), umPerPx: +best.umPerPx.toFixed(4), rotDeg: +best.rotDeg.toFixed(3), cx: +best.cx.toFixed(2), cy: +best.cy.toFixed(2) }));

    // apply and render overlay
    microImg.cx = best.cx; microImg.cy = best.cy; microImg.umPerPx = best.umPerPx; microImg.rotDeg = best.rotDeg;
    const img = microImg.img;
    const S = 900;
    const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#222'; ctx.fillRect(0, 0, S, S);
    const k = S / Math.max(img.naturalWidth, img.naturalHeight);
    const px = (S - img.naturalWidth * k) / 2, py = (S - img.naturalHeight * k) / 2;
    ctx.drawImage(img, px, py, img.naturalWidth * k, img.naturalHeight * k);
    const u0 = best.umPerPx, rad = best.rotDeg * Math.PI / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const colors = { '8/0': 'rgba(255,60,60,0.95)', '9/0': 'rgba(255,210,70,0.95)', '1/0': 'rgba(120,170,255,0.75)', '4/0': 'rgba(60,255,120,1)' };
    const order = { '1/0': 0, '9/0': 1, '8/0': 2, '4/0': 3 };
    const polys = allFeatures.map(function (f) { return { l: f.get('layer'), ring: f.getGeometry().getCoordinates()[0] }; })
      .sort(function (a, b) { return (order[a.l] ?? 9) - (order[b.l] ?? 9); });
    for (const p of polys) {
      if (!p.ring) continue;
      ctx.strokeStyle = colors[p.l] || '#fff';
      ctx.lineWidth = p.l === '4/0' ? 2.2 : 1;
      ctx.beginPath();
      for (let i = 0; i < p.ring.length; i++) {
        const dx = p.ring[i][0] - best.cx, dy = p.ring[i][1] - best.cy;
        const X = px + (img.naturalWidth / 2 + (c * dx - s * dy) / u0) * k;
        const Y = py + (img.naturalHeight / 2 + (-s * dx - c * dy) / u0) * k;
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.closePath(); ctx.stroke();
    }
    // design small pad center in photo px
    const ddx = -100 - best.cx, ddy = -50 - best.cy;
    const padPx = [img.naturalWidth / 2 + (c * ddx - s * ddy) / u0, img.naturalHeight / 2 + (-s * ddx - c * ddy) / u0];
    return {
      best: { score: +best.score.toFixed(3), fwd: +best.fwdScore.toFixed(3), cov: +best.coverage.toFixed(3),
              umPerPx: +best.umPerPx.toFixed(4), rotDeg: +best.rotDeg.toFixed(3), cx: +best.cx.toFixed(2), cy: +best.cy.toFixed(2) },
      padPx: [+padPx[0].toFixed(1), +padPx[1].toFixed(1)],
      overlay: cv.toDataURL('image/png'),
    };
  });

  console.log(JSON.stringify(out.best || out, null, 1));
  if (out.padPx) console.log('design small pad (-100,-50) -> photo px:', JSON.stringify(out.padPx), '(photo 568x589, center 284x294)');
  if (out.overlay) {
    fs.writeFileSync(path.join(__dirname, 'out', 'jj_photo_fit.png'), Buffer.from(out.overlay.split(',')[1], 'base64'));
    console.log('wrote jj_photo_fit.png');
  }
  await browser.close();
  srv.close();
})().catch((e) => { console.error('fatal:', e); process.exit(2); });
