#!/usr/bin/env node
// Element-level detection + coarse-pose debug (steps A-D of the two-stage
// alignment). Loads the real fixture photo into the standalone harness and
// dumps detected photo elements, layout elements and the voted coarse pose.
//
// Usage: node test/alignment/debug-elements.js [jj|chip285]
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const WHICH = process.argv[2] || 'jj';
const CASES = {
  jj: { data: '../test/fixtures/jj_pad_center_50_geo', photo: '/test/fixtures/jj_pad_center_photo.png' },
  chip285: { data: '../test/fixtures/chip285_markers_geo', photo: '/test/fixtures/nbse2_sample1-1_micro.jpg' },
};
const CASE = CASES[WHICH] || CASES.jj;
// Synthetic mode: --synth umPerPx,rotDeg,cx,cy renders the CURRENT layout at
// a KNOWN pose (same math as run-tests.js pageMakeSyntheticPhoto) and aligns
// it — the controlled environment for debugging the C+D stages.
const SYNTH = (() => {
  const i = process.argv.indexOf('--synth');
  if (i < 0) return null;
  const [s, r, cx, cy] = process.argv[i + 1].split(',').map(Number);
  return { umPerPx: s, rotDeg: r, cx, cy, seed: 12345 };
})();
const PORT = 8831;

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
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=${CASE.data}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__viewerReady === true && window.allFeatures && window.allFeatures.length > 100, { timeout: 30000, polling: 100 });
  const out = await page.evaluate(async (photoUrl, synth) => {
    window.__ALIGN_VERBOSE = true;
    let src;
    if (synth) {
      // render the current layout at the known pose (identical math to the
      // automated test harness, so a photo generated here aligns at the gt)
      const spec = { ...synth, size: 1200 };
      const r = ((s) => { let x = s >>> 0; return () => { x = (x + 0x6D2B79F5) | 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })(spec.seed);
      const S = spec.size;
      const feat = document.createElement('canvas'); feat.width = S; feat.height = S;
      const fx = feat.getContext('2d');
      fx.fillStyle = '#ffffff'; fx.fillRect(0, 0, S, S);
      const k = 1 / spec.umPerPx, th = spec.rotDeg * Math.PI / 180;
      const c = Math.cos(th), sn = Math.sin(th);
      const e = S / 2 - k * (c * spec.cx - sn * spec.cy);
      const f = S / 2 + k * (sn * spec.cx + c * spec.cy);
      fx.setTransform(k * c, -k * sn, -k * sn, -k * c, e, f);
      fx.fillStyle = '#4a4640';
      allFeatures.forEach(function (ft) {
        if (ft.get('isDrawn') || ft.get('visible') === false) return;
        const ring = ft.getGeometry().getCoordinates()[0];
        if (!ring || ring.length < 3) return;
        fx.beginPath();
        for (let i = 0; i < ring.length; i++) { if (i === 0) fx.moveTo(ring[i][0], ring[i][1]); else fx.lineTo(ring[i][0], ring[i][1]); }
        fx.closePath(); fx.fill();
      });
      const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#d6d2c8'; ctx.fillRect(0, 0, S, S);
      ctx.filter = 'blur(0.8px)'; ctx.drawImage(feat, 0, 0); ctx.filter = 'none';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const id = ctx.getImageData(0, 0, S, S), d = id.data;
      for (let i = 0; i < d.length; i += 4) { const nz = (r() - 0.5) * 16; d[i] += nz; d[i + 1] += nz; d[i + 2] += nz; }
      ctx.putImageData(id, 0, 0);
      src = cv.toDataURL('image/jpeg', 0.88);
    } else {
      const img = new Image(); img.src = photoUrl; await img.decode();
      src = await new Promise((res) => {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext('2d').drawImage(img, 0, 0);
        res(cv.toDataURL('image/png'));
      });
    }
    insertMicroImage(src, 'debug-photo');
    await new Promise((res) => { const t0 = Date.now(); (function poll() { if (microImg && microImg.name === 'debug-photo') res(); else if (Date.now() - t0 > 10000) res(); else setTimeout(poll, 40); })(); });
    const t0 = performance.now();
    const ph = detectPhotoElements();
    const la = detectLayoutElements();
    const pose = elementCoarsePose();
    const ms = Math.round(performance.now() - t0);
    // patch dump: photo unit patch vs its TRUE-pose cell render, for visual
    // inspection of what the content NCC actually compares
    let patchDump = null;
    if (synth) {
      const gc = _elPhotoGray();
      const G = 64;
      const su = ph.units.filter((e) => e.fill > 0.4).sort((a, b) => b.area - a.area)[0] || ph.units[0];
      // true layout position of this unit
      const Da = su.u - gc.W / 2, Db = su.v - gc.H / 2;
      const tx = synth.cx + Da * synth.umPerPx, ty = synth.cy - Db * synth.umPerPx;
      const lay = [];
      la.cells.forEach((c) => lay.push({ x: c.x, y: c.y, diagUm: Math.hypot(c.w, c.h), kind: 'cell' }));
      la.frames.forEach((f) => lay.push({ x: f.x, y: f.y, diagUm: f.size, kind: 'frame' }));
      let bl = null, bd = 1e18;
      for (const lu of lay) { const d = Math.hypot(lu.x - tx, lu.y - ty); if (d < bd) { bd = d; bl = lu; } }
      const Rpx = Math.max(16, Math.min(90, (bl.diagUm || 30) / synth.umPerPx * 1.6));
      const pp = new Float32Array(G * G);
      for (let yy = 0; yy < G; yy++) for (let xx = 0; xx < G; xx++) {
        const su2 = Math.min(gc.W - 1, Math.max(0, Math.round(su.u - Rpx + xx * 2 * Rpx / G)));
        const sv = Math.min(gc.H - 1, Math.max(0, Math.round(su.v - Rpx + yy * 2 * Rpx / G)));
        pp[yy * G + xx] = gc.g[sv * gc.W + su2];
      }
      const rp = renderCellPatch([bl.x, bl.y], Math.min(260, 2 * Rpx * 1.15), synth.umPerPx, G);
      const gtNcc = _elContentNCC({ u: su.u, v: su.v, x: bl.x, y: bl.y, diagUm: bl.diagUm }, synth.umPerPx, 0, 0, 0);
      const toPng = (arr) => { // grayscale float -> dataURL
        const cv = document.createElement('canvas'); cv.width = G; cv.height = G;
        const id = cv.getContext('2d').createImageData(G, G);
        for (let i = 0; i < arr.length; i++) { const v = Math.max(0, Math.min(255, arr[i])); id.data[4 * i] = id.data[4 * i + 1] = id.data[4 * i + 2] = v; id.data[4 * i + 3] = 255; }
        cv.getContext('2d').putImageData(id, 0, 0);
        return cv.toDataURL('image/png');
      };
      patchDump = {
        unit: { u: Math.round(su.u), v: Math.round(su.v), w: Math.round(su.w), h: Math.round(su.h), fill: +su.fill.toFixed(2), area: Math.round(su.area) },
        truePos: { x: Math.round(tx), y: Math.round(ty), distToCell: Math.round(bd), cellDiagUm: Math.round(bl.diagUm), kind: bl.kind },
        Rpx: Math.round(Rpx), gtNcc: +gtNcc.toFixed(3),
        photoPatch: toPng(pp), cellRender: toPng(rp.px),
      };
    }
    // probe: unit consistency at the EXACT ground-truth pose
    let gtProbe = null;
    if (synth) {
      const lay = [];
      la.cells.forEach((c) => lay.push({ x: c.x, y: c.y, diagUm: Math.hypot(c.w, c.h), kind: 'cell' }));
      la.frames.forEach((f) => lay.push({ x: f.x, y: f.y, diagUm: f.size, kind: 'frame' }));
      const cr = Math.cos(synth.rotDeg * Math.PI / 180), sn = Math.sin(synth.rotDeg * Math.PI / 180);
      const imW = microImg.img.naturalWidth, imH = microImg.img.naturalHeight;
      let nOn = 0;
      const misses = [];
      for (const u of ph.units) {
        const Da = u.u - imW / 2, Db = u.v - imH / 2;
        const mx = synth.cx + (cr * Da - sn * Db) * synth.umPerPx;
        const my = synth.cy - (sn * Da + cr * Db) * synth.umPerPx;
        let hit = false;
        for (const lu of lay) { if (Math.hypot(lu.x - mx, lu.y - my) < 80) { hit = true; break; } }
        if (hit) nOn++; else if (misses.length < 5) misses.push({ u: Math.round(u.u), v: Math.round(u.v), x: Math.round(mx), y: Math.round(my) });
      }
      gtProbe = { nUnits: ph.units.length, nOn, misses };
      // global content NCC at the exact GT pose (function sanity)
      const gtGlobal = _elGlobalContentNCC({ umPerPx: synth.umPerPx, rotDeg: synth.rotDeg, cx: synth.cx, cy: synth.cy });
      gtProbe.gtGlobalNcc = +gtGlobal.toFixed(3);
      // dump the two arrays the global NCC compares
      {
        const gcX = _elPhotoGray();
        const side = Math.min(gcX.W, gcX.H), G = Math.min(1000, Math.round(side));
        const pp = new Float32Array(G * G);
        const u0 = (gcX.W - side) / 2, v0 = (gcX.H - side) / 2;
        for (let yy = 0; yy < G; yy++) for (let xx = 0; xx < G; xx++) {
          const su = Math.min(gcX.W - 1, Math.max(0, Math.round(u0 + xx * side / G)));
          const sv = Math.min(gcX.H - 1, Math.max(0, Math.round(v0 + yy * side / G)));
          pp[yy * G + xx] = gcX.g[sv * gcX.W + su];
        }
        const rp = renderCellPatch([synth.cx, synth.cy], side * 1.02, synth.umPerPx, G);
        const toPng2 = (arr, gg) => {
          const cv = document.createElement('canvas'); cv.width = gg; cv.height = gg;
          const id = cv.getContext('2d').createImageData(gg, gg);
          for (let i = 0; i < arr.length; i++) { const v = Math.max(0, Math.min(255, arr[i])); id.data[4 * i] = id.data[4 * i + 1] = id.data[4 * i + 2] = v; id.data[4 * i + 3] = 255; }
          cv.getContext('2d').putImageData(id, 0, 0);
          return cv.toDataURL('image/png');
        };
        gtProbe.globalPhotoPng = toPng2(pp, G);
        gtProbe.globalRenderPng = toPng2(rp.px, G);
        gtProbe.globalNccRaw = +_patchNCC(pp, rp.px).toFixed(4);
      }
    }
    // dump: strongest pad patch vs its best-cell render at s=0.466
    if (!synth) {
      const lay2 = [];
      la.cells.forEach((c) => lay2.push({ x: c.x, y: c.y, diagUm: Math.hypot(c.w, c.h) }));
      const pd0 = ph.units.filter((e) => e.fill > 0.7).sort((a, b) => b.area - a.area)[0];
      let best = 0, bl = null;
      for (const lu of lay2) {
        const v = Math.abs(_elContentNCC({ u: pd0.u, v: pd0.v, x: lu.x, y: lu.y, diagUm: 200 * 1.5, winF: 1.6 }, 0.466, 0, 0, 0));
        if (v > best) { best = v; bl = lu; }
      }
      const G = 96, Rpx = Math.max(16, Math.min(240, 300 / 0.466 * 1.6));
      const gcx = _elPhotoGray();
      const pp = new Float32Array(G * G);
      for (let yy = 0; yy < G; yy++) for (let xx = 0; xx < G; xx++) {
        const su = Math.min(gcx.W - 1, Math.max(0, Math.round(pd0.u - Rpx + xx * 2 * Rpx / G)));
        const sv = Math.min(gcx.H - 1, Math.max(0, Math.round(pd0.v - Rpx + yy * 2 * Rpx / G)));
        pp[yy * G + xx] = gcx.g[sv * gcx.W + su];
      }
      const rp2 = _elRenderPatchDark([bl.x, bl.y], Math.min(1400, 2 * Rpx * 1.15), 0.466, G);
      const nccCheck = _patchNCC(pp, rp2.px);
      const toPng3 = (arr, gg) => {
        const cv = document.createElement('canvas'); cv.width = gg; cv.height = gg;
        const id = cv.getContext('2d').createImageData(gg, gg);
        for (let i = 0; i < arr.length; i++) { const v = Math.max(0, Math.min(255, arr[i])); id.data[4 * i] = id.data[4 * i + 1] = id.data[4 * i + 2] = v; id.data[4 * i + 3] = 255; }
        cv.getContext('2d').putImageData(id, 0, 0);
        return cv.toDataURL('image/png');
      };
      scaleProbe = [{ dumpPad: Math.round(pd0.u) + ',' + Math.round(pd0.v), dumpCell: Math.round(bl.x) + ',' + Math.round(bl.y), dumpNcc: +best.toFixed(3), nccCheck: +nccCheck.toFixed(3),
                      padPng: toPng3(pp, G), cellPng: toPng3(rp2.px, G) }];
    } else {
    // probe: per-pad max content NCC over cells at a FIXED scale list
    let scaleProbe = null;
    {
      const lay = [];
      la.cells.forEach((c) => lay.push({ x: c.x, y: c.y, diagUm: Math.hypot(c.w, c.h), kind: 'cell' }));
      const pads4 = ph.units.filter((e) => e.fill > 0.7).sort((a, b) => b.area - a.area).slice(0, 3);
      const scales4 = [0.466, 0.664, 0.332, 2.079, 1.0];
      scaleProbe = scales4.map((sc) => {
        const perPad = pads4.map((pd) => {
          let best = 0, bx = 0, by = 0;
          for (const lu of lay) {
            const v = Math.abs(_elContentNCC({ u: pd.u, v: pd.v, x: lu.x, y: lu.y, diagUm: 27, winF: 1.6 }, sc, 0, 0, 0));
            if (v > best) { best = v; bx = lu.x; by = lu.y; }
          }
          return { ncc: +best.toFixed(3), cell: Math.round(bx) + ',' + Math.round(by) };
        });
        return { s: sc, perPad };
      });
    }
    }
    // dump detected label clusters (nStrokes groups) in photo px
    const labelDump = ph.units.filter((u) => u.nStrokes !== undefined)
      .map((u) => ({ u: Math.round(u.u), v: Math.round(u.v), w: Math.round(u.w), h: Math.round(u.h), n: u.nStrokes }));
    return {
      ms, synth: synth || null, patchDump, gtProbe, scaleProbe, labelDump,
      photo: {
        nPads: ph.nPads, nCells: ph.nCells, nBars: ph.nBars,
        units: ph.units.slice(0, 60).map((e) => ({ u: Math.round(e.u), v: Math.round(e.v), w: Math.round(e.w), h: Math.round(e.h), fill: +((e.fill || 0)).toFixed(2), ang: +((e.ang || 0) * 180 / Math.PI).toFixed(1), pol: e.polarity, border: e.border, area: Math.round(e.area || 0) })),
        bars: ph.bars.map((e) => ({ u: Math.round(e.u), v: Math.round(e.v), len: Math.round(e.size), ang: +(e.ang * 180 / Math.PI).toFixed(1), pol: e.polarity,
          bb: [Math.round(e.x0), Math.round(e.y0), Math.round(e.x1), Math.round(e.y1)],
          ends: [[Math.round(e.endTopX), Math.round(e.y0)], [Math.round(e.endBotX), Math.round(e.y1)], [Math.round(e.x0), Math.round(e.endLY)], [Math.round(e.x1), Math.round(e.endRY)]],
          w: Math.round(e.w), h: Math.round(e.h), fill: +e.fill.toFixed(2) })),
      },
      layout: {
        cells: la.cells.length, frames: la.frames.length, bars: la.bars.length,
        cellSample: la.cells.slice(0, 5).map((c) => ({ x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h), n: c.n })),
        frameSample: la.frames.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y), size: Math.round(f.size) })),
        barSample: la.bars.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), len: Math.round(b.len), ang: +(b.ang * 180 / Math.PI).toFixed(1) })),
      },
      pose: pose ? {
        umPerPx: +pose.umPerPx.toFixed(4), rotDeg: +pose.rotDeg.toFixed(3),
        cx: Math.round(pose.cx), cy: Math.round(pose.cy),
        nUnits: pose.nUnits, ncc: +pose.ncc.toFixed(3), barMatches: pose.barMatches,
        pitchUm: Math.round(pose.pitchUm), votes: pose.votes,
        fovUm: [Math.round(microImg.img.naturalWidth * pose.umPerPx), Math.round(microImg.img.naturalHeight * pose.umPerPx)],
        err: synth ? {
          dS: +(pose.umPerPx / synth.umPerPx - 1).toFixed(4),
          dRot: +(pose.rotDeg - synth.rotDeg).toFixed(2),
          dPos: Math.round(Math.hypot(pose.cx - synth.cx, pose.cy - synth.cy)),
        } : null,
      } : null,
    };
  }, CASE.photo, SYNTH);
  console.log('=== ' + WHICH + (SYNTH ? ' SYNTH gt(' + process.argv[process.argv.indexOf('--synth') + 1] + ')' : '') + ' ===');
  if (out.patchDump) {
    const pd = out.patchDump;
    console.log('patchDump:', JSON.stringify({ unit: pd.unit, truePos: pd.truePos, Rpx: pd.Rpx, gtNcc: pd.gtNcc }));
    for (const [name, url] of [['photoPatch', pd.photoPatch], ['cellRender', pd.cellRender]]) {
      fs.writeFileSync(path.join(ROOT, 'test', 'alignment', 'out', WHICH + '_' + name + '.png'), Buffer.from(url.split(',')[1], 'base64'));
    }
    delete out.patchDump;
  }
  if (out.scaleProbe && out.scaleProbe[0] && out.scaleProbe[0].padPng) {
    const d = out.scaleProbe[0];
    console.log('realdump:', JSON.stringify({ pad: d.dumpPad, cell: d.dumpCell, ncc: d.dumpNcc }));
    fs.writeFileSync(path.join(ROOT, 'test', 'alignment', 'out', WHICH + '_realPad.png'), Buffer.from(d.padPng.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(ROOT, 'test', 'alignment', 'out', WHICH + '_realCell.png'), Buffer.from(d.cellPng.split(',')[1], 'base64'));
    delete out.scaleProbe;
  }
  if (out.gtProbe && out.gtProbe.globalPhotoPng) {
    const gp = out.gtProbe;
    console.log('gtProbe:', JSON.stringify({ nOn: gp.nOn, gtGlobalNcc: gp.gtGlobalNcc, globalNccRaw: gp.globalNccRaw }));
    fs.writeFileSync(path.join(ROOT, 'test', 'alignment', 'out', WHICH + '_globalPhoto.png'), Buffer.from(gp.globalPhotoPng.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(ROOT, 'test', 'alignment', 'out', WHICH + '_globalRender.png'), Buffer.from(gp.globalRenderPng.split(',')[1], 'base64'));
    delete gp.globalPhotoPng; delete gp.globalRenderPng; delete gp.misses;
  }
  console.log(JSON.stringify(out, null, 1));
  await browser.close(); srv.close();
});
