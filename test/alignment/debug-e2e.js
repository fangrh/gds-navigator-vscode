#!/usr/bin/env node
// End-to-end probe: run the FULL autoAlignMicroImage() (element stage + E
// chain) on a real fixture pair and report the resulting pose.
// Usage: node test/alignment/debug-e2e.js [jj|chip285] [repeat]
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const WHICH = process.argv[2] || 'jj';
const REPEAT = parseInt(process.argv[3] || '1', 10);
const CASES = {
  jj: { data: '../test/fixtures/jj_pad_center_50_geo', photo: '/test/fixtures/jj_pad_center_photo.png' },
  chip285: { data: '../test/fixtures/chip285_markers_geo', photo: '/test/fixtures/nbse2_sample1-1_micro.jpg' },
};
const CASE = CASES[WHICH] || CASES.jj;
const PORT = 8833;

const srv = http.createServer((q, r) => {
  const fp = path.normalize(path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)));
  fs.readFile(fp, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200); r.end(d); });
});
srv.listen(PORT, '127.0.0.1', async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-standalone.js')], { stdio: 'inherit' });
  const browser = await puppeteer.launch({
    executablePath: process.env.GDS_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--no-first-run'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (/^ALIGN-DEBUG/.test(t)) console.log(t); });
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e), e.stack || ''));
  await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=${CASE.data}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures && window.allFeatures.length > 100, { timeout: 30000, polling: 100 });
  const imgB64 = fs.readFileSync(path.join(ROOT, 'test', 'fixtures',
    WHICH === 'jj' ? 'jj_pad_center_photo.png' : 'nbse2_sample1-1_micro.jpg')).toString('base64');
  const dataUrl = 'data:image/' + (WHICH === 'jj' ? 'png' : 'jpeg') + ';base64,' + imgB64;
  const results = [];
  for (let run = 0; run < REPEAT; run++) {
    const res = await page.evaluate(async (dataUrl2, runId) => {
      window.__ALIGN_VERBOSE = true;
      const name = 'e2e-' + runId;
      insertMicroImage(dataUrl2, name);
      await new Promise((res2) => { const t0 = Date.now(); (function poll() { if (microImg && microImg.name === name) res2(); else if (Date.now() - t0 > 15000) res2(); else setTimeout(poll, 40); })(); });
      window.__sent.length = 0;
      const t0 = Date.now();
      try { await autoAlignMicroImage(); }
      catch (e) { return { error: String(e) }; }
      const aligned = window.__sent.filter((m) => m.type === 'imageAligned').pop() || null;
      const transform = window.__sent.filter((m) => m.type === 'imageTransform').pop() || null;
      return {
        aligned, note: transform ? transform.note : '',
        elapsedMs: Date.now() - t0,
        nCands: window.__elRawCands ? window.__elRawCands.length : -1,
        elTop: window.__elRawCands ? window.__elRawCands.slice(0, 6).map((c) => ({ s: +c.umPerPx.toFixed(3), th: c.rotDeg, x: Math.round(c.cx), y: Math.round(c.cy) })) : null,
      };
    }, dataUrl, run);
    results.push(res);
    console.log('=== run ' + run + ' ===');
    if (res.error) console.log('ERROR', res.error);
    else if (res.aligned) console.log('ALIGNED s=' + res.aligned.umPerPx + ' rot=' + res.aligned.rotDeg +
      ' pos=(' + res.aligned.cx + ',' + res.aligned.cy + ') edgeMatch=' + res.aligned.edgeMatch +
      ' coverage=' + res.aligned.layoutCoverage + ' inlier=' + res.aligned.inlierFrac +
      ' fov=' + JSON.stringify(res.aligned.fieldOfViewUm) + ' ' + (res.elapsedMs / 1000).toFixed(1) + 's');
    else console.log('NO RESULT note="' + res.note + '" ' + (res.elapsedMs / 1000).toFixed(1) + 's');
  }
  if (REPEAT > 1) {
    const a = results.filter((r) => r.aligned).map((r) => r.aligned);
    if (a.length === REPEAT) {
      const s0 = a[0].umPerPx;
      const spread = {
        dS: Math.max(...a.map((x) => Math.abs(x.umPerPx / s0 - 1))),
        dRot: Math.max(...a.map((x) => Math.abs(x.rotDeg - a[0].rotDeg))),
        dPos: Math.max(...a.map((x) => Math.hypot(x.cx - a[0].cx, x.cy - a[0].cy))),
      };
      console.log('SPREAD', JSON.stringify(spread));
    }
  }
  await browser.close(); srv.close();
});
