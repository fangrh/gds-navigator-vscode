---
id: TASK-1
title: EDA canvas context menu
status: Done
assignee:
  - root
created_date: '2026-09-22 11:15'
updated_date: '2026-09-22 11:26'
labels: []
dependencies: []
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Users need common selection and editing actions at the pointer instead of searching toolbars.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Context actions reflect GDS, drawings, empty canvas and active tools without destructive GDS edits.
- [x] #2 Pointer and keyboard menu interactions, dismissal and viewport bounds pass rendered browser checks.
- [x] #3 Focused regressions and extension build pass; sources and screenshot evidence documented.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use KiCad selection-aware menu conventions; reuse viewer commands; test real pointer interactions and guards; document evidence.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Compared official KiCad 9 context-menu and KLayout mouse documentation. Browser checks cover selection, copy, drawing-only delete and keyboard. Rebuild-dismiss failure retained and being repaired. TRIZ has 23 routes; seven customized route conflicts preserved, existing contract and ignored logs verified, hooks present-not-verified.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added KiCad-inspired selection-aware canvas context menu. Sixteen rendered browser cases, UI regressions, TypeScript/compile and three isolated VS Code journeys passed. Screenshots: logs/reliability/context-menu. GDS editing remains work-order based.
<!-- SECTION:FINAL_SUMMARY:END -->
