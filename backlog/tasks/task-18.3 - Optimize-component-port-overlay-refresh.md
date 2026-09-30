---
id: TASK-18.3
title: Optimize component port overlay refresh
status: Done
assignee:
  - luna
created_date: '2026-09-30 07:34'
updated_date: '2026-09-30 07:47'
labels: []
dependencies: []
references:
  - test/reliability/port-overlay.test.js
  - test/reliability/ports-viewer.test.js
parent_task_id: TASK-18
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Targeted audit evaluates repeated port overlay projection during component placement and transforms.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Port optimization produces matching output and avoids redundant work
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: | Target: reduce port projection work under TASK-18 | Deliverable: per-live-group dirty projection with output equivalence | TRIZ framing: reduce unrelated verification without relaxing dirty-group geometry gates | Route: route-implementation | Method: track group events, preserve existing rigid verification, compare incremental output through transform/deformation/removal/reload, run browser port checks | Gate: exact output equivalence and bounded group verification counts | Budget: bounded worker patch and focused ports checks | Stop: focused tests and release integration pass | Branch return: evidence to parent criterion 1
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Target link: {"version": 1, "target": "TASK-18", "parent": "TASK-18", "criterion": 1, "criterion_sha256": "2a0a6d4401f3fd853eb1150b8097bf1eb1973d3763e8a172e12fe01a60188227", "purpose": "Reduce repeated port projection work with exact identity and transform verification preserved", "return_gate": "Operation-count and exact port behavior tests pass"}

Output: incremental factory port projection | Result: cached and full outputs match through transforms, deformation rejection, resets, conversion and ordering changes; actual two-group browser wiring recomputes only the moved group, retaining exact untouched IDs/centers. Ordered Map avoids global array scans during 128 removals. | Status: gate_passed | Evidence: test/reliability/port-overlay.test.js | Limits: deterministic checks rather than universal FPS; full dirty-group rigid validation remains. | Target impact: fulfills parent repeated-work criterion.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Project only dirty live factory groups with unchanged rigid verification; exact-output lifecycle and browser checks pass; ordered Map cleanup avoids global removal scans.
<!-- SECTION:FINAL_SUMMARY:END -->
