# Shared layout loading performance

TASK-23, measured 2026-10-02. This change is in `webview/viewer.html`, which both
the VS Code extension and browser host load. The browser host was used for all
measurements and interaction checks; VS Code was not launched.

## Mechanism

The CPU profile identified unnecessary segment-index work during layout source
clearing and insertion. OpenLayers Snap continues tracking source changes while
its interaction is inactive. Setting `active` to false only disabled input
handling; the editor still paid the indexing cost on every load.

Snap interactions now attach when snapping is enabled and detach when disabled.
During document replacement, all three snap interactions detach, the layout
source clears in bulk, and enabled snapping reattaches to the new sources in a
`finally` block. Interaction order stays GDS, drawings, grid at the end of the
map's collection. Drawn-feature removal events remain unchanged for annotation
persistence and port updates. Geometry conversion, layer indexing, provenance,
styling, selection and routing calculations are unchanged.

This follows the installed OpenLayers source implementation. The public API
documents [Snap activation and map attachment](https://openlayers.org/en/latest/apidoc/module-ol_interaction_Snap-Snap.html)
and [VectorSource fast clearing](https://openlayers.org/en/latest/apidoc/module-ol_source_Vector-VectorSource.html).
Fast clearing skips per-feature removal events, so detaching Snap first is
essential to avoid stale segments after reload.

## Controlled comparison

Chromium headless 149.0.7827.55 on this Windows machine, 1400×900 viewport,
deterministic eight-layer polygon grids. Each size is fitted before timing.
Fresh browser processes run before, after, after, before, using a saved original
viewer and identical current assets. Each variant has six loads with snapping
off, six with snapping on, and eighty pan/render samples. CPU sampling is on
for both. Ordered geometry/property SHA-256 signatures match between variants.

Median times, in milliseconds (upper middle sample for even sample counts):

| Features | Measurement | Before | After |
| ---: | --- | ---: | ---: |
| 1,000 | End-to-end load, snap off | 77.4 | 49.5 |
| 1,000 | Shared viewer load, snap off | 20.1 | 9.0 |
| 1,000 | End-to-end load, snap on | 50.8 | 64.1 |
| 1,000 | Shared viewer load, snap on | 19.7 | 15.1 |
| 1,000 | Pan/render | 3.3 | 3.4 |
| 10,000 | End-to-end load, snap off | 496.1 | 332.2 |
| 10,000 | Shared viewer load, snap off | 195.1 | 63.7 |
| 10,000 | Layout source clear, snap off | 86.3 | 8.6 |
| 10,000 | Layout source insertion, snap off | 63.9 | 15.6 |
| 10,000 | End-to-end load, snap on | 703.3 | 573.0 |
| 10,000 | Shared viewer load, snap on | 309.2 | 207.6 |
| 10,000 | Pan/render | 46.1 | 44.8 |

The 10,000-feature fixture shows 67% less synchronous shared-viewer load time
and 33% less end-to-end load time with snapping off. End-to-end load includes
HTTP, JSON and two animation frames. The small active-snap fixture's end-to-end
time increased despite reduced viewer work; no improvement is claimed there.
No meaningful pan/render improvement is claimed from this loading change.

The index is now built when enabling snapping: the two-run upper-median enable
time was 71.2 ms for 10,000 features (previously 5.4 ms because indexing had
already happened at load). This is the intentional timing tradeoff. Subsequent
active snapping still tracks drawing additions, edits and removals immediately.
Larger layouts can have a longer enable pause; these observations are not a
universal latency/FPS guarantee or a memory reduction claim.

Raw final repetitions, CPU profiles, screenshots, source hashes and the aggregate
comparison are under `logs/reliability/shared-performance/final-paired/`.
The original viewer is `logs/reliability/shared-performance/before/viewer.html`.
Earlier diagnostic runs are retained in `before/`, `after-snap/` and `paired/`;
only `final-paired/` includes the final snap-on comparison. Do not compare the
historical browser-development baseline directly: its camera remained fitted
to the smaller preceding layout.

```powershell
$env:GDS_COMPARE_OUT = 'logs/reliability/shared-performance/recheck'
npm run profile:web:compare -- logs/reliability/shared-performance/before/viewer.html
```

## Validation and scope

Passed TypeScript checking, extension compilation, load/style performance
behavior checks, selection and provenance contracts, and browser tests for
layers, ports, drawing/reload/image restoration and route assistance.
`test/reliability/snap-lifecycle.test.js`, included in `npm run test:web`, checks
actual OpenLayers snap results, drawing add/edit/remove, off/reload/on and
on/reload transitions, stale-target removal, interaction priority, geometry,
provenance and browser errors.

The first route validation invocation used a nonexistent test filename; the
correct existing `route-assist-viewer.test.js` passed. No acceptance gate was
changed. The final performance run was sequential and separate from browser
tests and builds.

Rust/Wasm was not introduced. The measured bottleneck was unnecessary
OpenLayers object/event/index maintenance, which this change removes directly.
A compiled numeric kernel would still need to cross back into those objects.
Rust remains an option if a later profile identifies substantial geometry
computation with a practical typed-array boundary; that was not established
by this profile. No installed-VSIX performance claim is made by browser tests.
