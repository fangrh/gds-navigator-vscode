# Component recovery and layer interaction

TASK-19 improves everyday catalog and layer interaction while preserving exact
GDS geometry, component factories, ports, provenance, alignment and work orders.

Failed component thumbnails have a separate keyboard-accessible retry control.
Recovery preserves successful thumbnails and current catalog settings, ignores
stale replies and avoids component selection or placement. Requests retain the
host's eight-name batch limit. The toolbar wraps within a narrow inspector.

Loaded GDS features are indexed by layer for the current document. Visibility
toggles visit only that layer's features and the legend reports its shape count.
Hiding a layer removes hidden features from selection and suppresses their
highlight; showing it again does not restore the removed selection. Enter and
Space on a layer checkbox cannot finish a route. Reload rebuilds the index.

The browser fixture contains 3,000 features across three layers. Each toggle
writes visibility on 1,000 features with zero layer-key scans, retaining feature
identity and exact coordinates. This is an operation-count result; whole-frame
rendering cost and large-layout latency still depend on the layout and machine.

Focused evidence: `test/reliability/layers-viewer.test.js`,
`test/reliability/component-chooser.test.js` and
`test/reliability/component-catalog-viewer.test.js`. The managed release profile
includes these regressions.

The first release run, `20261001064729984-1c842ee8`, passed TypeScript,
performance and reliability but failed the component browser test: it sampled
the request log before the scheduler sent the retry. The regression now waits
for the new correlated request. That failed run is retained alongside the
batch-limit repair evidence in TASK-19.1.1.

Final release run `20261001065605089-c595e9f0` passed all eight stages in
204,478 ms of stage time. Raw stage logs and result are retained under
`logs/project-verification/20261001065605089-c595e9f0/`.
The exact VSIX was installed. Reviewed runtime files and manifest contents
match the installed extension, excluding VS Code installer metadata;
`logs/reliability/task-19-installed.json` records the delivery hashes.

The operation review found no pending validation, unchanged repeated checks
or new skill proposals. The release's stage timings remain available for
future targeted improvements. No scientific matrix change is warranted.
Reload VS Code to activate the installed extension.
