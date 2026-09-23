'use strict';
const fs = require('fs'), path = require('path');
const VW = path.join(__dirname, '..', '..', 'webview', 'viewer.html');
let s = fs.readFileSync(VW, 'utf8');
if (s.includes('function poseNCC(')) { console.log('already patched'); process.exit(0); }

const ANCH = "function _sleep(ms)";
if (!s.includes(ANCH)) { console.error('anchor missing'); process.exit(1); }
const CODE = `/** Cross-family arbiter: NCC of the layout cell under the photo center.
 *  Chamfer scores are not comparable across scale families; this is. */
function poseNCC(cx, cy, umPerPx) {
    var img = microImg.img;
    var W = img.naturalWidth, H = img.naturalHeight;
    var G = 64;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.filter = 'blur(0.6px)'; ctx.drawImage(img, 0, 0); ctx.filter = 'none';
    var pd = ctx.getImageData(0, 0, W, H).data;
    var pp = new Float32Array(G * G);
    for (var yy = 0; yy < G; yy++) for (var xx = 0; xx < G; xx++) {
        var su = Math.min(W - 1, Math.round(W / 2 - G / 2 + xx));
        var sv = Math.min(H - 1, Math.round(H / 2 - G / 2 + yy));
        pp[yy * G + xx] = pd[(sv * W + su) * 4];
    }
    var node = [Math.round(cx / 200) * 200, Math.round(cy / 200) * 200];
    var rp = renderCellPatch(node, 260, umPerPx, G);
    return _patchNCC(pp, rp.px);
}

`;
s = s.replace(ANCH, CODE + ANCH);

// arbitrate at the very end of autoAlign: prefer the pose with higher NCC
const TAIL = "    microImg.cx = bestC.cx;\n    microImg.cy = bestC.cy;";
if (!s.includes(TAIL)) { console.error('tail missing'); process.exit(1); }
s = s.replace(TAIL, `    // FINAL ARBITRATION by content NCC (the only cross-family-comparable
    // score): the chamfer winner competes with the anchor-content pose.
    try {
        var nccWin = poseNCC(bestC.cx, bestC.cy, bestC.umPerPx);
        var nccAnc = (typeof _anchorPose !== 'undefined' && _anchorPose) ? poseNCC(_anchorPose.cx, _anchorPose.cy, _anchorPose.umPerPx) : -1;
        _log('arbiter', { nccWinner: +nccWin.toFixed(3), nccAnchor: +nccAnc.toFixed(3) });
        if (_anchorPose && nccAnc > nccWin + 0.05) {
            var altR = refineCandidate({ score: 0, cx: _anchorPose.cx, cy: _anchorPose.cy, umPerPx: _anchorPose.umPerPx, rotDeg: 0, _hiRes: true }, false);
            altR = multiWindowPolish(altR);
            if (poseNCC(altR.cx, altR.cy, altR.umPerPx) > nccWin) bestC = altR;
        }
    } catch (eArb) { _log('arbiter-err', { e: String(eArb) }); }
    microImg.cx = bestC.cx;
    microImg.cy = bestC.cy;`);

// expose the anchor pose as _anchorPose
const ASTORE = "        var anchor = anchorContentAlign();";
if (!s.includes(ASTORE)) { console.error('astore missing'); process.exit(1); }
s = s.replace(ASTORE, "        var anchor = anchorContentAlign();\n        _anchorPose = anchor ? anchor.pose : null;");

fs.writeFileSync(VW, s);
console.log('patched: NCC arbiter');
