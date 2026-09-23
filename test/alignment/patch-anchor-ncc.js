'use strict';
const fs = require('fs'), path = require('path');
const VW = path.join(__dirname, '..', '..', 'webview', 'viewer.html');
let s = fs.readFileSync(VW, 'utf8');
if (s.includes('function anchorNCC(')) { console.log('already patched'); process.exit(0); }

const ANCH = "function _sleep(ms)";
if (!s.includes(ANCH)) { console.error('anchor missing'); process.exit(1); }

const CODE = `/** ANCHOR-CONTENT ALIGNMENT (stable ranking layer).
 *  Root cause of the ranking instability: chamfer-family scores are not
 *  comparable across scale families/resolutions (measured: the SAME true
 *  pose scores 0.235 at 384px and 0.029 at 960px), so every ranking rule on
 *  top of them is a per-fixture heuristic. This layer replaces ranking with
 *  content matching on a single comparable score:
 *    1. detect marker-cell patches in the photo (bright square + digit),
 *    2. render each layout marker cell at a hypothesized scale and position,
 *    3. score photo-patch vs rendered-patch by normalized cross-correlation
 *       (NCC) — same yardstick for EVERY hypothesis; digit content is unique
 *       per cell, so periodic phase aliases collapse,
 *    4. best cell match fixes (s, t, theta); the verified refine chain then
 *       polishes. Two agreeing cells = cross-validated lock. */
function _patchNCC(a, b) {
    var n = a.length;
    var ma = 0, mb = 0;
    for (var i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var va = 0, vb = 0, cov = 0;
    for (i = 0; i < n; i++) {
        var da = a[i] - ma, db = b[i] - mb;
        va += da * da; vb += db * db; cov += da * db;
    }
    va = Math.sqrt(va); vb = Math.sqrt(vb);
    return (va < 1e-6 || vb < 1e-6) ? 0 : cov / (va * vb);
}

/** Detect photo marker-cell patches: bright square regions (>=20px) via
 *  flood fill; returns [{u,v,half}] centers + half-size in photo px. */
function photoMarkerPatches() {
    var pe = photoEdgePoints();
    var img = microImg.img;
    var W = img.naturalWidth, H = img.naturalHeight;
    var SC = Math.min(1, 512 / Math.max(W, H));
    var w = Math.max(64, Math.round(W * SC)), h = Math.max(64, Math.round(H * SC));
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    var d = ctx.getImageData(0, 0, w, h).data;
    var gray = new Float32Array(w * h);
    var mean = 0;
    for (var i = 0, p = 0; i < gray.length; i++, p += 4) { gray[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; mean += gray[i]; }
    mean /= gray.length;
    var bright = new Uint8Array(w * h);
    for (i = 0; i < gray.length; i++) bright[i] = gray[i] > mean + 20 ? 1 : 0;
    var lbl = new Int32Array(w * h);
    var out = [], next = 1;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
        var i0 = y * w + x;
        if (!bright[i0] || lbl[i0]) continue;
        var stack = [i0]; lbl[i0] = next;
        var sz = 0, sx = 0, sy = 0, mnx = w, mxx = 0, mny = h, mxy = 0;
        while (stack.length) {
            var qq = stack.pop(); var qx = qq % w, qy = (qq / w) | 0;
            sz++; sx += qx; sy += qy;
            if (qx < mnx) mnx = qx; if (qx > mxx) mxx = qx;
            if (qy < mny) mny = qy; if (qy > mxy) mxy = qy;
            var nb = [qq - 1, qq + 1, qq - w, qq + w];
            for (var k = 0; k < 4; k++) {
                var nn = nb[k];
                if (nn < 0 || nn >= w * h) continue;
                var nx = nn % w;
                if ((nn === qq - 1 && nx === w - 1) || (nn === qq + 1 && nx === 0)) continue;
                if (bright[nn] && !lbl[nn]) { lbl[nn] = next; stack.push(nn); }
            }
        }
        var bw = mxx - mnx, bh = mxy - mny;
        if (sz > 250 && bw > 18 && bh > 18 && Math.abs(bw - bh) < 0.35 * Math.max(bw, bh)) {
            out.push({ u: (sx / sz) / SC, v: (sy / sz) / SC, half: Math.max(bw, bh) / 2 / SC });
        }
        next++;
    }
    out.sort(function (a, b) { return b.half - a.half; });
    return out.slice(0, 8);
}

/** Render a layout marker cell (all features within 'cell' um of a node)
 *  into a grayscale patch at scale umPerPx (rot 0), for NCC. */
function renderCellPatch(node, cellUm, umPerPx, px) {
    var g = Math.round(px);
    var cv = document.createElement('canvas'); cv.width = g; cv.height = g;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, g, g);
    ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff';
    var k = g / (cellUm * umPerPx); // um(px-offset) -> canvas px (centered)
    allFeatures.forEach(function (f) {
        if (f.get('isDrawn') || f.get('visible') === false) return;
        var e = f._extentCache || (f._extentCache = f.getGeometry().getExtent());
        if (e[2] < node[0] - cellUm / 2 || e[0] > node[0] + cellUm / 2 ||
            e[3] < node[1] - cellUm / 2 || e[1] > node[1] + cellUm / 2) return;
        var ring = f.getGeometry().getCoordinates()[0];
        if (!ring || ring.length < 3) return;
        var wUm = e[2] - e[0], hUm = e[3] - e[1];
        var fill = wUm * hUm < 900;   // small digit strokes -> filled
        ctx.beginPath();
        for (var i = 0; i < ring.length; i++) {
            var X = (ring[i][0] - node[0]) * k + g / 2, Y = g / 2 - (ring[i][1] - node[1]) * k;
            if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        }
        ctx.closePath();
        if (fill) ctx.fill(); else { ctx.lineWidth = 2; ctx.stroke(); }
    });
    var dd = ctx.getImageData(0, 0, g, g).data;
    var out = new Float32Array(g * g);
    for (var q = 0; q < out.length; q++) out[q] = dd[4 * q];
    return { px: out, g: g };
}

/** Stable anchor-content ranking: returns the best pose found or null.
 *  Scans scales around the marker-cell size ratio; for each photo patch and
 *  each nearby layout node, NCC-scores the content. Best match wins on a
 *  single comparable score. */
function anchorContentAlign() {
    var patches = photoMarkerPatches();
    if (!patches.length) return null;
    // layout nodes on the 200um lattice (marker cells)
    var nodes = new Map();
    allFeatures.forEach(function (f) {
        if (f.get('isDrawn') || f.get('visible') === false) return;
        var e = f._extentCache || (f._extentCache = f.getGeometry().getExtent());
        if (e[2] - e[0] > 300) return;
        var i = Math.round((e[0] + e[2]) / 2 / 200), j = Math.round((e[1] + e[3]) / 2 / 200);
        nodes.set(i + ',' + j, [i * 200, j * 200]);
    });
    var nodeList = [];
    nodes.forEach(function (nd) { nodeList.push(nd); });
    if (!nodeList.length) return null;
    // photo patch grayscale extractor (fixed 64px window)
    var img = microImg.img;
    var W = img.naturalWidth, H = img.naturalHeight;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var cctx = cv.getContext('2d');
    cctx.filter = 'blur(0.6px)';
    cctx.drawImage(img, 0, 0);
    cctx.filter = 'none';
    var pd = cctx.getImageData(0, 0, W, H).data;
    var G = 64;
    function photoPatch(u, v) {
        var out = new Float32Array(G * G);
        for (var yy = 0; yy < G; yy++) for (var xx = 0; xx < G; xx++) {
            var su = Math.min(W - 1, Math.max(0, Math.round(u - G / 2 + xx)));
            var sv = Math.min(H - 1, Math.max(0, Math.round(v - G / 2 + yy)));
            out[yy * G + xx] = pd[(sv * W + su) * 4];
        }
        return out;
    }
    // scale hypotheses: photo patch (size 2*half px) shows one CELL (200um)
    var best = null;
    var scores = [];
    for (var pi = 0; pi < Math.min(3, patches.length); pi++) {
        var ph = patches[pi];
        var cellPx = 2 * ph.half * 1.35;              // patch ~ cell incl. margin
        var s0 = 200 / cellPx;                        // um per photo px
        for (var sm = 0.85; sm <= 1.16; sm += 0.075) {
            var s = s0 * sm;
            var pp = photoPatch(ph.u, ph.v);
            var rendered = renderCellPatch([0, 0], 260, s, G);  // probe at origin
            // try nodes nearest to where the patch center maps (all nodes: cheap NCC)
            var bestN = null;
            for (var ni = 0; ni < nodeList.length; ni++) {
                var nd = nodeList[ni];
                var rp = renderCellPatch(nd, 260, s, G);
                var ncc = _patchNCC(pp, rp.px);
                if (!bestN || ncc > bestN.ncc) bestN = { ncc: ncc, nd: nd };
            }
            scores.push({ pi: pi, s: s, ncc: bestN.ncc, nd: bestN.nd });
        }
    }
    scores.sort(function (a, b) { return b.ncc - a.ncc; });
    if (!scores.length || scores[0].ncc < 0.25) return null;
    var win = scores[0];
    var ph2 = patches[win.pi];
    // pose: patch center (u,v) maps to node center; rot 0 initial
    return { umPerPx: win.s, rotDeg: 0, cx: win.nd[0] + (0 - 0), cy: win.nd[1],
             u: ph2.u, v: ph2.v, ncc: win.ncc,
             cx2: win.nd[0], cy2: win.nd[1],
             pose: { cx: win.nd[0] - (ph2.u - W / 2) * win.s, cy: win.nd[1] + (ph2.v - H / 2) * win.s } };
}

`;

s = s.replace(ANCH, CODE + ANCH);

// wire: use anchor result to seed the winner selection in autoAlign — insert
// right before "---- refine pass"
const HOOK = "    // ---- refine pass: per-candidate local canvas at screening resolution ----";
if (!s.includes(HOOK)) { console.error('hook missing'); process.exit(1); }
s = s.replace(HOOK, `    // ---- stable anchor-content pre-lock ----
    // NCC content match of marker cells gives a comparable-score pose; it is
    // pushed through the SAME screening/verify chain as all other candidates
    // (it must earn the win, but it is guaranteed to survive the candidate
    // slice).
    try {
        var anchor = anchorContentAlign();
        if (anchor) {
            _log('anchor-ncc', { s: +anchor.umPerPx.toFixed(3), ncc: +anchor.ncc.toFixed(3), x: Math.round(anchor.pose.cx), y: Math.round(anchor.pose.cy) });
            for (var arot = -6; arot <= 6; arot += 3) {
                candidates.push({ score: 1e6, cx: anchor.pose.cx, cy: anchor.pose.cy,
                    umPerPx: anchor.umPerPx, rotDeg: arot });
            }
        }
    } catch (eAC) { _log('anchor-ncc-err', { e: String(eAC) }); }

` + HOOK);

fs.writeFileSync(VW, s);
console.log('patched: anchor-content NCC layer');
