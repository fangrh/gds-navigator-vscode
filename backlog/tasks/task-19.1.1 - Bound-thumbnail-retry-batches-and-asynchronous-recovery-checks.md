---
id: TASK-19.1.1
title: Bound thumbnail retry batches and asynchronous recovery checks
status: Done
assignee:
  - codex
created_date: '2026-10-01 06:50'
updated_date: '2026-10-01 06:56'
labels: []
dependencies: []
references:
  - test/reliability/component-chooser.test.js
  - test/reliability/component-catalog-viewer.test.js
parent_task_id: TASK-19.1
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Final review found unbounded failed-name request violates the host maximum of eight; switching to scheduled retry requires browser await instead of immediate request snapshot. Failed release retained.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Bounded retry scheduler and asynchronous browser regression pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: Target: repair retry delivery gate | Deliverable: scheduler batches at most eight and browser waits for asynchronous request | Route: route-bug and route-implementation | Method: reuse lazy scheduler and isolate request lifetime | Gate: twelve failures recover and keyboard browser passes | Budget: existing worker, focused tests | Stop: evidence returned to TASK-19.1 | Branch return: test files and release logs

TRIZ framing: separate batching from user intent and asynchronous scheduling from test observation.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Target link: {"version": 1, "target": "TASK-19", "parent": "TASK-19.1", "criterion": 1, "criterion_sha256": "c1bb457bba94240bfddaf3e6abe96902766515e61363755f8c0dcbfef73c762c", "purpose": "Repair host batch limit and wait for scheduled browser retry request", "return_gate": "More than eight failures recover in bounded batches and native keyboard test waits for new request"}

Output: bounded thumbnail recovery repair | Result: twelve failures recover in batches of eight then four, active requests suppress duplicate retry, timeout recovery ignores stale responses; keyboard browser waits for scheduled new request and passes. Failed release 20261001064729984-1c842ee8 retained. | Status: gate_passed | Evidence: test/reliability/component-chooser.test.js | Limits: deterministic protocol fixtures and browser workflow. | Target impact: repairs TASK-19.1 recovery gate.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Preserved host eight-name limit through existing scheduler; timeout, stale responses, active-request protection and twelve-failure recovery regressions pass.
<!-- SECTION:FINAL_SUMMARY:END -->
