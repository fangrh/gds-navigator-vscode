#!/usr/bin/env node
// Overlay render for human verification: draw the aligned photo over the
// layout at the FINAL pose produced by autoAlignMicroImage, save a PNG.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const ROOT = path.join(__dirname, '..', '..');
const WHICH = process.argv[2] || 'jj';
const CASES = {
  jj: { data: '../test/fixtures/jj_pad_center_50_geo', photo: 'jj_pad_center_photo.png', mime: 'png' },
  chip285: { data: '../test/fixtures/chip285_markers_geo', photo: 'nbse2_sample1-1_micro.jpg', mime: 'jpeg' },
};
const CASE = CASES[WHICH];
const PORT = 8836;
const srv = http.createServer((q, r) => {
  const fp = path.normalize(path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)));
  fs.readFile(fp, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200); r.end(d); });
});
srv.listen(PORT, '127.0.0.1', async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-standalone.js')], { stdio: 'inherit' });
  const browser = await puppeteer.launch({
    executablePath: process.env.GDS_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-first-run'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=${CASE.data}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures, { timeout: 30000, polling: 100 });
  const b64 = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', CASE.photo)).toString('base64');
  const pi = process.argv.indexOf('--pose');
  const FORCED = pi > 0 ? process.argv[pi + 1].split(',').map(Number) : null;
  const out = await page.evaluate(async (dataUrl, forcedPose) => {
    window.__ALIGN_VERBOSE = false;
    insertMicroImage(dataUrl, 'overlay-run');
    await new Promise((res) => { const t0 = Date.now(); (function poll() { if (microImg && microImg.name === 'overlay-run') res(); else if (Date.now() - t0 > 15000) res(); else setTimeout(poll, 40); })(); });
    // optional forced pose: forcedPose = [cx,cy,rot,s] or null
    if (forcedPose) {
      const [fcx, fcy, frot, fs] = forcedPose;
      insertMicroImage(dataUrl, 'overlay-run2');
      await new Promise((res) => { const t0 = Date.now(); (function poll() { if (microImg && microImg.name === 'overlay-run2') res(); else if (Date.now() - t0 > 15000) res(); else setTimeout(poll, 40); })(); });
      microImg.cx = fcx; microImg.cy = fcy; microImg.rotDeg = frot; microImg.umPerPx = fs;
    } else {
      try { await autoAlignMicroImage(); } catch (e) { return { error: String(e) }; }
    }
    const pose = { cx: microImg.cx, cy: microImg.cy, umPerPx: microImg.umPerPx, rotDeg: microImg.rotDeg };
    // render: layout features (dark) + photo (orange overlay, 50%) at the pose
    const img = microImg.img;
    const S = 1000;
    // canvas covers the photo FOV + 30% margin, layout units
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
    // photo: photo px -> layout um -> canvas px
    const th = pose.rotDeg * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th);
    const Wp = img.naturalWidth, Hp = img.naturalHeight;
    // photo px (pu,pv) -> layout um (engine convention, y-up layout)
    const photoToUm = (pu, pv) => {
      const Da = pu - Wp / 2, Db = pv - Hp / 2;
      return [pose.cx + pose.umPerPx * (c * Da - sn * Db),
              pose.cy - pose.umPerPx * (sn * Da + c * Db)];
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
    const px1 = ctx.getImageData(Math.round(cv.width / 2), Math.round(cv.height / 2), 1, 1).data;
    return { pose, centerPx: [px1[0], px1[1], px1[2]], png: cv.toDataURL('image/png') };
  }, 'data:image/' + CASE.mime + ';base64,' + b64, FORCED);
  if (out.error) { console.log('ERROR', out.error); }
  else {
    console.log('pose:', JSON.stringify(out.pose), 'centerPx:', JSON.stringify(out.centerPx));
    fs.writeFileSync(path.join(ROOT, 'test', 'alignment', 'out', WHICH + '_overlay.png'),
      Buffer.from(out.png.split(',')[1], 'base64'));
    console.log('wrote test/alignment/out/' + WHICH + '_overlay.png');
  }
  await browser.close(); srv.close();
});
