---
id: TASK-23
title: Optimize shared editor performance using browser measurements
status: Done
assignee:
  - '@codex'
created_date: '2026-10-02 11:38'
updated_date: '2026-10-02 11:50'
labels:
  - target-tree
dependencies: []
references:
  - logs/reliability/shared-performance/before/report.json
  - docs/shared-loading-performance.md
  - test/reliability/snap-lifecycle.test.js
  - logs/reliability/shared-performance/final-paired/comparison.json
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Continue the shared browser/plugin performance work. Measure actual browser CPU and rendering costs, preserve geometry/provenance and interaction semantics, and improve the identified bottleneck. User permits Rust when required; language changes need measured justification. No VS Code launch is required for this shared browser-code task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Repeatable before and after browser measurements identify and improve at least one dominant shared-code bottleneck on equivalent fixtures.
- [x] #2 Geometry, provenance, feature order, selection, layer visibility, ports and drawing semantics remain covered by focused behavioral and browser checks.
- [x] #3 Builds and relevant regression gates pass, performance evidence and Rust decision are documented, and the browser remains usable without VS Code.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: | Target: continue improving the same browser and VS Code editor without changing geometry or user behavior. | Deliverable: shared-code optimization with before/after measurements and regression evidence; personal-use software claim. | TRIZ framing: reduce repeated rendering/loading work while retaining exact geometry, source identity and editing behavior; separate invariant state from per-frame work. | Route: workflow_optimization; route-process-bottleneck mixed-duration-diagnosis then measured-stage-optimization, route-implementation and route-claim-done; direct focused fallback for unavailable superpowers skills. | Method: preserve current source baseline, instrument actual shared load/render operations and browser CPU profile, change the dominant stage, compare paired equivalent workloads and relevant behavior tests. Consider Rust/Wasm only for a demonstrated numeric hot loop where transfer and packaging costs permit an improvement. | Gate: same fixtures and feature/geometry signatures, visible/selection/port semantics retained, measurable median stage improvement on 1000/10000 polygons with raw repetitions, relevant tests and builds pass. | Budget: bounded CPU profiles and same-machine comparisons, one dominant repair at a time; no VS Code launch. | Stop: finish after measured shared-code gain and behavioral gates; do not pursue unrelated features. | Branch return: any failed optimization or correctness gate returns to unchanged baseline and original acceptance, with evidence retained.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Output: Browser CPU profile identifies avoidable Snap indexing during inactive use | Result: On 10000 polygons the instrumented before run spends 168.2 ms clearing and 160.1 ms adding layout features over three loads; viewer total 457.6 ms. Detaching Snap while off and bulk clearing reduces viewer total to 171.1 ms in the first after run. | Status: provisional | Evidence: logs/reliability/shared-performance/before/report.json | Limits: Initial separate same-machine runs with CPU sampling; alternating paired repetitions and behavior gates still required. These are browser CPU observations, not universal FPS. | Target impact: Identifies a shared-code bottleneck with a bounded remedy; Rust is not needed for redundant OpenLayers event/index work.

Output: Shared loading optimization validated in the browser | Result: Alternating before/after/after/before runs on 1000 and 10000 polygon fixtures passed ordered geometry/property hashes. For 10000 features with snapping off, viewer load median 195.1 to 63.7 ms and end-to-end 496.1 to 332.2 ms; active-snap viewer load 309.2 to 207.6 ms. Builds and focused behavior checks pass. | Status: gate_passed | Evidence: logs/reliability/shared-performance/final-paired/comparison.json | Limits: Local Chromium headless with CPU sampling and upper-middle median summary. First snap enable now builds index (71.2 ms for 10000); no pan/FPS or memory gain claimed; 1000-feature active-snap end-to-end did not improve. No installed-VSIX measurement. | Target impact: Shared browser/plugin source loading measurably improved without changing geometry or editing semantics; Rust unnecessary for this bottleneck.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Optimized the shared viewer by detaching Snap while unused and during replacement, then bulk-clearing layout sources and restoring enabled snapping in order. Final alternating browser measurements show 67 percent less shared viewer load time and 33 percent less end-to-end load time at 10000 polygons with snapping off. Geometry and property hashes match; focused build, source and browser gates pass. Added reusable CPU/stage profiling and snapshot comparison. Snap enable now pays index cost; no universal FPS or memory claim. Rust not needed. Full evidence and limitations are in docs/shared-loading-performance.md.
<!-- SECTION:FINAL_SUMMARY:END -->
