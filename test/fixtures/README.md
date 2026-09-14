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
3. Constrain the field of view to ~9.2 mm (the photo frames the whole chip) —
   the automatic search converges to ≈6.0 µm/px, rot ≈0°, with the marker grid
   locked; fine-tune with the arrow keys if needed.

> Note: these fixtures are research data (Aalto University, Fang lab work on
> NbSe₂ freestanding devices). Include them only in private/internal forks if
> redistribution is a concern.
