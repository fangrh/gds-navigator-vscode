---
id: TASK-4
title: Install updated GDS Navigator in VS Code
status: Done
assignee:
  - root
created_date: '2026-09-22 12:39'
updated_date: '2026-09-22 12:41'
labels: []
dependencies: []
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Package current compiled extension, inspect package contents, install in the user VS Code and verify installed files.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Package contains current runtime files and excludes local test artifacts and environments.
- [x] #2 VS Code installation succeeds and installed runtime matches package.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Compile; inspect VSIX manifest and runtime files; install using VS Code CLI; verify installed runtime hashes without closing user windows.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Production VSIX inspection: 41 files, local artifacts excluded. VS Code CLI reports installed. Installed runtime SHA256 values match current bundle, viewer/review and Python helpers; evidence logs/install-verification-20260922.json.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Packaged and installed current fangrh.gds-navigator@0.1.0 in normal VS Code. Runtime hashes verified; user windows and settings preserved.
<!-- SECTION:FINAL_SUMMARY:END -->
