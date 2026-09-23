#!/usr/bin/env node
// FULL-AUTO alignment of the device photo with a LAYER-SELECTED reference:
// layer 4/0 (electrodes) is hidden via the legend mechanism (hidden layers
// are not alignment references), so only marker layers 1/8/9 drive the fit.
// Reports pose + perspective gain and renders the overlay THROUGH the fitted
// homography (photo backward-warped into layout space).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8824;
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
  const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, protocolTimeout: 400000, args: ['--no-first-run'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (/AUTO-DEBUG|ALIGN-DEBUG/.test(m.text())) console.log('[page]', m.text()); });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=../test/fixtures/jj_pad_center_50_geo`, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => { window.__ALIGN_VERBOSE = true; });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures && window.allFeatures.length > 100, { timeout: 30000, polling: 100 });

  const out = await page.evaluate(async () => {
    // layer selection: hide electrode layer — hidden layers are excluded from
    // the alignment reference (legend semantics, layoutEdgeMap honors it)
    let hidden = 0;
    allFeatures.forEach(function (f) {
      if (f.get('layer') === '4/0') { f.set('visible', false); hidden++; }
    });
    console.log('AUTO-DEBUG reference layers: 1/8/9 only (hid', hidden, 'electrode features)');

    const resp = await fetch('../test/fixtures/jj_pad_center_photo.png');
    const buf = await resp.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    insertMicroImage('data:image/png;base64,' + btoa(binary), 'jj_photo.png');
    await new Promise((res) => { const t0 = Date.now(); (function poll() { microImg ? res() : (Date.now() - t0 > 10000 ? res() : setTimeout(poll, 30)); })(); });
    window.__sent.length = 0;
    const t0 = Date.now();
    await autoAlignMicroImage();
    const a = window.__sent.filter((m) => m.type === 'imageAligned').pop() || null;
    console.log('AUTO-DEBUG result:', JSON.stringify(a));
    const pose = { cx: microImg.cx, cy: microImg.cy, umPerPx: microImg.umPerPx, rotDeg: microImg.rotDeg };

    // overlay THROUGH the fitted homography (backward warp photo -> layout)
    const img = microImg.img;
    const H = microImg.H || null;
    const S = 900;
    const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#222'; ctx.fillRect(0, 0, S, S);
    // window: layout um extent = pose FOV * 1.15
    const fovW = img.naturalWidth * pose.umPerPx * 1.15, fovH = img.naturalHeight * pose.umPerPx * 1.15;
    const X0 = pose.cx - fovW / 2, X1 = pose.cx + fovW / 2, Y0 = pose.cy - fovH / 2, Y1 = pose.cy + fovH / 2;
    const sc = S / Math.max(X1 - X0, Y1 - Y0);
    // draw layout fills first
    const colors = { '8/0': 'rgba(255,60,60,0.75)', '9/0': 'rgba(255,210,70,0.75)', '1/0': 'rgba(120,170,255,0.5)' };
    const order = { '1/0': 0, '9/0': 1, '8/0': 2 };
    const polys = allFeatures.map(function (f) { return { l: f.get('layer'), ring: f.getGeometry().getCoordinates()[0], vis: f.get('visible') !== false }; })
      .sort(function (a, b) { return (order[a.l] ?? 9) - (order[b.l] ?? 9); });
    for (const p of polys) {
      if (!p.ring || !p.vis) continue;
      ctx.fillStyle = colors[p.l]; if (!ctx.fillStyle) continue;
      ctx.beginPath();
      for (let i = 0; i < p.ring.length; i++) {
        const X = (p.ring[i][0] - X0) * sc, Y = S - (p.ring[i][1] - Y0) * sc;
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.closePath(); ctx.fill();
    }
    // backward-warp photo through H (or similarity fallback)
    const photoCv = document.createElement('canvas'); photoCv.width = img.naturalWidth; photoCv.height = img.naturalHeight;
    const pctx = photoCv.getContext('2d'); pctx.drawImage(img, 0, 0);
    const pd = pctx.getImageData(0, 0, photoCv.width, photoCv.height).data;
    const PW = photoCv.width, PH = photoCv.height;
    const warp = ctx.getImageData(0, 0, S, S);
    const wd = warp.data;
    let Hinv = null;
    if (H) {
      // 3x3 inverse
      const det = H[0] * (H[4] * H[8] - H[5] * H[7]) - H[1] * (H[3] * H[8] - H[5] * H[6]) + H[2] * (H[3] * H[7] - H[4] * H[6]);
      if (Math.abs(det) > 1e-12) Hinv = [
        (H[4] * H[8] - H[5] * H[7]) / det, (H[2] * H[7] - H[1] * H[8]) / det, (H[1] * H[5] - H[2] * H[4]) / det,
        (H[5] * H[6] - H[3] * H[8]) / det, (H[0] * H[8] - H[2] * H[6]) / det, (H[2] * H[3] - H[0] * H[5]) / det,
        (H[3] * H[7] - H[4] * H[6]) / det, (H[1] * H[6] - H[0] * H[7]) / det, (H[0] * H[4] - H[1] * H[3]) / det];
    }
    const M = Hinv || poseToH ? null : null;
    for (let py = 0; py < S; py++) for (let pxx = 0; pxx < S; pxx++) {
      const umx = X0 + pxx / sc, umy = Y0 + (S - py) / sc;
      let u, v;
      if (Hinv) {
        const Xp = Hinv[0] * umx + Hinv[1] * umy + Hinv[2];
        const Yp = Hinv[3] * umx + Hinv[4] * umy + Hinv[5];
        const Zp = Hinv[6] * umx + Hinv[7] * umy + Hinv[8];
        if (Zp <= 1e-9) continue;
        u = Xp / Zp; v = Yp / Zp;
      } else {
        const rad = pose.rotDeg * Math.PI / 180, c = Math.cos(rad), sn = Math.sin(rad);
        const du = umx - pose.cx, dv = umy - pose.cy;
        u = PW / 2 + (c * du + sn * dv) / pose.umPerPx;   // inverse of poseToH rows
        v = PH / 2 + (-sn * du + c * dv) / pose.umPerPx;  // approx (sign check below)
        v = PH / 2 - (sn * du + c * dv) / pose.umPerPx;
      }
      if (u < 0 || v < 0 || u > PW - 1 || v > PH - 1) continue;
      const x0 = u | 0, y0 = v | 0, tx = u - x0, ty = v - y0;
      const x1 = Math.min(x0 + 1, PW - 1), y1 = Math.min(y0 + 1, PH - 1);
      const o = (py * S + pxx) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const d00 = pd[(y0 * PW + x0) * 4 + ch], d10 = pd[(y0 * PW + x1) * 4 + ch];
        const d01 = pd[(y1 * PW + x0) * 4 + ch], d11 = pd[(y1 * PW + x1) * 4 + ch];
        wd[o + ch] = (d00 * (1 - tx) + d10 * tx) * (1 - ty) + (d01 * (1 - tx) + d11 * tx) * ty;
      }
      wd[o + 3] = 200;
    }
    ctx.putImageData(warp, 0, 0);
    return { aligned: a, pose: pose, hasH: !!H, overlay: cv.toDataURL('image/png'), elapsedMs: Date.now() - t0 };
  });

  console.log('aligned:', JSON.stringify(out.aligned, null, 1));
  console.log('homography fitted:', out.hasH, '| elapsed', (out.elapsedMs / 1000).toFixed(1) + 's');
  fs.writeFileSync(path.join(__dirname, 'out', 'jj_full_auto_markers_only.png'), Buffer.from(out.overlay.split(',')[1], 'base64'));
  console.log('wrote jj_full_auto_markers_only.png');
  await browser.close();
  srv.close();
})().catch((e) => { console.error('fatal:', e); process.exit(2); });
