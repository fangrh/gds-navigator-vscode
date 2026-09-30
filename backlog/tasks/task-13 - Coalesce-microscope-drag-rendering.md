---
id: TASK-13
title: Coalesce microscope drag rendering
status: Done
assignee:
  - '@codex'
created_date: '2026-09-28 11:35'
updated_date: '2026-09-28 11:38'
labels: []
dependencies: []
references:
  - docs/performance.md
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The image drag path recomputes a full warped raster on every pointermove. Reduce redundant renders while preserving exact final transform and persisted image state.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A burst of pointer moves before a frame produces at most one intermediate render
- [x] #2 Pointer release renders the exact final transform and saves it once
- [x] #3 Focused image and viewer checks pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: | Target: responsive image dragging | Deliverable: coalesced render calls with exact final position | TRIZ framing: reduce redundant full rasters without losing pointer displacement | Route: route-implementation | Method: accumulate position synchronously, render once per frame, force final render | Gate: burst and release operation-count tests plus image checks | Budget: local deterministic fixture | Stop: focused checks pass | Branch return: diagnose any transform or save mismatch
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Output: Microscope drag rendering coalesced | Result: 201 pointer moves create one intermediate warp and one final warp at exact pose; focused image, UI and performance suite pass. | Status: gate_passed | Evidence: docs/performance.md | Limits: Synthetic event burst establishes render count, not measured frame rate. | Target impact: Reduces repeated full-image warps during drag.

201-move VM fixture: 1 intermediate plus 1 final render, final pose 402,-202. Image checks, browser UI, performance suite and production build passed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Coalesced image drag warps to one per animation frame and forced exact final render on release. Focused image, browser UI, performance and production build checks passed.
<!-- SECTION:FINAL_SUMMARY:END -->
