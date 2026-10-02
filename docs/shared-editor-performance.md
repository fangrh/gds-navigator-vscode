# Shared editor performance

Measured 2026-10-02 on macOS arm64, Headless Chrome 147.0.7727.15. These changes
apply to the shared browser and VS Code viewer.

## Changes and invariants

- Newly constructed GDS features receive metadata silently before bulk source
  insertion. This skips property-notification checks; geometry, IDs, provenance,
  layer keys and the normal later source/render updates remain identical.
- Style caches use primitive tuples with bounded FIFO eviction and branch
  pruning. They avoid JSON keys and per-feature retained cache records. Limits
  remain 96 route, 128 port and 256 layout styles. Color, labels, visibility,
  selection, route width and resolution still determine the output.
- Port refresh compares existing centers and port-object identity before writing.
  Removal membership uses one selection Set. A changed center/name, deformed
  component, selection removal or reload still updates the overlay.
- Image controls reuse rows/options during pose and status updates. The signature
  covers order, IDs, names, visibility, selection, lock, opacity and busy state.
  Object identity is checked too, so restoring a replacement image with the same
  ID rebuilds callbacks against the live object.
- Image warping computes the original projection arithmetic directly, keeping
  the original operation order, finite-denominator checks, bilinear RGBA sampling,
  Uint8ClampedArray rounding and transparent edges. Projection calls fall from
  four corners plus every output pixel to four corners. Source image decoding,
  warp/display caches, output dimensions, contours and PNG encoding retain their
  existing behavior; no image or polygon detail is reduced.
- The numbered-marker worker reads its private decoded OffscreenCanvas directly,
  eliminating a second full-image draw. Marker thresholds, connected components,
  matching, confidence and acceptance thresholds are unchanged.

The loading counter records **8,000 notification checks to zero** for 1,000
features. Both versions dispatch zero metadata property events before source
insertion; notification checks and emitted events are different measurements.
Two hundred pose/status updates create zero image-list rows/options. An unchanged
port refresh makes zero coordinate or port-property writes.

## Viewer comparison

Fresh browser processes alternate before, after, after, before. Deterministic
eight-layer polygon grids are fitted before timing. Each variant has six snap-off
loads, six snap-on loads and eighty pan/render samples, with CPU sampling enabled.
Ordered geometry/property SHA-256 signatures match. Medians use the upper middle
sample, following the existing viewer comparison script.

| Features | Measurement | Before | After |
| ---: | --- | ---: | ---: |
| 1,000 | Shared loading work, snap off | 4.6 ms | 3.8 ms |
| 1,000 | End-to-end load, snap off | 32.7 ms | 32.5 ms |
| 10,000 | Shared loading work, snap off | 35.3 ms | 29.3 ms |
| 10,000 | End-to-end load, snap off | 145.7 ms | 122.7 ms |
| 10,000 | Shared loading work, snap on | 69.5 ms | 57.6 ms |
| 10,000 | End-to-end load, snap on | 163.7 ms | 150.1 ms |
| 10,000 | Pan/render | 7.8 ms | 7.7 ms |

The 10,000-feature load improved about 16% here. No meaningful pan/FPS improvement
is claimed. The 1,000-feature end-to-end results are essentially unchanged.
End-to-end time includes local HTTP, JSON, viewer work and two animation frames;
stage times can overlap. This does not isolate a per-change speedup.

Final samples and CPU profiles are in `logs/broad-performance/viewer-tuples/`.
The earlier `viewer-paired/` and `viewer-final/` runs are diagnostic variants,
including the discarded feature-local cache, not final acceptance measurements.

## Image comparison

Fresh pages run current, original, original, current, with twelve timed pose
updates per variant for each fixture/mode. Decode and one different pose are
warmed first. Timing includes warp, display processing, canvas writes and PNG
encoding. Exact PNG SHA-256 hashes, output dimensions, extents and transforms
match. Medians use the lower middle sample for twelve measurements.

| Source pixels | Mode | Before | After |
| --- | --- | ---: | ---: |
| 256×256 | Image | 3.8 ms | 3.5 ms |
| 256×256 | Border | 9.4 ms | 7.8 ms |
| 256×256 | Contours | 9.4 ms | 8.2 ms |
| 1024×768 | Image | 43.2 ms | 38.4 ms |
| 1024×768 | Border | 59.6 ms | 57.1 ms |
| 1024×768 | Contours | 100.9 ms | 95.1 ms |
| 2000×1500 | Image | 159.1 ms | 145.4 ms |
| 2000×1500 | Border | 216.8 ms | 204.7 ms |
| 2000×1500 | Contours | 343.6 ms | 339.3 ms |

Small differences, particularly the large contour case, are not a universal
latency guarantee. Color-only updates reuse the existing warp cache and have no
claimed acceleration. Final samples: `logs/broad-performance/images/final-js/`.

## Rust decision

The existing [Rust collision/BVH kernel](rust-routing-performance.md) remains in
autorouting. A separate exact-f64 Rust image kernel passed pixel checks but was
slower across all nine browser fixtures: for example, the 2000×1500 image render
rose from 158.6 to 248.5 ms. Copies were only a minority of the bounded Node
kernel cost. A rounding/conversion refinement did not close the gap, and a
focused Astra review recommended removing automatic dispatch rather than adding
unmeasured unsafe indexing or approximate coordinates.

That kernel and dispatch are removed from the runtime. The initial comparison
and experimental source/binary are retained under
`logs/broad-performance/images/initial-rust/` and `rejected-rust/`. The final
image implementation is the measured JavaScript change above. Rust's routing
artifact remains unchanged at 39,083 Wasm bytes.

## Verification and repetition

`test/fixtures/performance-baseline.json` freezes the relevant original functions
for portable behavior/counter checks. The shared regression does not require
ignored local snapshots. Known-image worker comparisons repeat three times and
match the complete alignment result, including the 0.578621 px boundary RMS.
A separate raw-RGBA test covers 28 affine/projective poses and 232,631 pixels,
transparency, odd dimensions, cache reuse and the output-size cap.

```sh
# Set GDS_BROWSER to a local Chromium executable.
# Set GDS_PYTHON to Python with klayout; component browser tests additionally
# use GDS_TEST_PYTHON and require gdsfactory.
npm run test:performance
npm run test:shared-performance

# Save these before a subsequent edit for a new controlled comparison.
mkdir -p logs/performance-baseline
cp webview/viewer.html logs/performance-baseline/viewer.html
cp webview/microscope-overlay.js logs/performance-baseline/microscope-overlay.js
# After the edit:
npm run profile:web:compare -- logs/performance-baseline/viewer.html
npm run profile:images -- logs/performance-baseline/microscope-overlay.js
```

Functional checks cover components/placement, properties, review/context actions,
layers, ports, image display, selection/deletion, work-order counters, manual
routing and snap lifecycle. TypeScript, production packaging and Rust routing
parity remain part of verification. Host-specific builds, cold Python/factory
startup, file discovery and source navigation have no new latency claim from
these shared-viewer measurements.
