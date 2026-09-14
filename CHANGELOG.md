# Changelog

All notable changes to this project are documented in this file.
Format based on Keep a Changelog; versioning: SemVer.

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
