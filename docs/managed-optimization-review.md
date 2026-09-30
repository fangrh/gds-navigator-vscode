# Managed optimization review — 2026-09-30

Native Backlog target: TASK-18. Its three delivery children cover verification,
inspector interaction, and factory port projection. Backlog owns status and
acceptance; this report retains the release evidence.

| Improvement | Verified result | Scope |
| --- | --- | --- |
| Inspector activation | 201 panel changes produce one resize and one state save; 201 activations of the current panel schedule none | Browser event burst; latest panel state preserved |
| Factory port projection | Moving one of two groups recomputes one group; the untouched port ID/center remains exact | Dirty groups still pass the original rigid geometry gates |
| Port cleanup | 128 plain-feature removals perform no global array indexOf/splice scans | Ordered Map retains live source order; factory piece membership checks remain |
| Accessibility | Tab/panel labels, arrow navigation and collapse-focus restoration pass | Browser checks at 1400, 800 and 500 pixels |
| Verification | Eight sequential release stages pass with runtime, command, duration and raw-log records | Existing concept regression suites and production build |

Release run: `20260930074903119-8b289791`. All stages passed: TypeScript,
performance, reliability, components, alignment, UI, work orders, package.
Detailed results and raw logs are in
`logs/project-verification/20260930074903119-8b289791/`.

The earlier run `20260930074432007-901c5c08` remains recorded as failed. It
passed TypeScript, then stopped because Windows Path/PATH normalization dropped
Node lookup from the child environment. The runner now normalizes the PATH key
and preserves the original search path; a bounded npm smoke and the complete
release rerun passed. No failure was relabeled or discarded.

Full before/after GDS content hashing remains in place. Geometry, component
grouping, port projection gates, source identity, alignment thresholds and
work-order semantics are preserved. Operation counts do not claim universal FPS.

See [project management and verification](project-management.md) for the
check/run/status commands and release process.
