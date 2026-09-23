# Local usage logs

GDS Navigator records local usage events by default, as requested for this personal workflow. Pause with the Usage button or `gdsNavigator.usageLogging.enabled`. The report reads only `.gds-navigator/usage/session-*.jsonl` beneath the explicitly supplied project root. It does not search outside that directory, send events to a service, execute event contents, or apply UI changes.

Each accepted event is schema-checked. The report keeps action intent counts separate from explicit outcomes: an intent records an observed request, while success, failure, cancellation, or unknown is counted only when that outcome is present in the event. It does not infer that a click succeeded. Document identifiers are expected to be pre-hashed by the logger; paths and raw event payloads are not reproduced in the Markdown report.

Reads are bounded to 20 MiB per file and 50 MiB in aggregate. Files whose names do not match `session-*.jsonl` are ignored. Malformed lines, incomplete trailing lines, and data beyond the read budget are excluded and counted. Same-session transitions are counted only when adjacent observations share the same document identifier and are no more than five minutes apart.

## Reviewing a report

Treat the output as evidence for review, not an automatic product decision. Check the date bounds, malformed/truncated counts, sample size, and explicit outcome distribution first. A repeated intent or failure is a hypothesis to investigate against the workflow and source code. Rare activity is not evidence that a feature is useless; an unobserved action is not evidence that it is unnecessary. Recommendations should cite the observed action, phase, outcome, document scope, and time window, and should be confirmed with a focused UI test before implementation.

Generate Markdown with `node scripts/usage-report.cjs --project C:\\absolute\\project` after building `dist/usageReport.js`. Add `--json` for the aggregate summary used by review tooling. The CLI prints the report only and never prints source paths or raw events.

## Viewer controls and retention

Use **Usage** in the viewer navigation or **GDS: Usage Logging Controls** in the Command Palette. Review writes `.gds-navigator/usage-report.md` and `.json`; Copy agent review context copies their location and review guidance only after clipboard verification. **GDS: Review Usage Log** opens the report directly. Clear deletes recognized usage event files, preserving designs, annotations and instruction journals. Clearing also refreshes the generated report.

Logs rotate at 1 MiB and retain about 20 MiB / 30 days. Retention runs on writes. Logging has no network destination. Events contain timestamps, session/order IDs, hashed document IDs, fixed control identifiers, outcomes and timings. Input contents, search text, geometry, image data and clipboard contents are excluded. The separate proposal journal intentionally retains design instructions.

Coverage includes fixed viewer controls and shortcuts, annotation persistence, instruction actions, component catalog operations, selection clipboard verification, builds and marker alignment. Mouse movement and raw keystrokes are not recorded. A session is an extension-host logging session, not measured human attention. Durations measure instrumented operations, not productivity. Closing the host abruptly may lose queued final events. Counts cannot compare uninstrumented controls or infer why a user avoided a feature.

Validation commands: `npm run test:usage` checks logging, privacy, reports and provider integration; `npm run test:usage:vscode` exercises the Usage menu, controls, report and pause/resume with two layouts in a disposable Extension Development Host. Test-owned usage logs are synthetic activity and must not be treated as evidence about your personal habits.

For other design repositories, add `.gds-navigator/usage/` and `.gds-navigator/usage-report.*` to their `.gitignore` if you do not want local activity included in commits. The extension does not change another project’s Git configuration automatically.

## No AI agent required

Recording runs inside the extension whenever instrumented operations occur. No AI prompt, console print, agent callback or report command is needed. After persisted events, a throttled background task refreshes `usage-report.md` and `usage-report.json` about every 10 seconds while activity continues; it sleeps when idle. Each report file is replaced atomically. Normal extension deactivation waits for pending log writes and the final report. Force-killing VS Code or a power loss can still lose in-flight events; this is not a transaction audit guarantee.

The AI is a reader of existing evidence, not the recorder. Use the Review command only to open/refresh the already automatically generated summary. This application-specific instrumentation follows the distinction between automatic hooks and domain-specific events in [OpenTelemetry instrumentation](https://opentelemetry.io/docs/concepts/instrumentation/). The [VS Code telemetry guide](https://code.visualstudio.com/api/extension-guides/telemetry) describes telemetry APIs and user control; this implementation stays local, retains its own pause setting, and does not install a remote telemetry exporter.
