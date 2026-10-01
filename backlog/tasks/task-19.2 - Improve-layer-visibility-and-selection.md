---
id: TASK-19.2
title: Improve layer visibility and selection
status: Done
assignee:
  - codex
created_date: '2026-10-01 06:42'
updated_date: '2026-10-01 06:52'
labels: []
dependencies: []
references:
  - test/reliability/layers-viewer.test.js
parent_task_id: TASK-19
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Legend scans every GDS feature per toggle; selected style precedes visibility, leaving hidden selected geometry visible.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Only affected layer features are updated and hidden features stay deselected
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: Target: consistent layer visibility with less repeated work | Deliverable: document layer index and hidden selection removal | Route: route-bug and route-implementation | Method: preserve feature references, update only layer and isolate keyboard events | Gate: exact geometry, selection, counts, reload browser checks | Stop: focused and release gates pass

TRIZ framing: scope work to a layer while preserving geometry and source identity. Budget: one focused browser fixture and managed release. Branch return: selection and per-layer count evidence to parent criterion 2.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Target link: {"version": 1, "target": "TASK-19", "parent": "TASK-19", "criterion": 2, "criterion_sha256": "963353f73a895bcc876dd002a2d74a43b0607d4e348224e8c9ab937e7fdd4d5a", "purpose": "Hide layers consistently and avoid unrelated feature scans", "return_gate": "Browser per-layer count, deselection, keyboard and reload checks pass"}

Output: indexed layer visibility and selection | Result: 3000-feature browser fixture updates 1000 affected features with zero layer-key scans; hidden selected highlight suppressed, selection removed, Enter/Space isolated, reload clears index and exact coordinates preserved. | Status: gate_passed | Evidence: test/reliability/layers-viewer.test.js | Limits: operation counts do not establish universal rendering latency. | Target impact: parent criterion 2 satisfied.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Indexed loaded GDS by layer, removed hidden selections and isolated legend keyboard input; browser identity, geometry, count and reload checks passed.
<!-- SECTION:FINAL_SUMMARY:END -->
