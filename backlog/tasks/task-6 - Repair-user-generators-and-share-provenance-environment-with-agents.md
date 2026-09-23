---
id: TASK-6
title: Repair user generators and share provenance environment with agents
status: Done
assignee:
  - root
created_date: '2026-09-22 13:18'
updated_date: '2026-09-22 13:55'
labels: []
dependencies: []
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Final scope is plugin only. Preserve latest external D:/gds2027 sources and layouts. Finish folder onboarding, shared agent environment and provenance status.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 First GDS open offers a checked folder default with agent launch instructions. Reopening restores it.
- [x] #2 Copied selections and work orders include runtime context. Unrelated sidecars cannot falsely indicate full provenance.
- [x] #3 Focused tests and real VS Code journeys pass. Updated plugin installed and external final sources preserved.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Set up project-local fork environment; convert generator output through tracked gdsfactory; compare geometry; add shared agent/VS Code entry point and diagnostics; validate and install any plugin changes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
User clarified geometry acceptance must use the original repository reference GDS, not the earlier procedural generators. Concurrent external edits replaced both scripts with exact-coordinate arrays; preserve those arrays and adapt only tracked construction. Earlier 1839 comparison report is historical, not final acceptance. Final gate is canonical per-layer/datatype polygon multiset equality against fixtures plus unchanged array literals and complete source/loop provenance. Generic first-open checked folder setup and agent runtime handoff implemented; three isolated window cycles passed.

User explicitly requested keeping the other agent files and finishing only the plugin. No further external generator or GDS edits after that instruction. Latest exact-fixture report retains a failed stricter loop-index check from source churn. That source gate is outside revised scope and is not reported as passing. Read-only UI checks use copies of current user GDS and sidecars.

Final plugin verification passed: npm run test:environment, provenance-contract, build-contract, review/instruction-provider, test:ui, tsc and production VSIX. Real onboarding/restarts report has 7 records. Read-only current user-layout UI report has 2 records with 1818/1818 source references each. Installed bundle SHA256 7ABCC1800B2C26D128B860E51554383CBBEC6A18AFF4C0F62B2FB900BA079BFE matches build. See ISSUES TASK-6 for retained failed source gate and user scope change.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Installed first-open checked folder environment setup, shared agent launcher/runtime context and coverage-based provenance status. Tested real VS Code onboarding/restarts and current layout copies. Preserved latest external generator files per user instruction.
<!-- SECTION:FINAL_SUMMARY:END -->
