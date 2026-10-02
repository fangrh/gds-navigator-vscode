---
id: TASK-22
title: Run the real GDS editor in a local browser without VS Code
status: Done
assignee:
  - '@codex'
created_date: '2026-10-02 10:49'
updated_date: '2026-10-02 11:08'
labels:
  - target-tree
dependencies: []
references:
  - docs/browser-development.md
  - logs/reliability/browser-host/api-report.json
  - logs/reliability/browser-host/report.json
  - logs/reliability/browser-performance/report.json
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User requests a web version specifically for debugging without opening VS Code. Reuse the live viewer and domain logic with a local host adapter and real GDS parsing; preserve current uncommitted extension changes. Browser acceptance replaces installed VS Code journeys for this browser-only delivery, as explicitly requested.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One documented command serves the current viewer locally with a working sample and selectable real GDS or GeoJSON files, without VS Code.
- [x] #2 Browser host persists editing and image/review state and provides observable host messages and explicit supported or unsupported action results.
- [x] #3 Automated real-browser journeys verify drawing, reload persistence, file isolation, parser integration and compact layout; existing shared viewer gates remain passing.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: | Target: debug the existing plugin in a local browser without launching VS Code. | Deliverable: reusable local software host, one-command launch, browser evidence and usage guide. | TRIZ framing: preserve real geometry and viewer behavior while removing editor-host startup; separate host services from the shared viewer. | Route: workflow_optimization; route-implementation and route-completion; unavailable superpowers skills use direct focused implementation and verification. | Method: reuse live viewer assets; implement loopback host with real parser and isolated debug storage; exercise browser editing and reload. | Gate: real GDS parsed with existing parser, shared viewer has no page errors, drawings and image/review state survive reload and stay document-isolated; malformed and stale writes rejected; compact view works. | Budget: focused implementation and deterministic browser journeys; no VS Code launch or package installation. | Stop: finish when browser acceptance and relevant shared regression gates pass. | Branch return: any blocker returns evidence to the same browser gates; no scientific or VSIX release claim.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Output: Shared browser development host and performance workflow | Result: Same viewer/assets and shared parser, validation, exports, review, work-order and catalog modules run without VS Code. API, real browser drawing/reload/image/isolation checks passed; 320/390/1400 screenshots and 1000/10000-feature measurements retained. | Status: gate_passed | Evidence: docs/browser-development.md | Limits: Local development host; Python generation and source undo remain terminal/extension workflows. Measurements are local CPU/browser observations, not universal FPS. | Target impact: Satisfies browser debugging and shared-base performance measurement target.

User clarified that the browser must share the plugin base and support performance work. Both hosts now call parseGdsCore and share viewer/worker sources and domain modules. npm run test:web passes; real component preview was also exercised in the visible browser. Reports: logs/reliability/browser-host/api-report.json, logs/reliability/browser-host/report.json, logs/reliability/browser-performance/report.json. Compilation, TypeScript, provenance contract, EDA workbench, route assist and style-cache checks pass. No VS Code launched.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Delivered a local browser development version using the same viewer, tools, workers, shared parser and domain modules as the plugin. dev:web starts it; test:web verifies real parsing/editing/persistence/file isolation and compact layouts; profile:web records reproducible 1000/10000-feature baselines for shared-code optimization. Browser-only host differences are documented. All scoped acceptance gates passed; no VS Code launch or release/install claim.
<!-- SECTION:FINAL_SUMMARY:END -->
