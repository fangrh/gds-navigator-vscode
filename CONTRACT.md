# GDS Navigator reliability contract

Status: frozen by the user's approved implementation plan, 2026-09-22.

This is a personal-use software acceptance contract, not a fabrication or
scientific accuracy claim. Preserve existing source inputs and uncommitted work.

- Builds reject stale/no output, expose multiple outputs for selection, and support
  bounded output, timeouts and cancellation. Show the actual Python/fork origins.
- Clipboard output is valid versioned YAML with snapshot identity, full geometry,
  nested provenance and explicit annotation intent. Verify clipboard success.
- Keep files isolated, preserve annotations through editor/window reopening,
  expose stale targets and retain the image below GDS elements.
- Align only numbered markers. Accepted fits require overall boundary RMS <=2
  source pixels and each marker <=4 pixels; ambiguous fits preserve placement.
- Test negative labels, rotation, perspective, missing/unreadable markers and
  seeded contamination. Nonmarker mutations must change placement <0.5 pixel.
- Repeat the confirmed 720x606 electrode-100 pair three times deterministically.
  Inspect the saved overlay. Green electrode mismatch must not influence fitting.
- Run focused tests, compilation, and real isolated VS Code 1/5/10-file journeys
  over three window cycles, including drawing, clipboard, image restore and a
  temporary fork build. Existing user windows and designs remain untouched.

Evidence lives in `logs/reliability/` and `logs/numbered-markers/`. Marker corpus
coverage is bounded; passing it is not a claim of generic OCR or universal photo
registration. Page JS heap measurements do not bound total browser/GPU memory.
