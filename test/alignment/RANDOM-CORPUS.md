# Random microscope-image corpus

Run `npm run test:alignment:random100` from the repository root. Python requires
NumPy and Pillow; the evaluator requires the installed browser used by the other
alignment tests (`GDS_BROWSER` can override its executable).

The generator produces 100 seeded 720 x 720 images from the actual GDS marker
polygons, including their number glyphs. It adds regular and irregular flakes in
random colors, illumination variation, Poisson shot noise and blur. A manifest
records the image-to-GDS transform and corruption settings. The final 20 images
deliberately omit the number glyphs to test rejection of unidentified squares.

Results live under `logs/numbered-markers/random100/`:

- `images/`: all source PNGs.
- `manifest.json`: seeds, generation parameters, known transforms and inputs.
- `report.json`: every solver result, image hash and ground-truth error.
- Timestamped reports: retained completed runs, including failures.
- Contact sheets: visual review of the generated images.

Twenty mild cases are expected to align. Moderate, hard and severe cases measure
the limits of the solver; rejection is recorded explicitly. Unidentified squares
must be rejected. Every accepted result must have correct unique marker labels,
boundary RMS <=2 px, per-marker RMS <=4 px, and known-transform probe RMS <=2 px
with maximum <=4 px. A low boundary residual alone is insufficient evidence.

This is a synthetic software robustness experiment, not a camera calibration or
a guarantee for arbitrary microscope photographs. Challenge rejection counts must
remain visible when reporting success.

`npm run test:images:workflow` clicks Insert, placement-fit, Show image, Align,
opacity/visibility, ordering and Remove controls with two corpus images. Its native
file-choice response and save acknowledgments are simulated. Actual extension
storage and reopening are tested separately by `npm run test:images:vscode`.

The label sampler uses the vertical extent of the GDS number polygons plus four
template pixels of margin, keeping full horizontal labels. This avoids including
nearby colored flakes in label normalization. The margin is validated for this
pose corpus; it does not establish unlimited perspective support.
