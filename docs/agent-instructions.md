# Agent instruction queue

The durable queue lives at `.gds-navigator/instructions.json` in the project root. Use `scripts/instructions.cjs --queue <absolute queue path>` when an explicit queue path is needed.

The queue is a shared journal for all GDS files, while `list --gds <absolute-gds-path> --open` is the per-GDS user list. Each GDS has its own FIFO work-order list: an open earlier order for one normalized GDS identity does not block work on another GDS. `INS-...` references are stable across reloads and copies. Inspect work with `list --open` and `show INS-...`. Use the instruction ID when starting: `start INS-... --file <source.py>`; repeat `--file` for every source file whose bytes may be changed. The `--gds` option belongs to `list`, not `start`.

Start captures the source snapshots before editing. After the requested action has been validated, run `done INS-... --note "..."`; lifecycle history records created, start, done, and reverted events with timestamps, status, and notes. `revert INS-...` is an exact source undo only when every current file still matches its recorded post-action hash. Newer edits, missing receipts, new or deleted files, and annotation changes outside source receipts remain outside that undo guarantee.

Completing an order records the current hash of every receipt. Undo restores the pre-action UTF-8 bytes only when these hashes still match. Rebuild the GDS after a source undo. Orders without complete receipts offer **Withdraw proposal**, which restores the captured proposal annotations but does not undo Python edits. The journal is a local project file, not a tamper-proof audit service.

The persisted context is the exact `selectionDocument` snapshot captured when the instruction was added, including selected components, references, request intent, primitive metadata, construction recipes, and annotation state supplied by the host. Queue records are immutable in their payload; status and notes are the only lifecycle fields changed.

## Viewer workflow

1. Select GDS elements or a drawn region. The bottom **New work order** composer identifies the current GDS and selected targets.
2. Choose the action inside the chat-style input and describe the requested change and acceptance criteria. Enter inserts a newline; Ctrl+Enter (or Command+Enter on macOS) submits. IME composition does not trigger submission. **Add work order** requires both targets and a requirement. It freezes that selection; subsequent selection changes do not change the saved order.
3. The **Work orders** inspector shows this GDS's next open reference, counts, status filter and reference/requirement search. Expand the exact context or activity journal when needed.
4. Use **Copy ref** for one order or **Copy open orders** for the current GDS. The copied YAML includes the queue path, GDS identity, requirement and CLI lookup instructions. Paste it into your agent conversation; the plugin does not send it automatically.
5. Ask the agent to inspect the frozen context, check the GDS hash, capture every affected source with `start`, implement and validate, then mark the order done. **Mark done** is available only for the next open order in this GDS. It records completion; it does not execute or validate the change itself.

An acknowledgement clears only the submitted, unchanged draft. Failures retain the requirement. Orders persist across editor reopening in the project journal. The activity history is optional on old records, preserving existing journals and references.


## Finding targets and commenting

Click a work-order reference (or its card text) to highlight its exact saved GDS elements and drawing proposals. The current draft stays intact. Highlighting requires either the original GDS snapshot or a verified current-target mapping, with every target available. Missing or ambiguous targets keep the existing selection and report the problem.

Each card has its own comment field. Comments retain IDs/timestamps and are included in `show`, Copy details and copied open orders. They do not rewrite the original requirement or mark an order done. Failed saves retain the comment draft; acknowledgements preserve text edited while submission was pending. CLI: `comment INS-... --text "Keep the center fixed"`.

## Tracking failure boundaries

Failed journal saves roll back in-memory status, notes, receipts, comments and history. Repeated completion/reopening of terminal records is rejected. `start` requires an explicit source file. Reloading a missing journal produces an empty list; a malformed journal cannot be used as current data.

Journal writes use an exclusive `.gds-navigator/.instructions.lock` plus a fresh content-fingerprint check to reject competing writers. Retry after the active writer finishes. If the writer crashes, the lock deliberately remains: inspect its PID and confirm that process has stopped before removing only that lock file. It is never removed automatically based on age.

Source undo is checked against captured post-edit hashes. Recoverable write failures restore the previous source bytes; if restoration itself fails, the error names the files needing review. This does not provide a crash-atomic transaction across multiple source files and the journal, or protection against arbitrary concurrent editors modifying source files during undo. The journal is local tracking, not a tamper-proof audit log.


## Recompiling the same GDS

Drawings, work-order references, comments and completion history survive rebuilding and reopening the same GDS path. The original requirement, captured geometry and source receipts remain unchanged. Each viewer computes a separate `tracking` result against the current parsed GDS and includes it in copied work-order data:

- **Current targets**: the original snapshot and IDs remain current.
- **Linked after rebuild**: targets were resolved from unique exact geometry/layer or a unique strong source instance identity. Drawings retain their annotation IDs.
- **Targets need review**: a target was deleted, ambiguous, lacks sufficient identity, or has no verifiable snapshot. The viewer does not guess by proximity.

Drawing geometry stays fixed. Its target links can be resolved for the current view using frozen work-order evidence; saved historical annotations and orders are not rewritten by the rebuild. A later explicit drawing edit saves its current binding. Agents should compare the original context with `tracking.layoutHash`, `tracking.matches` and `current_targets` before editing. Recompiling to a different output path creates a different GDS document; orders are not silently moved between filenames.
