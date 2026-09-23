---
id: TASK-2
title: Context actions and sidebar review tools
status: Done
assignee:
  - root
created_date: '2026-09-22 11:34'
updated_date: '2026-09-22 11:58'
labels: []
dependencies: []
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Keep object actions near the pointer while giving measurements, similarity, snapshots and bookmarks a persistent review surface. Carry exact selected context into AI work orders.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Overlap choice, related orders, change requests, layer isolation and image lock work through context actions.
- [x] #2 Sidebar supports measurement, explicit similar-selection preview, bookmarks, previous-build comparison and annotated AI capture.
- [x] #3 Review data stays per GDS across reopen, malformed/stale data is rejected and focused browser/provider checks pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add pure tested review algorithms and isolated host persistence/export in parallel; integrate one Review sidebar with compact action groups; validate real rendered flows, document scope and evidence.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented compact context groups plus one Review tab. Rendered tests pass overlap choice, draft-only requests, layer restore, explicit similarity preview, related-order filtering, measurements, bookmark rename/restore, image lock, annotated PNG generation and per-document guards. Real VS Code three-scenario journey passed bookmark save/reopen and 1-added build comparison. Capture provider edge tests are being finalized; no native Done claim yet.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented context/sidebar split with persistent review tools, exact annotated AI capture and previous-build comparison. Pure/store/runtime-provider/browser checks and real VS Code rebuild/reopen journeys passed. Evidence in logs/reliability/review-tools and work-orders-vscode.
<!-- SECTION:FINAL_SUMMARY:END -->
