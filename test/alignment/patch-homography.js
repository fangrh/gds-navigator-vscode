// One-shot patcher: inserts the homography (perspective) alignment stage into
// webview/viewer.html. Run once: node test/alignment/patch-homography.js
'use strict';
const fs = require('fs');
const path = require('path');
const VW = path.join(__dirname, '..', '..', 'webview', 'viewer.html');
let s = fs.readFileSync(VW, 'utf8');

if (s.includes('function homographyFit(')) { console.log('already patched'); process.exit(0); }

// ---------------------------------------------------------------------------
// 1. homography machinery, inserted before the multi-window polish block
// ---------------------------------------------------------------------------
const ANCHOR = '/** Multi-window median translation polish + parabolic sub-pixel fit.';
if (!s.includes(ANCHOR)) { console.error('anchor 1 missing'); process.exit(1); }

const CODE = `/** Perspective (homography) alignment stage — camera viewing angle makes
 *  the photo a projective shot of the chip, so similarity (t+r+uniform s) is
 *  only a first approximation. Fits the 8-DOF homography photo-px ->
 *  layout-um by chamfer-guided DLT:
 *    photo edge points (native res, pre-blurred, cached, pose-independent)
 *      -> mapped through current H into the layout,
 *    layout distance transform gives each point its pull target
 *      (p - D(p)*gradD(p)),
 *    trimmed DLT least squares re-solves H; iterate while score improves.
 *  Photo-only content (flakes/dust) lands > HOMO_CUT from every layout edge
 *  and is excluded from the solve, same as everywhere else in the engine. */
var HOMO_CUT = 4.0;
var _photoEdgeCache = null;
function photoEdgePoints() {
    if (_photoEdgeCache) return _photoEdgeCache;
    var img = microImg.img;
    var W = img.naturalWidth, H = img.naturalHeight;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.filter = 'blur(1.2px)';
    ctx.drawImage(img, 0, 0);
    ctx.filter = 'none';
    var d = ctx.getImageData(0, 0, W, H).data;
    var gray = new Float32Array(W * H);
    var i, p;
    for (i = 0, p = 0; i < gray.length; i++, p += 4) {
        gray[i] = d[p + 3] > 100 ? 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2] : -1;
    }
    var mag = new Float32Array(W * H), gxArr = new Float32Array(W * H), gyArr = new Float32Array(W * H);
    var mags = [];
    var x, y, idx;
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
        idx = y * W + x;
        var a = gray[idx - W - 1], b = gray[idx - W], c = gray[idx - W + 1];
        var e = gray[idx - 1], f = gray[idx + 1];
        var g1 = gray[idx + W - 1], g2 = gray[idx + W], g3 = gray[idx + W + 1];
        if (a < 0 || c < 0 || g1 < 0 || g3 < 0 || e < 0 || f < 0) continue;
        var gx = (c + 2 * f + g3) - (a + 2 * e + g1);
        var gy = (g1 + 2 * g2 + g3) - (a + 2 * b + c);
        var m = Math.sqrt(gx * gx + gy * gy);
        if (m <= 0) continue;
        mag[idx] = m; gxArr[idx] = gx; gyArr[idx] = gy; mags.push(m);
    }
    if (!mags.length) { _photoEdgeCache = { pts: new Float32Array(0), u: new Float32Array(0), W: W, H: H }; return _photoEdgeCache; }
    var hist = new Uint32Array(1024), mmax = 0;
    for (i = 0; i < mags.length; i++) if (mags[i] > mmax) mmax = mags[i];
    for (i = 0; i < mags.length; i++) hist[Math.min(1023, (mags[i] / (mmax || 1) * 1023) | 0)]++;
    var want = Math.floor(mags.length * 0.10), acc = 0, bi = 1023;
    for (; bi >= 0; bi--) { acc += hist[bi]; if (acc >= want) break; }
    var thr = Math.max((bi / 1023) * (mmax || 1), 12);
    var px = [], py = [], pb = [];
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
        idx = y * W + x;
        var mm = mag[idx];
        if (mm < thr) continue;
        var gxa = gxArr[idx], gya = gyArr[idx], dIdx;
        if (Math.abs(gxa) > 2 * Math.abs(gya)) dIdx = 1;
        else if (Math.abs(gya) > 2 * Math.abs(gxa)) dIdx = W;
        else if ((gxa > 0) === (gya > 0)) dIdx = W + 1;
        else dIdx = W - 1;
        if (mm >= mag[idx - dIdx] && mm >= mag[idx + dIdx]) {
            var sector = Math.round(Math.atan2(gya, gxa) / (Math.PI / 4));
            px.push(x); py.push(y); pb.push(((sector % 4) + 4) % 4);
        }
    }
    var n2 = px.length;
    var pts = new Float32Array(n2 * 3), uu = new Float32Array(n2 * 2);
    for (i = 0; i < n2; i++) {
        pts[3 * i] = px[i]; pts[3 * i + 1] = py[i]; pts[3 * i + 2] = pb[i];
        uu[2 * i] = px[i]; uu[2 * i + 1] = py[i];
    }
    _photoEdgeCache = { pts: pts, u: uu, W: W, H: H };
    return _photoEdgeCache;
}

/** Similarity pose -> homography photo-px -> layout-um (engine convention). */
function poseToH(cx, cy, umPerPx, rotDeg) {
    var r = rotDeg * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
    var pe = photoEdgePoints();
    var w2 = pe.W / 2, h2 = pe.H / 2, k = 1 / umPerPx;
    return [c * k, -sn * k, cx + (-c * w2 + sn * h2) * k,
            -sn * k, -c * k, cy + (sn * w2 + c * h2) * k,
            0, 0, 1];
}

/** Map cached photo edge points through H; returns canvas pts [x,y,bucket]*
 *  plus the source photo px per kept point. */
function pointsThroughH(H, region, w, h, maxPts) {
    var pe = photoEdgePoints();
    var src = pe.pts, uu = pe.u;
    var sx = w / (region[2] - region[0]), sy = h / (region[3] - region[1]);
    var cxs = [], us = [];
    for (var i = 0, j = 0; i < src.length; i += 3, j += 2) {
        var X = H[0] * uu[j] + H[1] * uu[j + 1] + H[2];
        var Y = H[3] * uu[j] + H[4] * uu[j + 1] + H[5];
        var Z = H[6] * uu[j] + H[7] * uu[j + 1] + H[8];
        if (Z <= 1e-9) continue;
        var cx2 = (X / Z - region[0]) * sx;
        var cy2 = h - (Y / Z - region[1]) * sy;
        if (cx2 < 2 || cy2 < 2 || cx2 > w - 3 || cy2 > h - 3) continue;
        cxs.push(cx2, cy2, src[i + 2]);
        us.push(uu[j], uu[j + 1]);
    }
    var stride = Math.max(1, Math.floor(cxs.length / 3 / (maxPts || 6000)));
    var o1 = [], o2 = [];
    for (var q = 0; q < cxs.length; q += 3 * stride) {
        var qi = (q / 3 | 0) * 2;
        o1.push(cxs[q], cxs[q + 1], cxs[q + 2]);
        o2.push(us[qi], us[qi + 1]);
    }
    return { canvas: new Float32Array(o1), photo: new Float32Array(o2), n: o1.length / 3 };
}

/** Trimmed DLT: pairs flat [u,v,x,y,...] photo px -> layout um. */
function solveH(pairs) {
    var n = pairs.length / 4;
    if (n < 16) return null;
    var mu = [0, 0], mq = [0, 0], i;
    for (i = 0; i < n; i++) {
        mu[0] += pairs[4 * i]; mu[1] += pairs[4 * i + 1];
        mq[0] += pairs[4 * i + 2]; mq[1] += pairs[4 * i + 3];
    }
    mu[0] /= n; mu[1] /= n; mq[0] /= n; mq[1] /= n;
    var su = 0, sq = 0;
    for (i = 0; i < n; i++) {
        su += Math.hypot(pairs[4 * i] - mu[0], pairs[4 * i + 1] - mu[1]);
        sq += Math.hypot(pairs[4 * i + 2] - mq[0], pairs[4 * i + 3] - mq[1]);
    }
    su = Math.SQRT2 * n / (su || 1); sq = Math.SQRT2 * n / (sq || 1);
    var rows = [];
    for (i = 0; i < n; i++) {
        var u = (pairs[4 * i] - mu[0]) * su, v = (pairs[4 * i + 1] - mu[1]) * su;
        var qx = (pairs[4 * i + 2] - mq[0]) * sq, qy = (pairs[4 * i + 3] - mq[1]) * sq;
        rows.push([u, v, 1, 0, 0, 0, -u * qx, -v * qx, qx]);
        rows.push([0, 0, 0, u, v, 1, -u * qy, -v * qy, qy]);
    }
    var M = [], r = [];
    for (var a = 0; a < 8; a++) { M.push(new Array(8).fill(0)); r.push(0); }
    for (var k = 0; k < rows.length; k++) {
        var row = rows[k];
        for (a = 0; a < 8; a++) {
            r[a] += row[a] * row[8];
            for (var b = 0; b < 8; b++) M[a][b] += row[a] * row[b];
        }
    }
    var Aug = M.map(function (rw, idx) { return rw.concat([r[idx]]); });
    for (var col = 0; col < 8; col++) {
        var piv = col;
        for (var rr = col + 1; rr < 8; rr++) if (Math.abs(Aug[rr][col]) > Math.abs(Aug[piv][col])) piv = rr;
        if (Math.abs(Aug[piv][col]) < 1e-12) return null;
        var tmp = Aug[col]; Aug[col] = Aug[piv]; Aug[piv] = tmp;
        for (rr = col + 1; rr < 8; rr++) {
            var f2 = Aug[rr][col] / Aug[col][col];
            for (var cc = col; cc <= 8; cc++) Aug[rr][cc] -= f2 * Aug[col][cc];
        }
    }
    var hv = new Array(8);
    for (var rowI = 7; rowI >= 0; rowI--) {
        var sum = Aug[rowI][8];
        for (cc = rowI + 1; cc < 8; cc++) sum -= Aug[rowI][cc] * hv[cc];
        hv[rowI] = sum / Aug[rowI][rowI];
    }
    var Hn = [[hv[0], hv[1], hv[2]], [hv[3], hv[4], hv[5]], [hv[6], hv[7], 1]];
    var Tu = [[su, 0, -su * mu[0]], [0, su, -su * mu[1]], [0, 0, 1]];
    var Tqi = [[1 / sq, 0, mq[0]], [0, 1 / sq, mq[1]], [0, 0, 1]];
    var t1 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], out = [[0, 0, 0], [0, 0, 0], [0, 0, 1]];
    for (a = 0; a < 3; a++) for (b = 0; b < 3; b++)
        t1[a][b] = Hn[a][0] * Tu[0][b] + Hn[a][1] * Tu[1][b] + Hn[a][2] * Tu[2][b];
    for (a = 0; a < 3; a++) for (b = 0; b < 3; b++)
        out[a][b] = Tqi[a][0] * t1[0][b] + Tqi[a][1] * t1[1][b] + Tqi[a][2] * t1[2][b];
    return [out[0][0], out[0][1], out[0][2], out[1][0], out[1][1], out[1][2], out[2][0], out[2][1], 1];
}

/** Full perspective fit around a similarity pose. Returns the refined pose
 *  object with .H set (photo-px -> layout-um); score never decreases. */
function homographyFit(cand) {
    var img = microImg.img;
    var Rx = img.naturalWidth * cand.umPerPx * 0.62 + 5;
    var Ry = img.naturalHeight * cand.umPerPx * 0.62 + 5;
    var region = [cand.cx - Rx, cand.cy - Ry, cand.cx + Rx, cand.cy + Ry];
    var FW = 832, FH = Math.max(48, Math.round(FW * (region[3] - region[1]) / (region[2] - region[0])));
    var L = layoutEdgeMap(region, FW, FH);
    var Dmaps = layoutOrientedDistMaps(L, FW, FH);
    var Dn = layoutDistMap(L, FW, FH);         // non-oriented DT for targets
    var sxUm = (region[2] - region[0]) / FW, syUm = (region[3] - region[1]) / FH;
    var H = poseToH(cand.cx, cand.cy, cand.umPerPx, cand.rotDeg);
    function scoreOf(Hh) {
        var m = pointsThroughH(Hh, region, FW, FH, 6000);
        return { s: scoreChamfer(Dmaps, FW, FH, m.canvas, 0, 0, 1.2).score, m: m };
    }
    var cur = scoreOf(H);
    for (var it = 0; it < 6; it++) {
        var m = cur.m;
        var pts = m.canvas, ph = m.photo;
        // DT gradient targets
        var gxg = new Float32Array(FW * FH), gyg = new Float32Array(FW * FH);
        for (var y = 1; y < FH - 1; y++) for (var x = 1; x < FW - 1; x++) {
            var i2 = y * FW + x;
            gxg[i2] = (Dn[i2 + 1] - Dn[i2 - 1]) / 2;
            gyg[i2] = (Dn[i2 + FW] - Dn[i2 - FW]) / 2;
        }
        var pairs = [];
        for (var q = 0; q < pts.length; q += 3) {
            var fx = pts[q], fy = pts[q + 1];
            var x0 = fx | 0, y0 = fy | 0;
            if (x0 < 1 || y0 < 1 || x0 >= FW - 1 || y0 >= FH - 1) continue;
            var i3 = y0 * FW + x0;
            var Dp = Dn[i3];
            if (Dp > HOMO_CUT) continue;
            var gxx = gxg[i3], gyy = gyg[i3];
            var gl = Math.hypot(gxx, gyy);
            if (gl < 1e-6) continue;
            var tx = fx - Dp * gxx / gl, ty = fy - Dp * gyy / gl;
            pairs.push(ph[2 * (q / 3 | 0)], ph[2 * (q / 3 | 0) + 1],
                       region[0] + tx * sxUm, region[3] - ty * syUm);
        }
        var Hn = solveH(pairs);
        if (!Hn) break;
        // mildness guard: perspective terms tiny relative to affine part
        if (Math.hypot(Hn[6], Hn[7]) > 5e-4) break;
        var nxt = scoreOf(Hn);
        if (nxt.s <= cur.s + 1e-4) break;
        H = Hn; cur = nxt;
    }
    return { score: cur.s, H: H, region: region };
}

`;

s = s.replace(ANCHOR, CODE + ANCHOR);

// ---------------------------------------------------------------------------
// 2. wire into autoAlignMicroImage after the multi-window polish
// ---------------------------------------------------------------------------
const CALL_OLD = '        bestC = multiWindowPolish(bestC);';
const CALL_NEW = `        bestC = multiWindowPolish(bestC);
        // Perspective fit: viewing-angle distortion needs the full 8-DOF
        // homography on top of the similarity pose (guarded: accepted only
        // when it improves the chamfer score).
        try {
            var hf = homographyFit(bestC);
            if (hf.H && hf.score > (bestC.fwdScore || 0)) {
                bestC.H = hf.H;
                bestC.perspGain = +(hf.score - (bestC.fwdScore || 0)).toFixed(4);
            }
        } catch (eH) { /* perspective fit is best-effort */ }`;
if (!s.includes(CALL_OLD)) { console.error('anchor 2 missing'); process.exit(1); }
s = s.replace(CALL_OLD, CALL_NEW);

fs.writeFileSync(VW, s);
console.log('patched viewer.html with homography stage');
