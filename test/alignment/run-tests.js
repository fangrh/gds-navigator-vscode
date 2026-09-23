#!/usr/bin/env node
// Automated tests for the microscope auto-alignment engine in webview/viewer.html.
//
// Runs the real alignment code (via the generated webview/test-standalone.html
// harness) inside a headless system browser (Edge/Chrome, found automatically;
// no Chromium download — puppeteer-core only):
//
//   1. real-photo cases: nbse2_sample1-1_micro.jpg over chip285_markers_geo,
//      expected scale ≈ 6.0 um/px, rot ≈ 0 (test/fixtures/README.md), from
//      several different initial placements (pose must be reproducible).
//   2. synthetic cases: photos rendered from the fixture layout at a KNOWN
//      ground-truth transform (umPerPx, rotDeg, center), with 2D-flake blobs,
//      occluding residue, scratches and dust drawn on top — content that does
//      NOT exist in the design. Position/scale/rotation errors are asserted
//      against ground truth.
//   3. failure path: a blank photo must produce a clean failure message, not
//      a crash.
//
// Usage: node test/alignment/run-tests.js [--quick]
//   --quick   one real case + two synthetic cases (for fast iteration)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8791;
const QUICK = process.argv.includes('--quick');
const CASE_TIMEOUT_MS = 120000; // includes browser work; alignment itself < 45 s

// ---------------------------------------------------------------------------
// Pass thresholds
// ---------------------------------------------------------------------------
const SYNTH_MAX_SCALE_ERR = 0.01;   // |umPerPx/gt - 1| — blur-limited polish floor
const SYNTH_MAX_ROT_ERR = 0.5;      // deg
const SYNTH_MAX_POS_ERR = 20;       // um (~0.1 of the 200 um marker pitch)
// RESOLVED: the pad-based reading is the truth — numbered pads 429 px apart
// on the design's 200 um grid (labels increment per ADJACENT pad) gives
// 0.466 um/px. The earlier "≈6.0" green run was a sub-harmonic alias that
// the chamfer ranking could not reject; the element-level two-stage
// alignment (pad lattice voting + digit-content verification) now locks the
// k=1 reading. See webview/viewer.html:elementCoarsePose.
const REAL_SCALE = [0.44, 0.49];
const REAL_MAX_ROT = 2.0;           // deg
const REAL_MAX_ALIGN_MS = 45000;
// reproducibility across initial placements (real photo)
const REPEAT_MAX_SCALE_DIFF = 0.01; // relative
const REPEAT_MAX_ROT_DIFF = 0.5;    // deg
const REPEAT_MAX_POS_DIFF = 30;     // um

// ---------------------------------------------------------------------------
// Static file server (repo root)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.png': 'image/png', '.js': 'text/javascript',
  '.css': 'text/css',
};
function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, rsp) => {
      let p;
      try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
      catch { rsp.writeHead(400); rsp.end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const fp = path.normalize(path.join(ROOT, p));
      if (!fp.startsWith(ROOT)) { rsp.writeHead(403); rsp.end(); return; }
      fs.readFile(fp, (err, data) => {
        if (err) { rsp.writeHead(404); rsp.end('not found'); return; }
        rsp.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
        rsp.end(data);
      });
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

// ---------------------------------------------------------------------------
// Browser discovery: system Edge/Chrome, or GDS_BROWSER env override
// ---------------------------------------------------------------------------
function findBrowser() {
  if (process.env.GDS_BROWSER) return process.env.GDS_BROWSER;
  const cands = process.platform === 'win32' ? [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
  ];
  for (const c of cands) { try { fs.accessSync(c); return c; } catch { /* next */ } }
  throw new Error('No Edge/Chrome executable found for the alignment tests.\n' +
    'Install Microsoft Edge or Google Chrome, or set GDS_BROWSER=<path>.\nTried:\n  ' + cands.join('\n  '));
}

// ---------------------------------------------------------------------------
// Helpers evaluated inside the page
// ---------------------------------------------------------------------------
// Wait for the harness to finish loading the chip285 fixture.
async function pageWaitForLayout(page) {
  await page.waitForFunction(
    () => window.__viewerReady === true && window.allFeatures && window.allFeatures.length > 100,
    { timeout: 30000, polling: 100 });
}

// Insert a photo, optionally force an initial pose, run autoAlignMicroImage,
// and return the posted result. Runs fully in-page so `microImg` etc. resolve.
async function pageRunAlignment(page, dataUrl, name, initial) {
  return page.evaluate(async (dataUrl2, name2, initial2) => {
    insertMicroImage(dataUrl2, name2);
    const loaded = await new Promise((res) => {
      const t0 = Date.now();
      (function poll() {
        if (microImg && microImg.name === name2) res(true);
        else if (Date.now() - t0 > 15000) res(false);
        else setTimeout(poll, 40);
      })();
    });
    if (!loaded) return { error: 'image failed to load in page' };
    if (initial2) {
      microImg.cx = initial2.cx; microImg.cy = initial2.cy;
      microImg.umPerPx = initial2.umPerPx; microImg.rotDeg = initial2.rotDeg || 0;
    }
    window.__sent.length = 0; // only look at messages from THIS run
    const t0 = Date.now();
    try { await autoAlignMicroImage(); }
    catch (e) { return { error: 'autoAlignMicroImage threw: ' + e.message, errors: window.__pageErrors.slice() }; }
    const aligned = window.__sent.filter((m) => m.type === 'imageAligned').pop() || null;
    const transform = window.__sent.filter((m) => m.type === 'imageTransform').pop() || null;
    return {
      aligned, transform,
      elapsedMs: Date.now() - t0,
      errors: window.__pageErrors.slice(),
      pose: microImg ? { cx: microImg.cx, cy: microImg.cy, umPerPx: microImg.umPerPx, rotDeg: microImg.rotDeg } : null,
    };
  }, dataUrl, name, initial || null);
}

// Render a synthetic microscope photo of the CURRENT layout (allFeatures) at a
// ground-truth pose. All distractors (flake, residue, scratches, dust) are
// drawn in IMAGE space — they do not exist in the design.
async function pageMakeSyntheticPhoto(page, spec) {
  return page.evaluate((spec2) => {
    function rngFactory(seed) {
      let s = seed >>> 0;
      return function () {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const r = rngFactory(spec2.seed);
    const S = spec2.size || 1200;

    // --- features on an offscreen canvas (um coords, y-up) ---
    const feat = document.createElement('canvas');
    feat.width = S; feat.height = S;
    const fx = feat.getContext('2d');
    fx.fillStyle = '#ffffff'; fx.fillRect(0, 0, S, S);
    const k = 1 / spec2.umPerPx;
    const th = spec2.rotDeg * Math.PI / 180;
    const c = Math.cos(th), s = Math.sin(th);
    // um point (x,y) ABSOLUTE -> photo px (a,b): the exact inverse of the
    // alignment's image->layout mapping (ctx.translate(cx,cy) + ctx.rotate +
    // scale in a y-down canvas), so a photo generated here aligns at
    // (cx, cy, umPerPx, rotDeg) = ground truth:
    //   a = k*( c*(x-cx) - s*(y-cy)) + S/2
    //   b = k*(-s*(x-cx) - c*(y-cy)) + S/2
    // (det = -k^2: the required um-y-up -> px-y-down flip, constant for all theta)
    const e = S / 2 - k * (c * spec2.cx - s * spec2.cy);
    const f = S / 2 + k * (s * spec2.cx + c * spec2.cy);
    fx.setTransform(k * c, -k * s, -k * s, -k * c, e, f);
    fx.fillStyle = '#4a4640';
    allFeatures.forEach(function (f) {
      if (f.get('isDrawn') || f.get('visible') === false) return;
      const ring = f.getGeometry().getCoordinates()[0];
      if (!ring || ring.length < 3) return;
      fx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        if (i === 0) fx.moveTo(ring[i][0], ring[i][1]); else fx.lineTo(ring[i][0], ring[i][1]);
      }
      fx.closePath();
      fx.fill();
    });

    // --- photo canvas: SiO2 background + blurred features + distractors ---
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#d6d2c8'; ctx.fillRect(0, 0, S, S);
    ctx.filter = 'blur(0.8px)';
    ctx.drawImage(feat, 0, 0);
    ctx.filter = 'none';

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (spec2.flake) {
      // 2D-material-like flake: irregular bluish polygon, strong outline
      const fxp = S * (0.30 + 0.4 * r()), fyp = S * (0.30 + 0.4 * r());
      const n = 10, baseR = S * (0.10 + 0.05 * r());
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * 2 * Math.PI;
        const rad = baseR * (0.55 + 0.6 * r());
        const px = fxp + rad * Math.cos(ang), py = fyp + rad * Math.sin(ang) * 0.8;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(72,82,165,0.85)'; ctx.fill();
      ctx.strokeStyle = 'rgba(28,38,115,0.95)'; ctx.lineWidth = 2.5; ctx.stroke();
    }
    if (spec2.occluder) {
      // tape-residue-like soft blob cluster that COVERS some markers
      const oxp = S * (0.25 + 0.5 * r()), oyp = S * (0.25 + 0.5 * r());
      ctx.fillStyle = 'rgba(214,196,120,0.8)';
      for (let i = 0; i < 7; i++) {
        ctx.beginPath();
        ctx.arc(oxp + (r() - 0.5) * S * 0.22, oyp + (r() - 0.5) * S * 0.22, S * (0.03 + 0.05 * r()), 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    if (spec2.scratches) {
      ctx.strokeStyle = 'rgba(110,110,110,0.55)'; ctx.lineWidth = 1.4;
      for (let i = 0; i < 5; i++) {
        const sx = r() * S, sy = r() * S, ang = r() * Math.PI, len = S * (0.15 + 0.35 * r());
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + len * Math.cos(ang), sy + len * Math.sin(ang));
        ctx.stroke();
      }
    }
    if (spec2.dust) {
      for (let i = 0; i < 90; i++) {
        const dark = r() > 0.5;
        ctx.fillStyle = dark ? 'rgba(60,55,50,0.7)' : 'rgba(245,243,238,0.8)';
        ctx.beginPath();
        ctx.arc(r() * S, r() * S, 0.5 + 2.2 * r(), 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    // --- sensor noise + JPEG compression ---
    const id = ctx.getImageData(0, 0, S, S);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const nz = (r() - 0.5) * 16;
      d[i] += nz; d[i + 1] += nz; d[i + 2] += nz;
    }
    ctx.putImageData(id, 0, 0);
    return cv.toDataURL('image/jpeg', 0.88);
  }, spec);
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------
function synthSpecs() {
  // ground-truth poses roughly centered on the 9.2 mm chip (bbox ±4600 um)
  const specs = [
    { name: 'synth: scale 6, rot 0, flake', umPerPx: 6.0, rotDeg: 0, cx: -150, cy: 220, seed: 11, flake: true },
    { name: 'synth: scale 6, rot +2.5, flake+occluder+dust', umPerPx: 6.0, rotDeg: 2.5, cx: 320, cy: -180, seed: 22, flake: true, occluder: true, dust: true },
    { name: 'synth: scale 6, rot -2.5, flake', umPerPx: 6.0, rotDeg: -2.5, cx: -420, cy: -90, seed: 33, flake: true },
    { name: 'synth: scale 5, rot +4, flake+dust', umPerPx: 5.0, rotDeg: 4, cx: 120, cy: 380, seed: 44, flake: true, dust: true },
    { name: 'synth: scale 7.5, rot 0, occluder+scratches', umPerPx: 7.5, rotDeg: 0, cx: -260, cy: 60, seed: 55, occluder: true, scratches: true },
    { name: 'synth: scale 6.5, rot +2.5, flake+occluder', umPerPx: 6.5, rotDeg: 2.5, cx: 60, cy: -340, seed: 66, flake: true, occluder: true },
    { name: 'synth: scale 4 (tiled search), rot -4, flake', umPerPx: 4.0, rotDeg: -4, cx: 200, cy: 150, seed: 77, flake: true },
  ];
  if (QUICK) return [specs[1], specs[3]];
  return specs;
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------
let gFailures = 0;
function check(t, results, label, cond, msg) {
  if (cond) return;
  results.push(`${label}: ${msg}`);
  t.failures++;
}
function poseErrors(aligned, gt) {
  const dScale = Math.abs(aligned.umPerPx / gt.umPerPx - 1);
  const dRot = Math.abs(aligned.rotDeg - gt.rotDeg);
  const dPos = Math.hypot(aligned.cx - gt.cx, aligned.cy - gt.cy);
  return { dScale, dRot, dPos };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async function main() {
  // refresh the standalone harness from the current viewer.html
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-standalone.js')], { stdio: 'inherit' });

  const browserPath = findBrowser();
  console.log(`[alignment-tests] browser: ${browserPath}`);
  const srv = await startServer();
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-first-run', '--disable-extensions', '--hide-scrollbars', '--disable-background-networking'],
    protocolTimeout: CASE_TIMEOUT_MS + 60000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const nodePageErrors = [];
  page.on('pageerror', (e) => nodePageErrors.push(String(e)));

  const realJpg = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'nbse2_sample1-1_micro.jpg')).toString('base64');
  const realDataUrl = 'data:image/jpeg;base64,' + realJpg;

  const t0 = Date.now();
  try {
    await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=../test/fixtures/chip285_markers_geo`, { waitUntil: 'load', timeout: 60000 });
    await pageWaitForLayout(page);

    // ---- real-photo cases ----
    const initials = QUICK
      ? [{ label: 'default', init: null }]
      : [
          { label: 'default', init: null },
          { label: 'off-center+wrong-scale', init: { cx: -2200, cy: 1800, umPerPx: 3.0, rotDeg: 0 } },
          { label: 'off-center+wrong-scale-2', init: { cx: 2500, cy: -2100, umPerPx: 10.0, rotDeg: 0 } },
        ];
    const realRuns = [];
    for (const rc of initials) {
      const name = 'real-' + rc.label;
      const res = await pageRunAlignment(page, realDataUrl, name, rc.init);
      realRuns.push({ label: rc.label, res });
    }

    const results = [];
    console.log('\n=== real photo: nbse2_sample1-1_micro.jpg over chip285 ===');
    const realAligned = [];
    for (const { label, res } of realRuns) {
      const t = { failures: 0 };
      if (res.error) { results.push(`${label}: ${res.error}`); console.log(`  ${label}: ERROR ${res.error}`); gFailures++; continue; }
      const a = res.aligned;
      if (!a) {
        const note = res.transform && res.transform.note ? res.transform.note : 'no message';
        console.log(`  ${label}: NO RESULT (${note}) [${(res.elapsedMs / 1000).toFixed(1)}s]`);
        results.push(`${label}: alignment produced no imageAligned message (${note})`);
        gFailures++;
        continue;
      }
      check(t, results, label, a.umPerPx >= REAL_SCALE[0] && a.umPerPx <= REAL_SCALE[1],
        `scale ${a.umPerPx} um/px outside [${REAL_SCALE[0]}, ${REAL_SCALE[1]}]`);
      check(t, results, label, Math.abs(a.rotDeg) <= REAL_MAX_ROT, `rot ${a.rotDeg}deg exceeds ±${REAL_MAX_ROT}deg`);
      check(t, results, label, res.elapsedMs <= REAL_MAX_ALIGN_MS, `took ${(res.elapsedMs / 1000).toFixed(1)}s (> ${REAL_MAX_ALIGN_MS / 1000}s)`);
      check(t, results, label, res.errors.length === 0, `page errors: ${res.errors.join(' | ')}`);
      realAligned.push(a);
      console.log(`  ${label}: pos=(${a.cx}, ${a.cy}) um, scale=${a.umPerPx} um/px, rot=${a.rotDeg}deg, ` +
        `edgeMatch=${a.edgeMatch}, inlier=${a.inlierFrac}${a.layoutCoverage != null ? ', coverage=' + a.layoutCoverage : ''}, ` +
        `${(res.elapsedMs / 1000).toFixed(1)}s ${t.failures ? ' FAIL' : ' ok'}`);
      gFailures += t.failures;
    }
    if (realAligned.length === initials.length && realAligned.length > 1) {
      // reproducibility across initial placements
      const s0 = realAligned[0].umPerPx;
      let maxDs = 0, maxDr = 0, maxDp = 0;
      for (const a of realAligned) {
        maxDs = Math.max(maxDs, Math.abs(a.umPerPx - s0) / s0);
        maxDr = Math.max(maxDr, Math.abs(a.rotDeg - realAligned[0].rotDeg));
        maxDp = Math.max(maxDp, Math.hypot(a.cx - realAligned[0].cx, a.cy - realAligned[0].cy));
      }
      const label = 'reproducibility';
      const t = { failures: 0 };
      check(t, results, label, maxDs <= REPEAT_MAX_SCALE_DIFF, `scale spread ${(maxDs * 100).toFixed(2)}% > ${(REPEAT_MAX_SCALE_DIFF * 100).toFixed(1)}%`);
      check(t, results, label, maxDr <= REPEAT_MAX_ROT_DIFF, `rot spread ${maxDr.toFixed(3)}deg > ${REPEAT_MAX_ROT_DIFF}deg`);
      check(t, results, label, maxDp <= REPEAT_MAX_POS_DIFF, `pos spread ${maxDp.toFixed(1)}um > ${REPEAT_MAX_POS_DIFF}um`);
      console.log(`  ${label}: dScale=${(maxDs * 100).toFixed(2)}%, dRot=${maxDr.toFixed(3)}deg, dPos=${maxDp.toFixed(1)}um ${t.failures ? ' FAIL' : ' ok'}`);
      gFailures += t.failures;
    }

    // ---- second real fixture: jj pad-center photo over its own layout ----
    // Expected truth family: 2.0-2.3 um/px (FOV ~1.2 mm), rot ~0; verified
    // by overlay (test/alignment/out/jj_overlay.png renders photo on layout
    // with pads and digit clusters coinciding).
    {
      await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=../test/fixtures/jj_pad_center_50_geo`, { waitUntil: 'load', timeout: 60000 });
      await pageWaitForLayout(page);
      const jjPng = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'jj_pad_center_photo.png')).toString('base64');
      const jjUrl = 'data:image/png;base64,' + jjPng;
      console.log('=== real photo: jj_pad_center over jj layout ===');
      const jjRes = await pageRunAlignment(page, jjUrl, 'real-jj', null);
      const t = { failures: 0 };
      if (jjRes.error) { console.log('  jj: ERROR ' + jjRes.error); results.push('jj: ' + jjRes.error); gFailures++; }
      else {
        const a = jjRes.aligned;
        if (!a) {
          const note = jjRes.transform && jjRes.transform.note ? jjRes.transform.note : 'no message';
          console.log(`  jj: NO RESULT (${note})`);
          results.push('jj: no imageAligned message (' + note + ')');
          gFailures++;
        } else {
          check(t, results, 'jj', a.umPerPx >= 2.0 && a.umPerPx <= 2.3, `scale ${a.umPerPx} um/px outside [2.0, 2.3]`);
          check(t, results, 'jj', Math.abs(a.rotDeg) <= 2, `rot ${a.rotDeg}deg exceeds ±2deg`);
          console.log(`  jj: pos=(${a.cx}, ${a.cy}) um, scale=${a.umPerPx} um/px, rot=${a.rotDeg}deg, fov=${JSON.stringify(a.fieldOfViewUm)} ${t.failures ? ' FAIL' : ' ok'}`);
          gFailures += t.failures;
        }
      }
    }

    // ---- synthetic ground-truth cases (back on the chip285 layout) ----
    await page.goto(`http://127.0.0.1:${PORT}/webview/test-standalone.html?data=../test/fixtures/chip285_markers_geo`, { waitUntil: 'load', timeout: 60000 });
    await pageWaitForLayout(page);
    console.log('\n=== synthetic photos (known ground truth, distractors not in design) ===');
    for (const spec of synthSpecs()) {
      const gt = { umPerPx: spec.umPerPx, rotDeg: spec.rotDeg, cx: spec.cx, cy: spec.cy };
      const dataUrl = await pageMakeSyntheticPhoto(page, spec);
      const res = await pageRunAlignment(page, dataUrl, spec.name, null);
      const t = { failures: 0 };
      if (res.error) { console.log(`  ${spec.name}: ERROR ${res.error}`); results.push(`${spec.name}: ${res.error}`); gFailures++; continue; }
      const a = res.aligned;
      if (!a) {
        const note = res.transform && res.transform.note ? res.transform.note : 'no message';
        console.log(`  ${spec.name}: NO RESULT (${note})`);
        results.push(`${spec.name}: no imageAligned message (${note})`);
        gFailures++;
        continue;
      }
      const { dScale, dRot, dPos } = poseErrors(a, gt);
      check(t, results, spec.name, dScale <= SYNTH_MAX_SCALE_ERR, `scale err ${(dScale * 100).toFixed(2)}% > ${(SYNTH_MAX_SCALE_ERR * 100).toFixed(1)}% (got ${a.umPerPx}, want ${gt.umPerPx})`);
      check(t, results, spec.name, dRot <= SYNTH_MAX_ROT_ERR, `rot err ${dRot.toFixed(3)}deg > ${SYNTH_MAX_ROT_ERR}deg (got ${a.rotDeg}, want ${gt.rotDeg})`);
      check(t, results, spec.name, dPos <= SYNTH_MAX_POS_ERR, `pos err ${dPos.toFixed(1)}um > ${SYNTH_MAX_POS_ERR}um`);
      check(t, results, spec.name, res.elapsedMs <= REAL_MAX_ALIGN_MS, `took ${(res.elapsedMs / 1000).toFixed(1)}s`);
      check(t, results, spec.name, res.errors.length === 0, `page errors: ${res.errors.join(' | ')}`);
      console.log(`  ${spec.name}: dScale=${(dScale * 100).toFixed(2)}%, dRot=${dRot.toFixed(3)}deg, dPos=${dPos.toFixed(1)}um ` +
        `(found (${a.cx.toFixed(1)}, ${a.cy.toFixed(1)}), gt (${gt.cx}, ${gt.cy}), d=(${(a.cx - gt.cx).toFixed(1)}, ${(a.cy - gt.cy).toFixed(1)})), ` +
        `edgeMatch=${a.edgeMatch}${a.layoutCoverage != null ? ', coverage=' + a.layoutCoverage : ''}, ${(res.elapsedMs / 1000).toFixed(1)}s ${t.failures ? ' FAIL' : ' ok'}`);
      gFailures += t.failures;
    }

    // ---- failure path: blank photo ----
    console.log('\n=== failure path: blank photo ===');
    {
      const blank = await page.evaluate(() => {
        const cv = document.createElement('canvas');
        cv.width = 1200; cv.height = 1200;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#cfcabc'; ctx.fillRect(0, 0, 1200, 1200);
        return cv.toDataURL('image/jpeg', 0.9);
      });
      const res = await pageRunAlignment(page, blank, 'blank-photo', null);
      const t = { failures: 0 };
      if (res.error) { console.log(`  blank: ERROR ${res.error}`); results.push(`blank: ${res.error}`); gFailures++; }
      else {
        check(t, results, 'blank', !res.aligned, 'blank photo produced an imageAligned message (false positive lock)');
        const note = res.transform && res.transform.note ? res.transform.note : '';
        check(t, results, 'blank', /failed/i.test(note), `expected failure note, got: "${note}"`);
        check(t, results, 'blank', res.errors.length === 0, `page errors: ${res.errors.join(' | ')}`);
        console.log(`  blank: note="${note}", ${(res.elapsedMs / 1000).toFixed(1)}s ${t.failures ? ' FAIL' : ' ok'}`);
        gFailures += t.failures;
      }
    }

    if (nodePageErrors.length) {
      console.log('\npage (uncaught) errors seen by Node:');
      nodePageErrors.forEach((e) => console.log('  ' + e));
      gFailures += nodePageErrors.length;
    }

    console.log(`\n=== summary: ${gFailures === 0 ? 'ALL PASS' : gFailures + ' FAILURE(S)'} ===`);
    if (results.length) {
      console.log('Failures:');
      results.forEach((r) => console.log('  - ' + r));
    }
    console.log(`total wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exitCode = gFailures === 0 ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }
})().catch((e) => { console.error('[alignment-tests] fatal:', e.message); process.exit(2); });
