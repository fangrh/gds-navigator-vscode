---
id: TASK-19.1
title: Recover failed component thumbnails
status: Done
assignee:
  - codex
created_date: '2026-10-01 06:42'
updated_date: '2026-10-01 06:57'
labels: []
dependencies: []
references:
  - test/reliability/component-catalog-viewer.test.js
  - test/reliability/component-chooser.test.js
parent_task_id: TASK-19
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Failed thumbnail cache entries suppress future thumbnail requests; card selection currently retries main preview but starts placement. Provide independent recovery.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Retry UI preserves successful cached shapes and prevents accidental placement
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: Target: retry failed thumbnail generation independently | Deliverable: separate retry control | Route: route-bug and route-implementation | Method: correlated bounded requests, retain success cache and native keyboard browser validation | Gate: failure recovery without placement | Stop: focused and release gates pass

TRIZ framing: separate thumbnail recovery from component placement. Budget: bounded worker edits and release verification. Branch return: correlated retry evidence to parent criterion 1.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Target link: {"version": 1, "target": "TASK-19", "parent": "TASK-19", "criterion": 1, "criterion_sha256": "198f0491c95096326d290d9e773fc0e9cbeb52f0e3bb1d17223c8622a73143ac", "purpose": "Retry thumbnail generation without losing catalog state or entering placement", "return_gate": "Error and timeout retry request isolation plus browser keyboard recovery pass"}

Branch return: {"version": 1, "child": "TASK-19.1.1", "link": {"version": 1, "target": "TASK-19", "parent": "TASK-19.1", "criterion": 1, "criterion_sha256": "c1bb457bba94240bfddaf3e6abe96902766515e61363755f8c0dcbfef73c762c", "purpose": "Repair host batch limit and wait for scheduled browser retry request", "return_gate": "More than eight failures recover in bounded batches and native keyboard test waits for new request"}, "evidence": "test/reliability/component-chooser.test.js", "result": "Twelve failures recover as eight plus four; active requests protected, timeout and native keyboard recovery pass."}

Output: independent component thumbnail recovery | Result: native retry control preserves successful thumbnails and catalog state; new correlated bounded requests recover errors/timeouts without selection or placement; twelve-failure repair returned from TASK-19.1.1. | Status: gate_passed | Evidence: test/reliability/component-catalog-viewer.test.js | Limits: deterministic fixtures and native keyboard browser flow. | Target impact: parent criterion 1 satisfied.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added separate wrapping retry control with bounded scheduler recovery; unit and native keyboard browser checks passed, preserving cached successes and avoiding placement.
<!-- SECTION:FINAL_SUMMARY:END -->
