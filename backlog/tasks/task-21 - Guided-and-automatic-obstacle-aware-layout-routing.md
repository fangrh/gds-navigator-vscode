---
id: TASK-21
title: Guided and automatic obstacle-aware layout routing
status: Done
assignee:
  - codex
created_date: '2026-10-01 20:40'
updated_date: '2026-10-01 21:03'
labels: []
dependencies: []
references:
  - docs/obstacle-routing.md
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Improve Manhattan routing with drawn reference guidance and automatic avoidance of GDS polygons and microscope image contours, informed by online routing references.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Manual and guided routes have clear canvas interactions and preserve route metadata
- [x] #2 Automatic routes respect width and clearance around GDS and detected image obstacles or report failure without committing
- [x] #3 Image obstacle preview and adjustable detection expose what the planner avoids
- [x] #4 Routing tests, installed extension journey and package checks pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: | Target: guided and automatic layout routing | Deliverable: manual and obstacle-aware route UI with inspectable image mask, software scope | TRIZ framing: route around existing geometry without moving source elements; drawn guide biases route without forcing collisions | Route: software feature, route-new-feature then route-implementation and route-claim-done; existing user request authorizes bounded implementation | Method: primary-source review, bounded planner and mask modules, canvas integration, independent geometric fixtures and browser journeys, package/install | Gate: exact endpoints, style constraints, width-plus-clearance collision checks, detected mask preview, failure without commit, persistence/export and installed runtime tests | Budget: bounded grids and image processing; explicit failure on limits | Stop: routing acceptance passes; no fabrication or connectivity guarantee | Branch return: failed geometric or UI gate gets focused repair before package
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Output: Guided and automatic routing implementation | Result: Added Manhattan and H/V/45 manual routes, drawn-guide A-star routing, worker cancellation, GDS-plus-image obstacles and mask controls. Pure geometric, image-mask, export and browser journey tests pass. Final package verification is running. | Status: artifact | Evidence: docs/obstacle-routing.md | Limits: Image detection is bounded and approximate; endpoints must be clear; no fabrication DRC or photonic bend-loss claim. | Target impact: TASK-21 implementation gates pass; installed runtime and release gates pending.

Output: Routing release and installed validation complete | Result: Nine release stages pass. Installed manual and automatic GDS-plus-image routes preserve clipboard and reopen metadata. Exact VSIX installed normally; all 36 runtime hashes and normalized manifest match. | Status: gate_passed | Evidence: docs/obstacle-routing.md | Limits: Bounded search and approximate image detection; endpoints require clear space; no photonic bend radius, fabrication DRC or connectivity guarantee. | Target impact: All TASK-21 acceptance gates satisfied; child installed-runtime evidence returned.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented manual Manhattan and electrical 45-degree routing, soft drawn-guide and automatic bounded obstacle avoidance with GDS and transformed image masks. Preview, clearance, cancellation, stale-result protection, metadata and export are verified. All nine release stages and installed route/reopen journeys pass; exact VSIX installed and 36 runtime files match. Image masks and bounded search retain documented limits.
<!-- SECTION:FINAL_SUMMARY:END -->
