# Source navigation and component reuse

Measured 2026-10-02 on the same macOS arm64 checkout as the preceding shared
editor work. These optimizations retain the existing loading, image and Rust
autorouting changes.

## Source lookups

`source-selection.js` builds document-scoped indexes only when a source lookup
or Ctrl+A expansion first needs them. A normal layout load does not build these
indexes. Source lookup retains case-insensitive slash-normalized paths,
resolved-file preference, parsed line rules, direct matches before call-chain
matches, original feature order and `ol_uid` deduplication. A valid call-chain
reference is indexed even when its primary provenance line is absent.

The Ctrl+A line index preserves its separate case-sensitive raw-file and strict
line semantics. Nested loop/array prefix matching and the label/cycle ladder are
unchanged. Returned arrays are independent of index buckets. Load/reload resets
the indexes; replacing a live feature's provenance object invalidates them
through one source listener. Provenance is treated as immutable within a loaded
document; edits to sidecars are reflected by reloading the document.

On 10,007 mixed direct/call-chain fixture features, 100 warm matcher queries took
107.58 ms with the original scans and 8.46 ms with the index, about **12.7×**.
This times matching, not the subsequent highlight, export or viewport animation.
First-query index construction is outside that warm comparison and costs a full
pass over the document. The browser gate verifies two full scans become zero
for a warm query, exact source selection order, the complete Ctrl+A ladder,
provenance replacement and reload reset. Evidence:
`logs/next-performance/source/report.json` and `viewer-report.json`.

## Built-in components

Built-in catalog results use a 30-second cache limited to eight entries and
2 MiB. Keys include the Python executable, bridge script context and project
root state. Every caller receives a clone. Roots containing `gds_components.py`
bypass catalog/preview reuse so arbitrary project helpers execute freshly.
Project previews remain independent; this does not introduce a persistent Python
process or remove the isolated geometry-parser subprocess.

Identical eligible catalog and preview misses share one child process. Each
subscriber owns its cancellation: one abort leaves other subscribers running,
and the last abort terminates that child. Failures are not cached. Context is
rechecked before cache insertion. Explicit Refresh starts a new request, clears
that environment/root's catalog, preview and thumbnail caches, and prevents
superseded jobs or late thumbnails from repopulating them. Existing subscribers
can still receive the snapshot they requested.

A real gdsfactory 9.45.0 comparison alternated original, current, current,
original, using fresh module state for each run. Catalog JSON SHA-256 signatures
matched. Each run made one cold call and three repeated calls:

| Measurement | Original | Current |
| --- | ---: | ---: |
| Cold median | 970.69 ms | 952.31 ms |
| Repeated median | 951.50 ms | 0.90 ms |
| Python children for four calls | 4 | 1 |

Only the repeated-call improvement is attributed to the cache. Cold imports,
new factory settings and registry-backed project factories retain their normal
cost. The cache is useful across reopened viewers and repeated host requests;
the chooser already had its own local preview cache. Report:
`logs/next-performance/components-final/report.json`.

## Verification

Frozen original source-selection functions are committed in
`test/fixtures/source-selection-baseline.json`. Node gates cover ordering, unusual
line values and bucket isolation. Browser gates cover exact selection sequences,
invalidation, Ctrl+A and project component refresh/placement. Mocked process
gates cover cloned results, forced freshness, cancellation, failures, script/root
changes, cache bounds and late-thumbnail suppression. TypeScript and production
builds pass. Three isolated real VS Code window cycles validate source and
call-chain selection and Ctrl+A alongside routing, image pixels, clipboard and
drawing persistence at 1/5/10-file checkpoints.

```sh
npm run test:component-cache
# Set GDS_BROWSER to your local Chromium executable.
npm run test:selection-index
# Set GDS_PYTHON to Python with gdsfactory/klayout; save this source before edits.
npm run profile:components -- PATH_TO_ORIGINAL_componentCatalog.ts
```

No universal responsiveness or every-function speedup is implied by these local
matcher/cache measurements. Raw geometry, source identity, project execution
and the previous numeric/fidelity gates remain authoritative.
