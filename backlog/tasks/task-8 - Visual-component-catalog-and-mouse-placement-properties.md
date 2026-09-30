---
id: TASK-8
title: Visual component catalog and mouse placement properties
status: Done
assignee:
  - '@codex'
created_date: '2026-09-28 06:42'
updated_date: '2026-09-28 07:27'
labels:
  - target-tree
dependencies: []
references:
  - logs/reliability/shape-properties/report.json
  - logs/reliability/component-catalog/report.json
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make gdsfactory components recognizable and editable like an EDA library with efficient previews and mouse manipulation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Sorted visual catalog with bounded caching
- [x] #2 Whole factory mouse transforms and Tab properties
- [x] #3 Image Tab properties and efficient display with focused validation
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: | Target: clear EDA component selection and placement | Deliverable: sorted shape previews, whole component transforms and image Tab properties | TRIZ framing: recognize and edit geometry without redundant preview builds | Route: route-implementation and route-claim-done; optional superpowers unavailable, direct focused implementation | Method: reuse geometry and transform controls, cache previews, verify browser flows | Gate: focused catalog, shape and image tests plus production build | Budget: bounded local checks per iteration | Stop: complete when requested interaction gates pass, repair regressions | Branch return: integrate worker changes against original UI requirements
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Output: Grouped component and image interactions | Result: Sorted SVG catalog and cache; whole factory numeric/mouse transforms; image click Tab inspector; UI suite and installed 344-factory catalog with four previews passed | Status: gate_passed | Evidence: logs/reliability/shape-properties/report.json | Limits: Preview images load on selection; original GDS read-only; placements remain proposals; no frame-rate benchmark | Target impact: Requested component recognition and editing workflow implemented

Output: Visual catalog browser acceptance | Result: Browser verifies sorted cards, actual polygon SVG including hole, cached revisit without new request, actual insertion and grouped Tab properties | Status: gate_passed | Evidence: logs/reliability/component-catalog/report.json | Limits: Deterministic protocol fixture; installed Python factory previews verified separately | Target impact: Completes catalog interaction gate

User requested plugin update: installed logs/gds-navigator-latest.vsix with code --install-extension --force. Installed extension bundle, viewer, chooser and stylesheet SHA256 match the VSIX. Evidence: logs/plugin-update-verification.json. Existing VS Code windows left open; reload activates updated extension.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented sorted shape cards with bounded caching, whole-factory placement transforms and Tab image properties. Focused browser/catalog/image checks, full EDA UI suite, TypeScript and production packaging passed. Source edits remain proposals. VSIX: logs/gds-navigator-latest.vsix.
<!-- SECTION:FINAL_SUMMARY:END -->
