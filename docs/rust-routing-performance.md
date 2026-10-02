# Rust/Wasm autorouting

Measured on 2026-10-02 on macOS arm64 with Headless Chrome 147.0.7727.15.
The shared browser and VS Code editor now use a Rust/Wasm collision kernel
while finding guided and automatic routes.

## Change

The original planner scanned every obstacle ring for every candidate point and
segment. Rust builds a bounding-volume hierarchy over obstacle bounds once per
route, skips distant pieces, and performs the existing containment, intersection
and Euclidean clearance calculations on the remaining rings. Rings with holes,
repeated vertices and either explicit or implicit closure retain their meaning.
Calculations use f64 and the original `1e-9` tolerance.

The JavaScript planner still controls A* ordering, reference bias, connectors,
route reduction, angle constraints, search budgets and final validation. Each
route owns one Rust context, released in `finally`, including failed searches.
Normalized obstacles are packed once into a Float64Array. Subsequent collision
queries pass five numbers rather than cloning geometry or crossing the boundary
once per edge. Internal connector/final checks reuse the normalized collection.

The main view compiles the bundled module lazily and transfers it to fresh blob
workers. Existing cancellation terminates the worker. The VS Code script policy
allows `'wasm-unsafe-eval'`; no worker network fetch is required. The JavaScript
collision implementation is the fallback for missing/blocked Wasm, unsupported
coordinates or oversized packed input. Packed input is capped at 4,000,000
doubles and native coordinates at absolute `1e100`; these are native-backend
bounds, not new planner rejection rules. Contexts free their Rust allocations;
the Wasm allocator can retain memory pages for reuse, so this is not a total
memory-reduction claim.

## Controlled comparison

Six timed runs per variant and size alternate variant order. Every run uses a
fresh worker, matching editor cancellation behavior. Each variant receives one
unmeasured warm run first. Medians below use the lower middle of six samples.
All variants return identical route points, success/error state and search
counts. The original planner snapshot is retained locally; the current JS column
isolates the small normalized-collection reuse from the Rust/index change.

| Obstacles | Original JS plan | Current JS plan | Rust/index plan | Original worker latency | Rust/index worker latency |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2.7 ms | 2.4 ms | 1.7 ms | 4.9 ms | 4.2 ms |
| 250 | 105.1 ms | 99.9 ms | 2.0 ms | 107.1 ms | 4.4 ms |
| 2,500 | 988.4 ms | 976.3 ms | 4.6 ms | 991.5 ms | 8.3 ms |

Plan time includes packing, Wasm instantiation, index construction, search and
final collision validation. Worker latency additionally includes creation,
structured cloning and message delivery. First main-thread module compilation
took 2.5 ms and is reported separately. The Wasm binary is 39,083 bytes, embedded
in a local JavaScript asset to avoid platform-specific binary distribution.

These fixtures have one barrier requiring a detour and many small rectangular
pieces outside that corridor. They demonstrate the benefit of skipping distant
obstacles. Dense overlapping obstacles, long references or a large search can
have different costs. The change combines Rust with spatial indexing and does
not isolate a language-only speedup. This benchmark excludes obstacle collection,
mask preview rendering, GDS loading, pan/render FPS and installed VS Code timing.
No whole-editor or universal latency improvement is claimed.

Raw samples, environment, source hashes and route SHA-256 signatures are in
`logs/rust-performance/paired/report.json`. The original planner is
`logs/rust-performance/before/route-planner.js`.

## Build and verification

`media/geometry-kernel.js` is a committed generated artifact. Normal `npm ci`,
`npm run compile` and VSIX packaging verify the Rust-source fingerprint and
Wasm hash without requiring a Rust installation. Rust sources/build outputs
are excluded from the VSIX. After changing the Rust crate, regenerate it:

```sh
npm run build:rust
```

This needs Rust/rustup; the crate pins Rust 1.90.0 and the
`wasm32-unknown-unknown` target and has no external crates. `CARGO` may point to
a custom cargo executable. Run `cargo test --locked` from
`rust/geometry-kernel/` for native core tests with its pinned toolchain.

```sh
# Set GDS_BROWSER to your local Chromium/Chrome executable.
npm run test:rust
npm run profile:rust -- logs/rust-performance/before/route-planner.js

# Optional real VS Code gate; use a test-owned profile, never a user workspace.
# Set VSCODE_EXE to the VS Code executable and GDS_PYTHON to Python with klayout.
npm run test:rust:vscode
```

The differential gate covers 12 complete planner cases and 5,120 seeded collision
queries, including tiny/large scales, holes, closure, duplicate vertices,
off-grid endpoints, tangency, guide bias, native fallback and context disposal.
Independent known-clearance assertions pin the boundary policy. The Chromium
gate enforces the extension's analogous script/worker policy and verifies actual
native execution, compiled-module transfer, unavailable-Wasm fallback and
termination. Existing manual/assisted routing, masks and YAML checks also pass.
These gates exercise routing; they do not certify microscope alignment or
fabrication safety.

The real VS Code 1.140.0 Extension Development Host also passed three separate
window cycles with ten real GDS documents each. Checkpoints at 1, 5 and 10 open
layouts verified the actual webview policy, native/fallback route parity,
context disposal, drawing isolation/restoration and YAML clipboard export.
The first drawing used mouse input. The original clipboard was restored after
each cycle, and only test-owned profiles/windows were used. Evidence is under
`logs/reliability/rust-routing/vscode/`. This is functional host validation, not
an installed-VSIX timing measurement.

`logs/rust-performance/gds-navigator-rust.vsix` is the built extension package.
Its kernel, loader, planner, route UI and production extension-bundle bytes
match the tested checkout; Rust build outputs and local evidence are excluded.
File/package SHA-256 verification is retained in
`logs/rust-performance/vsix-verification.json`.
