---
id: TASK-19
title: Improve component recovery and layer interaction
status: Done
assignee:
  - codex
created_date: '2026-10-01 06:40'
updated_date: '2026-10-01 07:02'
labels:
  - target-tree
dependencies: []
references:
  - docs/component-layer-review.md
  - test/reliability/layers-viewer.test.js
  - test/reliability/component-catalog-viewer.test.js
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User requests another managed improvement pass. Preserve existing concept functions. Review identified thumbnail error recovery friction, full-layout scans on layer toggles and selected geometry remaining highlighted when hidden.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Failed component thumbnails can be retried without catalog refresh or accidental placement
- [x] #2 Layer toggles update only affected features and hidden selections no longer remain interactive
- [x] #3 Keyboard/browser and managed release regression gates pass with verified installation
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: | Target: reliable everyday component and layer interaction | Deliverable: bounded recovery and visibility improvements | TRIZ framing: recover transient errors and eliminate unrelated layer work without losing exact geometry or source identity | Route: route-bug then route-implementation and route-claim-done | Method: fix retry UI with request isolation, index immutable loaded GDS by layer, clear hidden selection and protect keyboard events, run focused browser then managed release | Gate: real retry request/response and layer visibility/selection/count checks | Budget: controller plus one worker and one release run | Stop: acceptance and exact installed delivery | Branch return: worker evidence integrated before final release
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Branch return: {"version": 1, "child": "TASK-19.2", "link": {"version": 1, "target": "TASK-19", "parent": "TASK-19", "criterion": 2, "criterion_sha256": "963353f73a895bcc876dd002a2d74a43b0607d4e348224e8c9ab937e7fdd4d5a", "purpose": "Hide layers consistently and avoid unrelated feature scans", "return_gate": "Browser per-layer count, deselection, keyboard and reload checks pass"}, "evidence": "test/reliability/layers-viewer.test.js", "result": "Only layer features update; hidden selections and highlights cleared; keyboard and reload checks pass."}

Branch return: {"version": 1, "child": "TASK-19.1", "link": {"version": 1, "target": "TASK-19", "parent": "TASK-19", "criterion": 1, "criterion_sha256": "198f0491c95096326d290d9e773fc0e9cbeb52f0e3bb1d17223c8622a73143ac", "purpose": "Retry thumbnail generation without losing catalog state or entering placement", "return_gate": "Error and timeout retry request isolation plus browser keyboard recovery pass"}, "evidence": "test/reliability/component-catalog-viewer.test.js", "result": "Errors/timeouts recover independently with cache/state preservation; keyboard browser proves no selection or placement."}

Output: Bounded component recovery and consistent indexed layer visibility | Result: Twelve failed previews recover eight plus four without placement; layer toggles update only affected features, hidden selection removed, all eight release stages pass and installed runtime hashes match. | Status: gate_passed | Evidence: docs/component-layer-review.md | Limits: Browser fixtures and operation counts; no universal FPS claim. Reload VS Code to activate. | Target impact: Completes managed TASK-19 preserving existing concept functions.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Improved independent thumbnail recovery and indexed layer visibility, preserving concept functions. Focused browser and all eight release stages passed; exact VSIX installed with runtime hashes and manifest verified. See docs/component-layer-review.md.
<!-- SECTION:FINAL_SUMMARY:END -->
