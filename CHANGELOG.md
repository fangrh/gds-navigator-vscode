# Changelog

All notable changes to this project are documented in this file.
Format based on Keep a Changelog; versioning: SemVer.

## Unreleased

### Added
- Rust/Wasm collision checks with a spatial obstacle index for guided/automatic
  routing, shared by VS Code and the browser host, with JavaScript fallback.
- Local browser development host using the same editor and domain modules as
  the extension, with persistent debug sessions, browser tests and profiling.
- Guided and automatic routing around GDS and detected image obstacles, with
  adjustable clearance, mask previews, cancellation and explicit failure states.
- Electrical 45° route style and manual waypoint backtracking.

### Fixed
- First canvas selection avoids OpenLayers' blocking 150 ms readback benchmark;
  the hit canvas uses an explicit readback hint, with unchanged picking semantics.
- Provenance setup names the required fork branch, and real Python provenance
  checks support macOS/Linux and fail for missing explicit test interpreters.
- Repeated source navigation uses lazy provenance indexes; built-in component
  catalogs/previews reuse bounded results and concurrent child processes with
  independent cancellation and explicit fresh library refreshes.
- Shared viewer initialization, style caches, port refresh and image controls
  avoid redundant work. Image warping avoids per-pixel point tuples, and worker
  marker extraction reuses its decoded canvas with identical alignment results.
- Shared editor loads avoid maintaining snap indexes while snapping is off;
  document replacement clears old indexes in bulk and restores active snapping.
- Component catalog keyboard navigation with arrow keys, Home/End, and
  Enter/Space activation, including filtered results.
- Inspector and header layout in narrow split editors down to 320 px.


## [0.1.0] - 2026-09-14

First working release.

### Added
- Custom editor for .gds files (OpenLayers canvas, layer legend with per-layer
  visibility, provenance indicator).
- Provenance support: sidecar auto-detection (`<name>.provenance.json` then
  `<name>.json`), embedded TEXT/property provenance, click-to-source with
  call chain, jump back (Select Features by Source Line).
- Python integration: environment picker (conda + manual path), rebuild button
  (runs the generating script with GDS_PROVENANCE=1 through an isolated venv),
  auto-refresh after rebuild, no-sidecar appointment flow.
- AI-agent handoff: selection summary to the GDS Navigator output channel,
  Copy Selection as YAML (clipboard) with loop_index/array_index tuples
  (zero-based, outermost first), Ctrl+A index-ladder selection (element ->
  drop innermost index -> whole placement line -> clear).
- Microscope image overlay: insert PNG/JPG, drag/scale/rotate/opacity manual
  adjustment, fully automatic edge-based registration (oriented chamfer
  distance, trimmed kernel excluding structures absent from the layout,
  refine-first candidate ranking, marker-pitch prior, tiled search for
  small-FOV photos).
- Diagnostics: GDS Navigator output channel logs every message, run, and
  copy; webview errors surface via window.onerror.
