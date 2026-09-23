'use strict';
const fs = require('fs'), path = require('path');
const VW = path.join(__dirname, '..', '..', 'webview', 'viewer.html');
let s = fs.readFileSync(VW, 'utf8');
if (s.includes('nodeAnchorCandidates')) { console.log('already patched'); process.exit(0); }

// 1) extend ladder into the LOCAL-FOV range
const LAD = "var fr2 = [0.12, 0.16, 0.21, 0.28, 0.37, 0.48, 0.56, 0.66, 0.78, 0.95, 1.15, 1.4];";
if (!s.includes(LAD)) { console.error('ladder anchor missing'); process.exit(1); }
s = s.replace(LAD, "var fr2 = [0.035, 0.045, 0.06, 0.08, 0.11, 0.15, 0.21, 0.28, 0.37, 0.48, 0.56, 0.66, 0.78, 0.95, 1.15, 1.4];");

// 2) node-anchored candidates for local FOVs: insert helper before autoAlign
const ANCH = "function _sleep(ms)";
if (!s.includes(ANCH)) { console.error('anchor missing'); process.exit(1); }
const HELP = `/** Local-FOV candidate generation: photos of a small region of the chip
 *  (the usual microscopy case) shrink below usable size in the global FFT
 *  canvas. Instead of correlating globally, enumerate the marker-lattice
 *  NODES as translation hypotheses — every cell gets one candidate, and the
 *  per-cell content (unique digits) discriminates the phase at screening. */
function nodeAnchorCandidates(umPerPx, rotDeg, cap) {
    var pe = photoEdgePoints();
    var fovW = pe.W * umPerPx;
    if (fovW * 4 > (window.__regionW || 1e9)) return [];   // not a local FOV
    var nodes = new Map();
    allFeatures.forEach(function (f) {
        if (f.get('isDrawn') || f.get('visible') === false) return;
        var e = f.getGeometry().getExtent();
        var w = e[2] - e[0];
        if (w > 300) return;                                // lattice features only
        var i = Math.round((e[0] + e[2]) / 2 / 200), j = Math.round((e[1] + e[3]) / 2 / 200);
        nodes.set(i + ',' + j, [i * 200, j * 200]);
    });
    var out = [];
    nodes.forEach(function (nd) {
        out.push({ score: 0, cx: nd[0], cy: nd[1], umPerPx: umPerPx, rotDeg: rotDeg });
    });
    return out.slice(0, cap || 260);
}

`;
s = s.replace(ANCH, HELP + ANCH);

// 3) call it in the combo loop + expose regionW
const OLD = "                var B = coarseImageFFT(region, cx0, cy0, umPerPx, rot);";
const NEW = `                var localCands = nodeAnchorCandidates(umPerPx, rot, 260);
                for (var lc = 0; lc < localCands.length; lc++) candidates.push(localCands[lc]);
                var B = coarseImageFFT(region, cx0, cy0, umPerPx, rot);`;
if (!s.includes(OLD)) { console.error('loop anchor missing'); process.exit(1); }
s = s.replace(OLD, NEW);

const RW = "    var candidates = [];";
if (!s.includes(RW)) { console.error('rw anchor missing'); process.exit(1); }
s = s.replace(RW, "    window.__regionW = regionW;\n    " + RW);

fs.writeFileSync(VW, s);
console.log('patched: local-FOV node anchoring');
