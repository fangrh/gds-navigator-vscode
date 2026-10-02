# Guided and automatic routing

Open **Route** (toolbar or **6**) and choose a workflow:

- **Manual waypoints:** click each waypoint. Enter finishes and Backspace removes
  the last point. Choose Manhattan (90°) or electrical H/V/45° segments.
- **Follow guide:** click a reference polyline, or hold Shift and drag a reference
  line. Press Enter when finished. The guide biases the route but does not force
  it through an obstacle.
- **Auto · endpoints:** click a start and an end. The planner finds a route and
  shows a green preview. **Use route** saves it. Previewing creates no annotation.

Automatic and guided routes use the trace width and clearance in micrometres.
All loaded GDS polygons, including hidden layers, and drawn geometry are obstacles
when the layout checkbox is enabled. Visible microscope images are included when
the image checkbox is enabled. No source geometry is moved. Endpoints must be in
clear space: electrical nets, pad attachment and port orientation are not inferred.

Use **Preview obstacles** to inspect red image obstacle regions. Threshold controls
edge sensitivity. **Contours + fill** also blocks detected closed interiors;
**Contours only** leaves interiors open. Detection uses source-image pixels reduced
to at most 192 pixels on the longer side, then applies the image's current
similarity/projective placement. Review image alignment and the mask. Thin, faint
or open boundaries may be missed; this is not semantic object segmentation.

The planner uses bounded A* search with geometric collision checks. Clearance is
Euclidean distance from a centerline stroke of the entered full width, with round
joins. The search is limited to 40,000 cells around endpoints and the reference,
and runs in a cancellable worker with a 15-second timeout. Increase grid spacing
or shorten the reference if a budget is exceeded; a coarse grid can miss a valid
narrow passage. Failure means no route was found within these settings and bounds.
It does not prove that no geometric path exists.

Changing settings invalidates the preview. The route is also checked for stale
layout/image state before saving. Saved annotations and AI YAML retain style,
width, layer, method and obstacle settings. Later point/segment edits or movement
require a fresh clearance check. This is a layout proposal, not a fabrication DRC,
net connectivity check or photonic bend-loss model.

## Routing styles reviewed

- [KLayout path editing](https://www.klayout.de/doc/manual/create_path.html)
  supports Manhattan, diagonal and unrestricted path constraints, with waypoint
  entry and keyboard completion/backtracking.
- [KiCad routing](https://docs.kicad.org/9.0/en/pcbnew/pcbnew.html#routing-tracks)
  distinguishes collision highlighting, walk-around and shove workflows, and
  supports electrical 45° and rounded corner styles. This implementation follows
  the walk-around approach; it preserves existing geometry.
- [GDSFactory routing API](https://gdsfactory.github.io/gdsfactory/api_routing/)
  includes all-angle bundles with a backbone and Euler-bend components. Rounded
  photonic/Euler routing needs bend-radius and cross-section constraints and is
  not implemented by the electrical 45° style here.

Verification: `npm run test:routing`. Browser screenshots and reports are under
`logs/reliability/route-assist`. The installed `--routes` VS Code journey additionally
exercises the worker, GDS plus image masks, clipboard export and editor reopening.

Final validation (2026-10-02): all nine release stages passed in run
`20261001205028750-e80b4698`. The exact VSIX installed journey passed manual
editing and automatic GDS-plus-image avoidance, clipboard export and reopening,
plus 1/5/10-layout checks. The 36 packaged runtime files match source and the
normal installed extension; the manifest matches after installer metadata is
excluded. Evidence: `logs/reliability/routes-vscode/report.json` and
`package-hashes.json`. Reload VS Code to activate the installed update.
