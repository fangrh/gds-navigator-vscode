---
id: TASK-15
title: Show and select GDS ports
status: Done
assignee:
  - '@codex'
created_date: '2026-09-28 11:56'
updated_date: '2026-09-28 12:09'
labels: []
dependencies: []
references:
  - logs/gds-navigator-latest.vsix
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The viewer receives port metadata for component previews and provenance, but does not display clickable ports. Add explicit visibility controls and selection that preserves port identity and exact coordinate context.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Ports with trustworthy layout coordinates have a visible marker and label controlled by a switch
- [x] #2 Clicking a visible port selects that port distinctly from its polygon, with a visible selected state and copied port metadata
- [x] #3 Hidden ports cannot be selected; layout reload and component transforms preserve correct port positions; focused browser and export checks pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Draft TRIZ route v0: | Target: visible selectable ports | Deliverable: port overlay and exact copied metadata | TRIZ framing: add inspection without altering polygon geometry | Route: route-implementation with focused browser and parser checks | Method: normalize transformed GDS ports, project rigid factory ports, render switchable overlay, add port selection/export | Gate: toggles and click/CTRL selection in browser, parser transform fixtures, copied port coordinates and reload | Budget: local fixtures | Stop: original UI and export gates pass | Branch return: diagnose coordinate uncertainty or malformed port records
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Output: Port markers and names can be toggled; ports are selectable and copied with exact layout metadata. | Result: Implemented parser-normalized GDS ports, rigid factory port projection, sidebar controls, selection/export, and reload cleanup. Reliability and performance suites pass; VSIX installed. | Status: gate_passed | Evidence: logs/gds-navigator-latest.vsix | Limits: Factory port markers require a rigid component pose; nonrigid geometry is omitted. Factory port selections are for inspection/copy; select component geometry for work orders. | Target impact: Enables direct visual inspection and selection of trustworthy GDS and placed factory ports.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Installed updated VSIX with selectable layout/factory port markers and separate marker/name switches. Parser transform, browser click/toggle/reload, YAML, reliability and performance checks pass. Factory port markers require a rigid pose; select component geometry for work orders.
<!-- SECTION:FINAL_SUMMARY:END -->
