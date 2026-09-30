---
id: TASK-12
title: Reduce repeated frozen work-order target scans
status: Done
assignee:
  - '@codex'
created_date: '2026-09-28 11:33'
updated_date: '2026-09-28 11:35'
labels: []
dependencies: []
references:
  - docs/performance.md
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The completed editor performance pass indexed the current catalog, but reconciliation still scans frozen components and annotations separately for every target. Continue performance work with a bounded behavior-preserving improvement.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Frozen target lookup and drawn-target classification avoid a full scan for each target
- [x] #2 Same-hash and relink behavior, duplicate precedence, and ambiguity handling match the previous implementation
- [x] #3 Measured operation counts and focused regression checks pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: | Target: faster work-order reconciliation | Deliverable: measured behavior-preserving index change | TRIZ framing: avoid repeated scans while retaining matching precedence | Route: route-implementation; direct profiling and focused tests | Method: instrument frozen scans, index once, compare outputs | Gate: fewer inspections on 100 targets and exact old/new results | Budget: local fixture | Stop: acceptance checks pass | Branch return: diagnose any mismatch against original reconciliation
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Output: Frozen target reconciliation indexed | Result: One-pass ID and drawn-target lookup; mixed 100-target fixture reports 1300 ID lookups and exact relink regressions pass. | Status: gate_passed | Evidence: docs/performance.md | Limits: Deterministic operation counts, not end-to-end latency. | Target impact: Reduces repeated target scans while preserving matching rules.

Measured 1300 ID lookups for 100 targets/1000 current items; work-order rebuild tests and TypeScript passed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Indexed frozen target and drawn annotation IDs once per reconciliation. Focused relink, performance and TypeScript checks passed.
<!-- SECTION:FINAL_SUMMARY:END -->
