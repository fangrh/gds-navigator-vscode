---
id: TASK-5
title: Diagnose provenance unavailable in installed viewer
status: Done
assignee:
  - root
created_date: '2026-09-22 13:14'
updated_date: '2026-09-22 13:14'
labels: []
dependencies: []
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Check actual VS Code build failure and source generator backend without changing user layout scripts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Identify the failing interpreter dependency and whether the generator supports fork provenance.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Inspect GDS Navigator output and generator imports; validate fork provenance on isolated fixture; report exact causes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Actual VS Code output at logs/20260922T155853/window1/exthost/output_logging_20260922T155855 reports Anaconda Python with fork support, but ModuleNotFoundError gdstk at generate_jj_pad_gds.py:19. Old script path absent; current D:/gds2027/generate_jj_pad_center_100.py imports gdstk and uses gdstk.Library.write_gds, bypassing gdsfactory tracking. Isolated demo-provenance test passed 8 features/6 loop instances. No user scripts or environments changed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Two independent causes: missing gdstk prevents rebuild, and gdstk-only generator bypasses gdsfactory provenance. Automatic Python capability does not imply arbitrary-script dependencies or provenance coverage.
<!-- SECTION:FINAL_SUMMARY:END -->
