#!/usr/bin/env node
// Phase-seed flow e2e: auto-align lands on a phase alias (documented
// information limit at fine scales), then the USER clicks a photo feature
// and the same feature in the layout; the engine re-anchors + polishes.
// Usage: node test/alignment/debug-seed.js
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const ROOT = path.join(__dirname, '..', '..');
const PORT = 8842;
const srv = http.createServer((q, r) => {
  const fp = path.normalize(path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)));
  fs.readFile(fp, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200); r.end(d); });
});
srv.listen(PORT, '127.0.0.1', async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-standalone.js')], { stdio: 'ignore' });
  const browser = await puppeteer.launch({
    executablePath: process.env.GDS_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--no-first-run'], protocolTimeout: 1200000,
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=../test/fixtures/chip285_markers_geo`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures, { timeout: 30000, polling: 100 });
  const b64 = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'nbse2_sample1-1_micro.jpg')).toString('base64');
  const out = await page.evaluate(async (dataUrl) => {
    window.__ALIGN_VERBOSE = false;
    insertMicroImage(dataUrl, 'seed-run');
    await new Promise((res) => { const t0 = Date.now(); (function poll() { if (microImg && microImg.name === 'seed-run') res(); else if (Date.now() - t0 > 15000) res(); else setTimeout(poll, 40); })(); });
    window.__sent.length = 0;
    // 1) automatic alignment (phase-ambiguous at this fixture resolution)
    await autoAlignMicroImage();
    const alias = { cx: microImg.cx, cy: microImg.cy, umPerPx: microImg.umPerPx, rotDeg: microImg.rotDeg };
    // 2) user phase seed: click the strongest pad (photo px 805,875), then
    //    its TRUE layout position (-204.7,-397.9) (design cell -1,-2 pad)
    const th = alias.rotDeg * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th);
    const Da = 805 - microImg.img.naturalWidth / 2, Db = 875 - microImg.img.naturalHeight / 2;
    const photoClick = [alias.cx + (c * Da - sn * Db) * alias.umPerPx,
                        alias.cy - (sn * Da + c * Db) * alias.umPerPx];
    const layoutClick = [-204.7, -397.9];
    window.__phaseSeedApply(photoClick, layoutClick);
    // 3) wait for the polish lock to finish (imageAligned 'locked from user phase seed')
    const ok = await new Promise((res) => {
      const t0 = Date.now();
      (function poll() {
        const m = window.__sent.filter((x) => x.type === 'imageAligned' && /phase seed/.test(x.note || '')).pop();
        if (m) res(m); else if (Date.now() - t0 > 120000) res(null); else setTimeout(poll, 200);
      })();
    });
    const pose = { cx: microImg.cx, cy: microImg.cy, umPerPx: microImg.umPerPx, rotDeg: microImg.rotDeg };
    // 4) overlay render for visual verification
    const img = microImg.img;
    const S = 1000;
    const fovW = img.naturalWidth * pose.umPerPx, fovH = img.naturalHeight * pose.umPerPx;
    const reg = [pose.cx - fovW * 0.65, pose.cy - fovH * 0.65, pose.cx + fovW * 0.65, pose.cy + fovH * 0.65];
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = Math.round(S * (reg[3] - reg[1]) / (reg[2] - reg[0]));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#f0f0f0'; ctx.fillRect(0, 0, cv.width, cv.height);
    const kx = cv.width / (reg[2] - reg[0]), ky = cv.height / (reg[3] - reg[1]);
    allFeatures.forEach((f) => {
      if (f.get('isDrawn') || f.get('visible') === false) return;
      const ring = f.getGeometry().getCoordinates()[0];
      if (!ring || ring.length < 3) return;
      const e = f.getGeometry().getExtent();
      if (e[2] < reg[0] || e[0] > reg[2] || e[3] < reg[1] || e[1] > reg[3]) return;
      ctx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const X = (ring[i][0] - reg[0]) * kx, Y = cv.height - (ring[i][1] - reg[1]) * ky;
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.closePath(); ctx.fillStyle = '#222'; ctx.fill();
    });
    const thr = pose.rotDeg * Math.PI / 180, cc = Math.cos(thr), snn = Math.sin(thr);
    const Wp = img.naturalWidth, Hp = img.naturalHeight;
    const photoToUm = (pu, pv) => {
      const Da2 = pu - Wp / 2, Db2 = pv - Hp / 2;
      return [pose.cx + pose.umPerPx * (cc * Da2 - snn * Db2),
              pose.cy - pose.umPerPx * (snn * Da2 + cc * Db2)];
    };
    const toC = (x, y) => [(x - reg[0]) * kx, cv.height - (y - reg[1]) * ky];
    ctx.save();
    const a0 = toC(...photoToUm(0, 0)), a1 = toC(...photoToUm(Wp, 0)), a2 = toC(...photoToUm(0, Hp));
    const m11 = (a1[0] - a0[0]) / Wp, m12 = (a2[0] - a0[0]) / Hp;
    const m21 = (a1[1] - a0[1]) / Wp, m22 = (a2[1] - a0[1]) / Hp;
    ctx.setTransform(m11, m21, m12, m22, a0[0], a0[1]);
    ctx.globalAlpha = 0.55;
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    return {
      alias, seededClicks: { photoClick: photoClick.map(Math.round), layoutClick },
      locked: ok ? { cx: ok.cx, cy: ok.cy, umPerPx: ok.umPerPx, rotDeg: ok.rotDeg, note: ok.note } : null,
      finalPose: { cx: +pose.cx.toFixed(2), cy: +pose.cy.toFixed(2), umPerPx: +pose.umPerPx.toFixed(4), rotDeg: +pose.rotDeg.toFixed(2) },
      png: cv.toDataURL('image/png'),
    };
  }, 'data:image/jpeg;base64,' + b64);
  if (out.png) fs.writeFileSync(path.join(ROOT, 'test', 'alignment', 'out', 'chip285_seed_overlay.png'),
    Buffer.from(out.png.split(',')[1], 'base64'));
  delete out.png;
  console.log(JSON.stringify(out, null, 1));
  await browser.close(); srv.close();
});
