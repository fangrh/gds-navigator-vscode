---
id: TASK-17.1
title: Repair existing concept regression gates
status: Done
assignee:
  - codex
created_date: '2026-09-30 07:18'
updated_date: '2026-09-30 07:27'
labels: []
dependencies: []
references:
  - test/reliability/component-catalog-context.test.py
parent_task_id: TASK-17
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Full concept validation exposed project component metadata failure and missing-marker alignment ambiguity after checkpoint a92d581; diagnose without weakening production gates.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Project component preview contract passes
- [x] #2 Numbered marker corpus preserves identity and passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: | Target: return concept preservation evidence to TASK-17 | Deliverable: corrected root causes or valid fixture repairs with negative gates retained | TRIZ framing: keep strict contracts while resolving existing mismatches | Route: route-bug | Method: inspect raw failures, isolate fixture versus runtime cause, repair bounded causes, rerun original suites | Gate: project components and numbered marker corpus | Budget: focused diagnosis then repair | Stop: original gates pass | Branch return: report repaired gates to parent
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Output: alignment corpus repaired | Result: existing ambiguous 40px-pad case explicitly rejected; separate 80px-pad three-marker fixture passes exact identities, transform and boundary checks; full alignment suite passes. | Status: gate_passed | Evidence: test/alignment/numbered-markers.test.js | Limits: no production alignment or threshold changes. | Target impact: preserves strict identity gate.

Output: cross-drive project factory repair | Result: project-components.test.js passes custom geometry, ports, library metadata and API checks after scoped provenance/CWD handling. | Status: gate_passed | Evidence: python/component_catalog.py | Limits: follow-up integration review is checking upstream gdsfactory compatibility and state restoration. | Target impact: restores project factories without losing source context.

Compatibility gate: python test/reliability/component-catalog-context.test.py passes optional upstream hook absence, fork state restoration and setup-failure CWD restoration. Project integration already passed; remaining provider/cache/chooser/generated-reference tests also pass.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Repaired cross-drive project factories with optional scoped provenance integration and restored process state; project and context tests pass. Retained ambiguous low-resolution marker rejection and added exact three-marker positive; full alignment suite passes.
<!-- SECTION:FINAL_SUMMARY:END -->
