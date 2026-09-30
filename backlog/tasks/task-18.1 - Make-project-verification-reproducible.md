---
id: TASK-18.1
title: Make project verification reproducible
status: Done
assignee:
  - luna
created_date: '2026-09-30 07:33'
updated_date: '2026-09-30 07:53'
labels: []
dependencies: []
references:
  - docs/managed-optimization-review.md
  - scripts/verify-project.cjs
parent_task_id: TASK-18
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Previous and current runs repeat browser-path setup; launcher failures obscure check status. Preserve exact existing suites and failure output.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 check run status interface records exact stages, browser and failures
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: | Target: reproducible validation under TASK-18 | Deliverable: check/run/status runner and failure reports | TRIZ framing: remove manual setup without hiding failures | Route: route-second-occurrence | Method: use exact existing suites sequentially, resolve browser and node/npm inputs, persist stage logs and status, verify runner with controlled outcomes | Gate: runner tests and release run | Budget: bounded implementation and one release profile | Stop: recorded release pass | Branch return: native evidence to parent criterion 3
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Target link: {"version": 1, "target": "TASK-18", "parent": "TASK-18", "criterion": 3, "criterion_sha256": "a649b377be957eeddf56f4a8c47958b1392e9451f438852a8f768834deac84a5", "purpose": "Replace repeated manual browser setup and ad hoc validation commands with an inspectable runner", "return_gate": "Runner preflight plus recorded sequential concept regression results"}

Output: first managed release run retained | Result: TypeScript passed; performance launcher failed because Windows Path/PATH case handling dropped node lookup. No later suites ran. | Status: negative | Evidence: scripts/verify-project.cjs | Limits: launcher failure, not test or product failure. | Target impact: repair environment propagation and rerun original release profile.

Output: reproducible verification release gate | Result: check/run/status, failure persistence, runtime propagation and timeout unit tests pass; release run 20260930074903119-8b289791 passed all eight stages after retaining and repairing the first Windows PATH launcher failure. | Status: gate_passed | Evidence: docs/managed-optimization-review.md | Limits: scoped regression suites and synthetic operation counts, not universal FPS. | Target impact: fulfills parent verification workflow criterion.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added sequential check/run/status runner with bounded preflight, exact runtime propagation, stage logs/durations/source fingerprints and failure records; focused runner tests and eight-stage release profile pass.
<!-- SECTION:FINAL_SUMMARY:END -->
