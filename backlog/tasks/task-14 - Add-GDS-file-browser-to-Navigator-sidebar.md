---
id: TASK-14
title: Add GDS file browser to Navigator sidebar
status: Done
assignee:
  - '@codex'
created_date: '2026-09-28 11:38'
updated_date: '2026-09-28 11:49'
labels: []
dependencies: []
references:
  - README.md
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Activity Bar GDS Navigator view currently registers an empty tree, while the local GDS Viewer reference shows a GDS Files sidebar. Add a VS Code file list for workspace layouts with direct open action; preserve existing setup actions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GDS Navigator sidebar lists workspace GDS files with useful folder context and opens selected files in the custom editor
- [x] #2 The sidebar refreshes when workspace GDS files are added or removed and remains bounded for large projects
- [x] #3 Existing initialization and environment actions remain accessible; focused tests pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: | Target: navigable GDS sidebar | Deliverable: bounded workspace file tree in Activity Bar | TRIZ framing: quick file discovery without large-project UI stalls | Route: route-implementation | Method: query capped GDS paths, render folder context, refresh on file and folder changes | Gate: sidebar file/open/refresh tests, existing actions, TypeScript and package | Budget: local workspace fixtures | Stop: acceptance checks pass | Branch return: inspect any VS Code API mismatch
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Output: Workspace GDS sidebar added and installed | Result: GDS Files tree opens custom editor, refreshes on changes, caps at 500. Focused reliability, TypeScript, package and 9-record VS Code lifecycle pass; installed bundle matches source. | Status: gate_passed | Evidence: README.md | Limits: GDS Viewer reference matched file-list navigation; branch switching and build-all controls are not part of this workspace sidebar. | Target impact: Workspace layouts are accessible in the GDS Navigator Activity Bar.

Focused sidebar fixture covered >500 files, context, open command, refresh and setup actions. Reliability suite and 9-record VS Code lifecycle passed. Initial lifecycle timeout used a fixed green-pixel count in a narrow pane; diagnostic screenshot showed visible aligned image; viewport-scaled threshold passed. Packaged and installed VSIX; bundle/viewer hashes match installed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added bounded GDS file browser to Activity Bar and retained setup actions. Focused tests, TypeScript, production package and VS Code lifecycle passed; installed extension verified.
<!-- SECTION:FINAL_SUMMARY:END -->
