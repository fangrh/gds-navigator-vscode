# VS Code interaction and provenance validation

Verified locally on 2026-10-04 with packaged VSIX installations in fresh,
test-owned VS Code 1.140.0 profiles on macOS arm64 (Electron 43.7.3,
Chromium 150). Ordinary user extensions, settings and project layouts were
not installed over or edited.

## Provenance

The initial interpreter contained standard gdsfactory 9.45.0, which has no
`gdsfactory.provenance` module. The copied, plain GDS fixture also lacked a
sidecar. Reporting OFF was correct for that input.

Created the ignored local `.venv-fork` with gdsfactory 9.41.0 from
`fangrh/gdsfactory` branch `feat/provenance-tracking`, commit
`b22199cc53646b64acbe1e5c3f78701063e6609a`, and KLayout 0.30.12.
The fork's `main` branch does not contain the required module. The setup guide
now names the correct branch and includes an API check.

Rebuilt the curated 50 µm chip generator with `GDS_PROVENANCE=1`. The actual
VS Code webview reports **Provenance: ON**, with source file/line references
for **1,818 of 1,818 features**. The context-menu source action opened the
actual generator at line 1879. This verifies a real tracked build; associating
a plain GDS with a Python filename alone cannot reconstruct its history.

The real environment and parser tests now accept `GDS_TEST_PYTHON`, followed
by `GDS_PYTHON`, and platform-native `.venv-fork` paths. Missing explicit
interpreters fail. Optional absent defaults print an explicit skip instead of
silently omitting the real checks on macOS.

## First selection pause

Native input/Event Timing and long-task observation found a 151–164 ms main
thread task on the first canvas selection, across all four layouts.
OpenLayers' `ExecutorGroup` benchmarks three canvas readback modes for 50 ms
each during that first pick.

The webview build now gives only the tiny hit-testing context an explicit
`willReadFrequently: true` hint and skips that synchronous benchmark. Picking
algorithms, geometry, drawing contexts and raster/image arithmetic are
unchanged. The build checks both upstream declarations before applying the
transform and fails clearly if a dependency update changes them.

The real-browser regression preserves holes, overlapping polygons, separate
polygons and actual selection identity. It observed five image reads rather
than a benchmark loop, seven readback contexts with the explicit hint, and no
browser errors. No hardware-dependent timing threshold supplies this gate.

## Interaction measurements

Mouse/keyboard workflows used the installed extension and actual GDS parsing.
They covered pan, wheel zoom, snap enable/pointer movement, layer visibility,
feature selection/inspector opening, rectangle drawing and properties.

| Layout | Pan frame p95 | Zoom frame p95 | First selection input-to-next-frame before | After |
|---|---:|---:|---:|---:|
| Tracked chip, 1,818 features | 18.6 ms | 18.6 ms | 156.4 ms | 29.5 ms |
| Grid, 1,000 polygons | 18.7 ms | 18.7 ms | 152.6 ms | 12.9 ms |
| Grid, 10,000 polygons | 18.7 ms | 18.6 ms | 155.9 ms | 14.9 ms |
| Grid, 50,000 polygons | 18.7 ms | 34.2 ms | 165.8 ms | 21.8 ms |

Median animation-frame intervals were approximately 16.7 ms. Through 10,000
polygons, the final sampled pan, zoom, snap, layer, selection and drawing
phases had no main-thread tasks above 50 ms. The 50,000-polygon stress case
still had 61–107 ms tasks in several phases and visible frame gaps; it is not
uniformly smooth. The selection benchmark removal does not establish a
pan/zoom speedup.

These are local renderer observations from one before/after workflow per
layout, not a statistical speedup or physical-display FPS certification.
Background throttling was disabled in both measured profiles to prevent
macOS window occlusion from pausing animation frames. Input-to-next-frame is
a scheduling proxy, not a measured photon/presentation latency. The three
stress grids are plain KLayout files for rendering scale tests.

Additional actual extension workflows passed: source navigation, YAML export,
built-in catalog/straight preview and placement (344 cards, two ports), auto
route preview/commit against 1,820 obstacle pieces, microscope image insertion,
opacity/contour display/manual movement, and annotation/image reopen
persistence. A 50 µm route grid was used for the 5 mm layout; its default 1 µm
grid correctly reported the existing search-budget limit.

The export driver initially read the clipboard before asynchronous export
completed. Its wait was corrected and export target verified. Restoration of
the original user clipboard after that initial driver race is unverified;
the clipboard contains test export YAML. This is a test-driver limitation.

## Verification and reproduction

```sh
npm run compile
npm run test:canvas-hit  # CHROME_PATH or GDS_BROWSER selects Chromium
GDS_TEST_PYTHON=/path/to/provenance/python node test/reliability/python-environment.test.js
GDS_TEST_PYTHON=/path/to/provenance/python node test/reliability/provenance-contract.test.js
```

The current source/cache/concurrency/lifecycle, Rust geometry and image-warp
Node gates also passed. TypeScript checking, production packaging and VSIX
runtime asset comparison passed. Evidence is retained locally under ignored
`logs/usability-20261004/`: `interactions.json`, `baseline-interactions.json`,
`extra-workflows.json`, `canvas-hit/report.json`, `provenance-env/`, native
screenshots and the verified VSIX. Machine-local environments and dependency
checkouts remain excluded from Git and the package.
