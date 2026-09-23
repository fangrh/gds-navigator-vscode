#!/usr/bin/env node
// One-shot: tight-window content scan of the strongest pads against all
// layout cells at the ladder scales (is the true scale/phase visible?).
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const ROOT = path.join(__dirname, '..', '..');
const WHICH = process.argv[2] || 'chip285';
const CASES = {
  jj: { data: '../test/fixtures/jj_pad_center_50_geo', photo: 'jj_pad_center_photo.png', mime: 'png' },
  chip285: { data: '../test/fixtures/chip285_markers_geo', photo: 'nbse2_sample1-1_micro.jpg', mime: 'jpeg' },
};
const CASE = CASES[WHICH];
const PORT = 8835;
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
  const out = await page.evaluate(async (dataUrl) => {
    window.__ALIGN_VERBOSE = false;
    insertMicroImage(dataUrl, 'tight-probe');
    await new Promise((res) => { const t0 = Date.now(); (function poll() { if (microImg && microImg.name === 'tight-probe') res(); else if (Date.now() - t0 > 10000) res(); else setTimeout(poll, 40); })(); });
    const ph = detectPhotoElements();
    const la = detectLayoutElements();
    const lay = [];
    la.cells.forEach((c) => lay.push({ x: c.x, y: c.y, diag: Math.hypot(c.w, c.h) }));
    const pads = ph.units.filter((e) => e.fill > 0.7).sort((a, b) => b.area - a.area).slice(0, 2);
    const scales = [0.467, 0.935, 1.402, 1.869, 2.336, 2.804];
    const report = [];
    for (const sc of scales) {
      for (let pi = 0; pi < pads.length; pi++) {
        const pd = pads[pi];
        let top = [];
        for (const lu of lay) {
          const v = Math.abs(_elContentNCC({ u: pd.u, v: pd.v, x: lu.x, y: lu.y, diagUm: lu.diag, winF: 1.6 }, sc, 0, 0, 0));
          top.push([+v.toFixed(3), Math.round(lu.x), Math.round(lu.y)]);
        }
        top.sort((a, b) => b[0] - a[0]);
        report.push({ s: sc, pad: pi, top3: top.slice(0, 3), med: +top[Math.floor(top.length / 2)][0].toFixed(3) });
      }
    }
    return report;
  }, 'data:image/' + CASE.mime + ';base64,' + b64);
  out.forEach((r) => console.log(JSON.stringify(r)));
  await browser.close(); srv.close();
});
