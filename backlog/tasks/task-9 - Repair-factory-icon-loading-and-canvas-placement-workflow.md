---
id: TASK-9
title: Repair factory icon loading and canvas placement workflow
status: Done
assignee:
  - '@codex'
created_date: '2026-09-28 07:30'
updated_date: '2026-09-28 07:39'
labels:
  - target-tree
dependencies: []
references:
  - logs/reliability/component-catalog/report.json
  - logs/factory-update-verification.json
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User reports component icons remain unloaded and expects clicking a component to place an editable shape with factory reference information in work orders.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Visible catalog icons load automatically without cancelling selected previews
- [x] #2 Click factory then canvas places whole component; Tab and work orders function
- [x] #3 Exports contain truthful grouped reference code for rigid placements and exact geometry fallback for deformation
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: | Target: complete component library to work-order flow | Deliverable: loaded icons, canvas placement and factory reference data | TRIZ framing: avoid costly all-library generation while visible icons load | Route: route-bug and route-implementation, direct focused diagnosis | Method: separate thumbnail channel, visible queue, placement ghost, grouped export | Gate: real thumbnails and browser placement/work-order plus export tests | Budget: bounded local tests per iteration | Stop: requested flow passes, repair failures | Branch return: integrate independent backend and export changes
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Output: Factory icon and placement browser flow | Result: Visible icon requested before selection; card starts ghost; Tab edits without saving; canvas click commits complete group; work-order payload contains factory geometry; Escape cancellation passes | Status: gate_passed | Evidence: logs/reliability/component-catalog/report.json | Limits: Browser protocol fixture plus independently tested installed Python thumbnail backend; shapes remain proposals | Target impact: Repairs original icon and placement interaction requirements

Output: Verified reference code and installed extension | Result: Generated reference executes using installed gdsfactory and reproduces rotated translated center; reference tests reject hole deformation and malformed geometry; installed bundle and viewer match VSIX | Status: gate_passed | Evidence: logs/factory-update-verification.json | Limits: Rigid geometry recipe requires matching factory/runtime; scaled or edited geometry uses exact-polygon fallback | Target impact: Completes reference handoff and installs the requested fix
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed visible icon loading, direct factory click-to-canvas placement, draft/placed Tab editing, and work-order reference metadata/code. Browser UI regression, installed Python thumbnail and generated reference checks, TypeScript and package passed. Updated installed VS Code extension and verified package files.
<!-- SECTION:FINAL_SUMMARY:END -->
