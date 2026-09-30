# Project management and verification

Backlog is the project task store. Use `backlog browser` for the board, or
`backlog task list --plain` for the CLI. Generated `RESEARCH_MAP.md` and
`.artifacts/backlog-map/RESEARCH_MAP.html` show task relationships and evidence;
change native tasks rather than editing generated maps.

Each improvement has an owner, a bounded plan, measurable acceptance criteria,
and linked evidence. Prioritize correctness and source identity, then measured
performance and everyday interaction. Return child results to the parent before
completion. Preserve geometry, components, ports, provenance, alignment, and
work-order semantics throughout the review.

## Repeatable verification

```powershell
npm run project:check -- release
npm run project:verify -- quick
npm run project:verify -- release
npm run project:status
```

`check` verifies runtime inputs before starting the profile. `quick` checks
TypeScript, sidebar behavior, ports, inspector interaction, and performance.
`release` runs TypeScript, performance, reliability, components, alignment,
UI, work orders, and the production build in sequence. Sequential execution
prevents browser suites from rewriting their shared standalone fixture together.

The runner discovers existing local Python and headless browser runtimes and
never installs dependencies. Set `GDS_BROWSER` / `GDS_PYTHON`, or pass
`--browser PATH` / `--python PATH`, to select explicit executables. It passes
the selected runtime to each stage. Failed preflight or checks produce a nonzero
exit code; later stages remain unrun.

Each run creates `logs/project-verification/<run-id>/` with raw stage logs and
a JSON result. `latest.json` records progress or the final outcome. Reports
identify the profile, runtime, commands, durations, and code version. These are
verification artifacts, not a second task store. Operation counts establish
less repeated work, not universal FPS or large-layout latency.

## Delivery

Run the release profile after integration. Package and install the exact VSIX,
then compare installed runtime files against reviewed source. Compare manifest
contents separately from VS Code's installer metadata. Record task evidence,
return child results, run finalization, and commit the release. Reload VS Code
to activate the installed update.
