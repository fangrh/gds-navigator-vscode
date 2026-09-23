---
id: TASK-3
title: Automatically choose provenance Python environment
status: Done
assignee:
  - root
created_date: '2026-09-22 11:59'
updated_date: '2026-09-22 12:13'
labels: []
dependencies: []
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Default PATH Python may lack the provenance-enabled gdsfactory fork. Detect an installed compatible environment so builds and parsing use the intended runtime without manual setup.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Automatic selection verifies provenance capability and klayout and selects the workspace fork when available.
- [x] #2 Explicit configured or user-picked interpreters remain authoritative, including changes during detection.
- [x] #3 Build parse and catalog wait for selection; diagnostics show origin and focused/live checks pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Probe local fork capabilities; implement bounded asynchronous detection and status; integrate readiness before operations; verify override/race/fallback tests and actual workspace interpreter.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Verified with npm run test:environment, build-contract and review/instruction-provider runtime tests, npx tsc --noEmit and npm run compile. Real VS Code --work-orders --auto-env passed with 3 records; captured actual fork interpreter and rendered manual/Automatic picker states. Initial venv-path failure retained and corrected. Details in ISSUES.md and logs/reliability/auto-env-vscode/report.json.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented verified bounded automatic Python selection and authoritative manual picker. Environment tests, build/provider regressions, TypeScript and compile passed. Isolated real VS Code verified actual fork executable, manual selection and return to Automatic, plus rebuild/reopen work-order journey. Evidence: logs/reliability/auto-env-vscode.
<!-- SECTION:FINAL_SUMMARY:END -->
