---
id: TASK-7
title: Fix numbered marker alignment on reduced microscope image
status: Done
assignee:
  - root
created_date: '2026-09-22 13:58'
updated_date: '2026-09-22 14:04'
labels: []
dependencies: []
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Reproduce ebl.png ambiguity; identify full marker labels before applying marker-only transform to whole image. Preserve user inputs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Current image aligns with correct four labels and boundary gates
- [x] #2 Focused marker regressions and extension compile pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Reproduce, repair center-based hypotheses, regress, inspect overlay, package and install.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reproduced actual 398x348 ebl.png. Center-separation scale hypotheses recover four labels without relaxing confidence or boundary gates. Full alignment suite, viewer workflow, compile passed. Random100:21 accepted accurate,79 rejected,zero false accepts. Preserved external files. Installed VSIX; reload required.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed and installed shared solver. RMS0.382995px; independent validation0.385152px. Evidence logs/marker-ambiguity/after and logs/numbered-markers/viewer. Severe contamination remains unsupported and rejected.
<!-- SECTION:FINAL_SUMMARY:END -->
