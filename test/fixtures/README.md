# Test fixtures

Real-world pairing used to develop and verify the microscope auto-alignment.

| File | What it is |
|---|---|
| `chip285_markers_geo.json` | Marker-only chip layout (`chip285.gds`, 9.2 mm × 9.2 mm, layers 1/8/9: 200 µm-pitch numbered marker grid) parsed to GeoJSON via `python/parse_gds.py`. |
| `nbse2_sample1-1_micro.jpg` | Optical microscope photo of the corresponding NbSe₂ sample region (yellow numbered markers visible; a 2D-material flake sits between markers 0,1–1,1). Downscaled to 1200 px. |

The original `chip285.gds` and the full-resolution `sample1-N.jpg` set live in
the author's project archive and are not distributed here.

## Reproduce the alignment demo

1. Open `test/fixtures/chip285_markers_geo.json`-backed layout: easiest is to
   parse the GDS through the extension, or serve this folder and use the
   standalone harness:
   ```bash
   cd <repo root>
   npm run compile
   node scripts/make-standalone.js
   python -m http.server 8765
   # open http://127.0.0.1:8765/webview/test-standalone.html?data=../test/fixtures/chip285_markers_geo
   ```
   (the harness resolves `?data=` relative to `/webview/`, so copy the fixture
   there or symlink).
2. Insert `nbse2_sample1-1_micro.jpg` via the image toolbar button (or let the
   harness fetch it), press the crosshair button.
3. The automatic search converges to ≈5.9 µm/px, rot ≈ 0°, with the marker
   grid locked (edge-match ≈19%, layout-coverage ≈50% — the photo's dominant
   edges are the flake and the large pads, which are not in this
   marker-only layout). No manual pre-positioning or arrow-key touch-up
   needed.

## Automated tests

```bash
npm test          # core alignment and reliability checks; needs Edge or Chrome
npm run test:alignment:quick   # fast subset for iteration
```

`test/alignment/run-tests.js` drives the real engine (standalone harness) in a
headless browser and asserts, with ground truth:

- the real fixture photo converges to ≈6 µm/px, rot ≈ 0°, reproducibly from
  several initial placements;
- synthetic photos rendered from this layout at known poses (scales 4–7.5
  µm/px, rotations up to ±4°, with flake blobs, occluding residue, scratches
  and dust drawn on top — content absent from the design) align to
  <1% scale, <0.5° rotation, <20 µm position;
- a featureless photo fails cleanly instead of false-locking.

> Note: chip285's marker hierarchy is self-similar (√2-separated scales look
> alike once the 200 µm fine grid is below photo resolution); the solver
> applies a smaller-FOV convention there, matching the reference run above.
>
> **Open question on magnification:** the numbered pads in the photo sit
> 429 px apart; if they are adjacent cells of the 200 µm marker grid the true
> magnification is ≈0.47 µm/px (high-mag view), not ≈6 µm/px. Both
> interpretations find matching design structure (self-similar hierarchy), so
> confirming the photo's actual field of view would pin the ground truth.

> Note: these fixtures are research data (Aalto University, Fang lab work on
> NbSe₂ freestanding devices). Include them only in private/internal forks if
> redistribution is a concern.


## Confirmed electrode-100 microscope fixture

`electrode100-microscope.png` is an unchanged copy of the user's confirmed
720x606 attachment. Its SHA-256 is
`1f99e353e3d23e06305b078cc5766f42cad1807b97b44c0e2199506f46441afe`.
It pairs with `jj_pad_center_100_test.gds` (SHA-256
`11cb7a4af5a84bc24c01b13138404a8a0ca71c21900c1506d20bae1f22600440`).
Marker identities are `0,0`, `1,0`, `0,-1`, `1,-1`. Electrode disagreement is
retained and excluded from scoring. This pair supersedes legacy whole-image
alignment claims above for numbered-marker validation.

`jj_pad_center_50_geo.json` is the retained parser output used by deterministic
marker-template tests. It is part of the delivered fixture set; no generated
`webview/real_geojson.json` is required by the new tests.

`electrode100-reduced.png` is the unchanged 398x348 image from
`D:/gds2027/images/ebl.png`, SHA-256
`17d74af048abc235aafb631f3d2c01d0ce08c7284e528032f61164efa7745ead`.
It reproduces the width-derived initial-scale ambiguity repaired in TASK-7.
Run `node test/alignment/reduced-marker-image.test.js` to check four identities,
determinism, boundary gates, nonmarker invariance and unreadable-label rejection.
