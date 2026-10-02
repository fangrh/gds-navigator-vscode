# Editor performance checks

For the measured Rust/Wasm autorouting change, see
[Rust routing performance](rust-routing-performance.md). Its comparison measures
route planning and worker latency separately from editor loading and rendering.

The next [shared editor optimization](shared-editor-performance.md) measures
loading, image rendering and repeated style/port/image-control work, including
the rejected Rust image experiment and exact parity checks.

[Source/component reuse](selection-component-performance.md) covers lazy source
lookups, built-in catalog reuse and cancellation-safe concurrent requests.

Run `npm run test:performance` for deterministic operation-count checks. Reports
are written to `logs/performance/`. These checks establish reduced repeated work,
not a universal frame-rate or end-to-end latency improvement.

| Path | Change and evidence |
| --- | --- |
| GDS loading | Add features to the map in one batch. A 3,000-feature fixture emits 2 source-change events, versus 3,000 for individual insertion. Exact geometry is unchanged. |
| Source links | Resolve repeated provenance paths once per load. 10,000 references to one relative file across two roots require 2 filesystem checks instead of 20,000. Reloads create fresh resolvers. |
| Rendering | Bounded style caches preserve color, visibility, labels, selection and route width. Repeated callback fixture allocates 4 styles instead of 500. |
| Selection | Bulk additions use a set instead of repeatedly scanning the selection array; repeated selection keeps unique features. |
| Images | One contour mask per image warp and threshold is reused across color and width changes. The matched small-image fixture performs 1,323 Sobel neighbor visits instead of 2,205; all five output states match byte for byte. |
| Image dragging | Accumulate every pointer displacement and render at most once per animation frame, then render the exact final pose on release. A 201-move burst produces one intermediate render and one final render. |
| Annotation saves | Compare annotations by indexed IDs. A 3,000-item fixture replaces roughly 9 million ID comparisons with 12,000 input visits. Deleting 100 drawings sends one complete save rather than 100 intermediate saves. |
| Work-order rebuilds | Index provenance and geometry keys within each reconciliation when needed, preserving ambiguity and conflicting-source rejection. |
| Frozen work-order targets | Index frozen IDs and drawn annotations once per reconciliation. A 100-target, 1,000-feature mixed relink fixture performs 1,300 ID lookups while retaining match order and ambiguity checks. |
| Sidebar discovery | Repeated and concurrent tree queries share one bounded file scan until a watcher/workspace refresh. Generation checks prevent stale pending scans from repopulating the cache; a failed scan can be retried. Relative paths are computed once per discovered file. |
| Pointer coordinates | A 201-event burst writes the coordinate label once per frame with the latest point. Identical displayed values skip the DOM write; mouse leave clears the label even during a pending update. Browser fixture: test/reliability/eda-workbench.test.js. |
| Inspector activation | A 201-change burst schedules one resize and saves its final panel state once. Reopening the active panel 201 times schedules no work. Browser checks also cover tab/panel labels, arrow navigation, focus restoration and compact layouts. |
| Component ports | Only dirty live factory groups repeat rigid-geometry verification. With two placed groups, moving one recomputes one group and retains the other group's exact port ID and center. Full-versus-cached output checks cover translation, rotation, deformation rejection, conversion, rename, reset and removal. |
| Layer visibility | A document-scoped layer index updates only affected shapes. A three-layer, 3,000-feature browser fixture performs 1,000 visibility writes and zero layer-key scans per toggle. Hidden selections are removed; exact coordinates and source identity remain. |

Properties continue to preserve exact numeric and mouse transforms. Their
inspector updates occur at edit completion; geometry updates required for live
drag feedback remain. Component browsing retains the earlier bounded preview
cache, incremental icons and animation-frame placement updates.

GDS parsing still performs the full exact parse and before/after content checks.
This change does not cache stale layout data or reduce polygon detail. Image
alignment algorithms and their acceptance thresholds are unchanged. Cache memory
is bounded or scoped to a current image/load/reconciliation; cold generation and
large-layout costs still depend on the input and machine.
