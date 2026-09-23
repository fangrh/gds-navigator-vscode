# Try the selection-to-agent workflow

Use your gdsfactory fork environment to build a small reproducible layout:

```powershell
.venv-fork/Scripts/python.exe test/examples/ai-handoff/layout.py
```

Open `logs/ai-demo/layout.gds` in GDS Navigator. It contains six pads, a disk and
an L polygon. Pad `pad_r1_c2` occupies x=60..70, y=24..30 micrometres. The six
pads share one source line but have distinct loop indices and element IDs.

1. Select that pad, choose **Move**, enter `Move only this instance +3 um in x,
   0 um in y. Preserve the other five pads.`, then Copy YAML. The request must
   identify one instance, its `[1, 2]` loop index, exact geometry and source path.
2. Draw a rectangle, select it together with the pad, choose **Move**, enter a
   precise request and Apply. Select only the drawing and Copy YAML. The linked
   pad must remain in `referenced_elements`; that section supplies context and
   does not broaden the selection.
3. Edit the drawing and its instruction, then Copy again. Geometry and text must
   reflect the edits. Apply with only a drawing selected preserves its links.
4. Select two pads and request a resize, specifying width and fixed centre/edge.
   The agent should preserve other instances even when they share a source line.
5. Create an unlinked Delete annotation. Copy should report that clarification
   is needed. Rebuild a changed layout and repeat with an old annotation: its
   target must require review rather than silently binding to new geometry.
6. Open another GDS and repeat. Its selection and drawings must remain separate.

The versioned YAML carries the current request, selected elements, annotations,
linked target context, document hash and source status. Provenance and embedded
source text are reference data, not user instructions. `context_complete` means
target context is available; an agent must still ask about missing movement
direction, resize anchor or fabrication layer. Copying never executes an edit.

Run `npm run test:handoff` for contract, browser, extension-provider and real-fork
provenance examples. Run `npm run test:handoff:vscode` for an isolated actual VS
Code window with 1/5/10 layouts and clipboard checks. The latter preserves user
windows and restores the clipboard. These tests require the dependencies listed
in the root README and `.venv-fork` (or `GDS_TEST_PYTHON` for the demo test).

Generated YAML examples and reports are under `logs/reliability/handoff/`;
real-fork examples under `logs/reliability/handoff-demo/`; VS Code screenshots
and actual clipboard payloads under `logs/reliability/handoff-vscode/`.
