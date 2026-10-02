# Browser development

The browser app runs the same `webview/viewer.html`, OpenLayers bundle,
`webview/*.js` tools and worker sources that the VS Code extension loads.
`web/host-services.ts` bundles the existing annotation, geometry identity,
selection export, component catalog, review and work-order modules from `src/`.
Both hosts call `src/parseGdsCore.ts`; the VS Code adapter only supplies its
configured timeout. Parsing, cancellation, output limits and provenance mode
classification therefore share one implementation.
Fix editor behavior in those shared files so both versions receive the change.
`web/browser-host.js` replaces only the VS Code messaging/clipboard/file UI.

## Start

With the repository dependencies installed (`npm ci` on a fresh checkout):

```powershell
npm run dev:web
```

Open http://127.0.0.1:4173. The bundled 50 µm JJ pad sample loads without Python.
Use the file selector for layouts in the workspace, or Upload for a GDS/GeoJSON
file outside it. GDS parsing uses the existing `python/parse_gds.py` and requires
`klayout`. Component previews require `gdsfactory`. Nothing is installed
automatically. Choose an existing environment explicitly if needed:

```powershell
npm run dev:web -- --root D:\my-layouts --python D:\my-layouts\.venv\Scripts\python.exe --file layouts\chip.gds --port 4173
```

Python precedence: `--python`, `GDS_PYTHON`, a local `.venv-fork`/`.venv`, then
`python` on PATH. `--root` selects readable layouts and source files. The server
binds only to `127.0.0.1`; it rejects foreign origins and does not serve the
repository as an unrestricted static directory. It is a local debugging app,
not a deployed multi-user service.

The server renders current viewer sources on every page request. Reload the
page after JavaScript/CSS/HTML edits. Restart after host or shared TypeScript
changes; the host bundles those modules on startup. OpenLayers changes require
`npm run build:webview`, which also runs automatically at startup.

## Editing and storage

- Draw, select, inspect, route, align microscope images, review and place built-in
  factory components using the real editor controls.
- Annotations, images and review state survive reloads and are isolated by the
  absolute layout path. Work orders use the existing queue and tracking code.
- Debug data lives in `logs/browser-dev/<workspace-hash>/`, separate from the
  extension's project state. Use `--state-dir PATH` for a disposable session.
  Download session exports the current data and frozen work orders as JSON.
- The host checks the layout hash before saving edits. If another process
  changes the file, reload before continuing. Existing source layouts are not
  overwritten; browser drawing remains a proposal, as in the plugin.
- Reading GDS from the workspace preserves adjacent provenance sidecars. Upload
  imports a single file; use `--root` for a layout plus its sidecars and scripts.

Host-specific differences are explicit: Reload reads an existing output; run
the generating Python script in a terminal to rebuild it. Source navigation
downloads readable source text. Environment installation, script association,
source-file undo, VS Code workspace commands and trusted project factory imports
remain extension/terminal workflows. Browser clipboard access depends on the
browser's permission and is reported only after the write succeeds.

## Debug and measure

Open browser DevTools. `window.__gdsDebug` exposes a bounded host-message trace,
errors, timings, `load(path)`, `flush()` and `exportTrace()`. Large geometry and
image payloads are summarized to avoid turning debug logging into a memory or
rendering bottleneck. The Diagnostics panel provides the same local trace.

```powershell
npm run test:web
npm run profile:web
```

Set `GDS_BROWSER` to an installed Chromium/Chrome/Edge executable if automatic
discovery does not find one. Tests use an isolated temporary state directory,
the actual GDS parser and actual canvas interactions; no VS Code process is
launched. Reports and screenshots go under `logs/reliability/browser-host/`.

The profiler uses deterministic 1,000- and 10,000-polygon fixtures fitted to a
1400×900 viewport. It records three loads with snapping off, three with it on,
forty pan/render samples, inclusive load-stage timings, geometry/property hashes
and JavaScript heap in `logs/reliability/browser-performance/report.json`.
Open the accompanying `browser.cpuprofile` in Chrome DevTools Performance to
inspect the sampled CPU stacks. `GDS_PROFILE_OUT` selects another output directory.

For a shared viewer change, save the current viewer before editing it, then
compare in alternating before/after/after/before order on the same machine:

```powershell
New-Item -ItemType Directory -Force logs/performance-baseline
Copy-Item webview/viewer.html logs/performance-baseline/viewer.html
# Make the shared viewer change, then:
npm run profile:web:compare -- logs/performance-baseline/viewer.html
```

The comparison uses the snapshot only for `viewer.html`; all other assets and
the browser host are identical current sources. It checks ordered geometry and
properties and retains every repetition under
`logs/reliability/shared-performance/paired/`. Use a separate checkout for a
comparison that also changes other modules. Run relevant behavior tests too.
CPU sampling adds overhead; rendering timings measure browser CPU work rather
than GPU completion, and heap excludes GPU/process memory. These measurements
do not imply universal FPS or replace installed-extension tests for VS Code
host changes. See [the shared loading optimization](shared-loading-performance.md).

## Verification recorded on 2026-10-02

`npm run test:web` passed API and Chromium journeys covering real GDS parsing,
invalid/stale saves, file/origin boundaries, drawing, queued writes during a
document switch, reload and image restoration at 320, 390 and 1400 px. The API
suite also checks durable review bookmarks, YAML, work orders and real factory
catalog/preview (requires `klayout` and `gdsfactory` in the chosen Python).
The existing provenance contract, EDA workbench, route-assist browser and
render-style behavior tests passed; TypeScript and extension compilation passed.

First local profiling baseline (Chromium headless, 1400×900):

| Features | Median load | Median pan/render | p95 pan/render |
| --- | ---: | ---: | ---: |
| 1,000 | 73.2 ms | 2.8 ms | 4.0 ms |
| 10,000 | 386.5 ms | 14.1 ms | 19.0 ms |

These are historical starting measurements, not a before/after speedup. That
initial profiler preserved the smaller fixture's camera when loading 10,000
features; the current profiler fits each fixture before timing, so its pan and
load timings must not be directly compared with this table. Raw reports and
screenshots are in the local `logs/` directories described above.
