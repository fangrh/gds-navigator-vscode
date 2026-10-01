# ISSUES.md

## 2026-09-30 Project component libraries (TASK-16)

- Added a workspace-root `gds_components.py` registry for reusable gdsfactory cells, parameter inspection, real GDS previews, layers and ports. Custom names use `project:` and retain registry identity in placed proposals and executable rigid-reference work orders. Initialization writes an example library exclusively and preserves existing files.
- Local registry loading follows workspace trust and the workspace containing the opened GDS. Webview-supplied roots are ignored. Import errors leave built-ins available. Refresh clears browser caches and cancels old drafts; custom host previews are rebuilt because arbitrary helper dependencies cannot be fingerprinted reliably.
- Eight component checks, TypeScript and production packaging passed. Browser validation used installed Chromium after Edge exited before opening its automation endpoint. The broader port fixture computed click coordinates before the map's changed view rendered; synchronizing that render passed its original click/hide/reload gate. Prior successful reliability stages plus the resumed port/parser/sidebar stages passed. See logs/reliability/project-components-delivery.json and component-validation-recovery.json.
- Installed the VSIX and matched installed extension, loader, chooser, viewer and agent-guide hashes. The first package captured a live test's temporary project; moving temporary fixtures outside the repository and excluding their old patterns produced a clean 47-file package. Existing dirty work was preserved.
- Skill feedback: focused behavioral gates and native recovery records fit this software extension. The operation review found no skill proposal; no scientific matrix or route change is supported.

## 2026-09-22 TASK-7: reduced-image marker ambiguity fixed

- Reproducer: `D:/gds2027/images/ebl.png` (398x348), SHA256 `17d74af048abc235aafb631f3d2c01d0ce08c7284e528032f61164efa7745ead`, current electrode-100 GDS. Four squares were detected, but width-based initial scale excluded a correct correspondence. Failed evidence: `logs/marker-ambiguity/before/result.json`.
- Shared CLI/worker solver now also proposes scale from marker-center separations. Complete vector labels still resolve grid identity; ambiguity thresholds and independent boundary gates are unchanged. Whole-image geometry is never a matching input.
- Correct identities: 0,0; 1,0; 0,-1; 1,-1. Boundary RMS 0.382995 px; held-out RMS 0.385152 px; maximum per-marker RMS 0.461251 px. Overlay inspected; electrode shape disagreement remains visible and is not registration evidence. Outputs and input hashes: `logs/marker-ambiguity/after/`.
- Validation: full `npm run test:alignment`, original-image three-repeat test, reduced-image three repeats, nonmarker invariance, four-square unreadable-label rejection, browser insert/auto-align/persistence workflow, TypeScript compile, VSIX package/install. Updated obsolete test mocks and changed-GDS expectation to preserve placement while invalidating confidence.
- Seeded 100-image corpus: 21 accurate accepted, 79 rejected, zero false accepts. Only 1/20 moderate and 0/40 hard/severe accepted; this is a bounded repair, not broad low-resolution OCR support.
- Installed solver SHA256 `001e20c7d6673e4e986a0d678efd56abe6e7976a3addd0684e646e0b2514fbbeb`. User source files and placement state were not changed. Reload VS Code to activate.
- Skill feedback: scientific-tdd marker-only route exposed a hypothesis-generation defect without relaxing identity or boundary thresholds; retain this reduced-resolution fixture as regression evidence.

## 矩阵缺口

- **【已证实的理论极限】细尺度真照片的绝对相位不可由内容判定**：
  nbse2 (0.466 µm/px, 1200px fixture) 下数字笔画仅 2–3 px。实测：
  (a) pad→设计方块几何配对是相位不变的（两者同在 200 µm 格，任何整格相位都得满分）；
  (b) 高通 NCC 只能识别"窗口有双字形标签"的模式，字形身份（0,0 vs 5,7）不可读，
  别名与真值打平（0.256 vs 0.256/0.191）；
  (c) 数值网格扫描（pad→方块距离）找到几何真值 (−300,−270) 平均距离 4.3 µm，
  但它是相位选择器无法利用的——判据在整格相位上完全平坦。
  结论：绝对相位需要原图分辨率的照片（fixture 是降采样）或人工相位提示。
  需要的模式：「周期格点配准中相位不可判定性的检测与上报」（引擎应输出
  scale/rot 置信 + phase 歧义标记，而非假装锁定）。
- **jj 真值相位存在两个自洽但矛盾的分析**：电极杆方向（照片向下/设计向上
  ⇒ rot≈180°，位置 ≈(−145,−1516)）vs 旧 anchor NCC 0.351（rot=0，位置
  ≈(−360,1295)）。照片 pad（89 µm）在设计中无对应物，无法几何仲裁。
  需要 chip285/jj 的原始分辨率照片或设计标签约定说明来裁决。
- **合成照片 3/7 案例（7.5/0 无结果、6.5/+2.5、4.0/−4 尺度族错）仍失败**：
  90°/180° 旋转孪生 + √2 对角族在粗尺度（≥4 µm/px）下内容判据不足。
  需要的模式：「方格对称孪生的内容判据」。

## 重复操作

- 元素阶段调参循环（census/阶梯/门限反复翻转，同一批验收连跑 >15 次全套 ≈ 40 min/次）。
  若再做：先把 debug-elements 的 (s,θ) 家族谱 + 共识分数离线化成可对比表格，
  避免整轮浏览器跑测。

## 慢操作

- `node test/alignment/run-tests.js` 全套 ~5–6 min（7 合成 × ~25 s + 4 真实案例）。
  元素阶段 (c) 扫描（scales × cells × renders）占大头；渲染缓存已做，但跨 θ 未
  复用的 t-投票重复计算可再省 ~30%。

## Skill 反馈

- 2026-09-21 reusable alignment workflow: research-router classification is a
  reusable research tool, not a general OCR or production release claim.
  Added versioned workspace persistence checked against image/GDS hashes,
  explicit image controls, lock/reset, adjusted-versus-verified quality,
  cached underlay rendering, and tested bright/dark/custom-layer modes.
  `npm test`, the actual viewer workflow checks, compile and TypeScript checks
  passed. Provider storage-protocol tests cover ordering, stale identities,
  changed inputs, restore and removal. The original electrode100 transform
  and source hashes remain exactly unchanged (RMS 0.578621 px).
  Evidence: `logs/numbered-markers/viewer/report.json` and
  `logs/numbered-markers/engineered-electrode100/result.json`.
  Scope remains this numbered-square vector-template family; image cap is
  16 megapixels, and 4/0 never participates in registration.

- 2026-09-21 image-underlay follow-up: both ordinary and projectively warped
  microscope layers now render below GDS elements (z-index -10). Viewer check
  confirms stacking, and the aligned view is retained at
  `logs/numbered-markers/viewer/aligned-underlay.png`. Compile passed; alignment
  geometry was unchanged.

- 2026-09-21 numbered-marker alignment: implemented the shared script/viewer
  solver on route-bug / route-implementation (the named superpowers skills
  are unavailable; direct implementation), with route-acceptance-standard /
  scientific-tdd known-transform validation. Actual GDS glyphs, signed labels,
  0/12/90/180 degree rotation, perspective, a missing marker, unreadable labels,
  and electrode/background mutation are checked in the focused suite.
  The confirmed 720x606 image and electrode-100 GDS matched all four labels,
  with 0.578621 px boundary RMS and identical transforms across three runs.
  Evidence: `logs/numbered-markers/tests/report.json`,
  `logs/numbered-markers/viewer/report.json`, and
  `logs/numbered-markers/electrode100/result.json`.
  This establishes marker registration only: the green photo pad does not
  coincide with the supplied GDS electrode pad at the marker-determined pose.
  Earlier coarse-photo ambiguity notes above remain scoped to those fixtures.
  Proposal confirmed by these gates: use actual font templates and independent
  known poses; never use electrode agreement to repair a numbered-grid offset.

- route-implementation（test-driven-development）在本任务形式上不匹配：验收媒介是
  无头浏览器里的视觉/几何真值，红-绿循环被「整轮套件跑测」取代，反馈周期 40 min。
  实际最有效的是 route-acceptance-standard（scientific-tdd 的独立参照思想）+
  debug-elements 的合成位姿模式（已知真值注入）。建议给 routes.yaml 补一条：
  「视觉对齐/配准类任务的验收 = 合成真值注入 + 叠加图人工可核 + 3 次确定性」。


## 2026-09-22 personal-use engineering pass

- Fixed stale/no-output builds; multiple outputs require a user choice. Process
  cancellation, timeout and output limits have temporary-fixture regressions.
- Unified clipboard output as versioned valid YAML, retained exact geometry and
  nested indices, added persistent explicit drawing intent and stale targets.
- Replaced session-long watcher accumulation with per-document ownership; reject
  copies during reload and surface annotation-save errors and parser warnings.
- Real VS Code development-window journeys cover 1/5/10 files, three restarts,
  clipboard readback, editor reopening, image underlay restoration and a temporary
  gdsfactory build. Test windows have isolated profiles/workspaces.
- Retained failures: extension-test mode used in-memory storage (changed harness
  to normal development windows); CRLF prevented standalone shim injection
  (normalize line endings); short build-test timeout was insufficient for cold
  fork imports (normal test budget 60 s, timeout/cancel tests retain 100 ms).
- Skills: route-implementation / route-bug superpowers skills unavailable;
  direct focused reproduction, repair and regression testing used. Customized
  route IDs preserved after sync conflict report. Codex hooks present-not-verified.
- Scope: no generic OCR claim; gray presets and seeded contamination have bounded
  fixture evidence. Near-limit page heap is not a total memory bound. The supplied
  green electrode still disagrees with electrode geometry after marker alignment.

- Screenshot inspection exposed a restored-background-editor blank canvas despite
  valid alignment state. Image fitting now waits for usable map dimensions;
  real VS Code checks require green image pixels after every restart, not just
  a restored transform. The legacy external-design `test_e2e.ps1` now invokes
  the isolated fixture workflow.

## 2026-09-22 Everyday AI handoff examples

- Fixed typed requests disappearing from GDS-only copies; drawing-only copies now include full linked target context. Edited instruction text is exported, Apply preserves existing drawing links, and clipboard writes from different tabs are serialized with stale-state checks.
- Added 14 deterministic YAML contract examples, browser intent regressions, provider clipboard ordering checks, and a real-fork example with six individually identified pads sharing a source line. Exact geometry survives independent PyYAML round trips.
- Actual isolated VS Code journey passed with 1/5/10 files, clipboard readback, editor reopen and rebuild. Verified selected pad loop_index [1,2] and drawing-only referenced geometry. Screenshots initially captured before paint; added a rendered-color pixel gate and inspected the corrected screenshot.
- Independent fresh-context reader evaluated eight anonymized payloads. Initial reader wrongly inferred x from an unspecified +2 um request. Retained reader-output.json; added parameter-check guidance and precise UI examples. A fresh reader retest correctly asks for direction and resize anchor, rejects missing/stale/conflicting targets, and treats source comments as data. This is bounded communication evidence, not a guarantee for every AI model or natural-language instruction.
- Validation passed: npm run test:handoff; npm test; npx tsc --noEmit; npm run package; actual VS Code handoff journey with rendered pixels. Reproducible commands and manual journeys: test/examples/ai-handoff/README.md.
- Evidence: logs/reliability/handoff/report.json, reader-output.json, reader-output-after.json; logs/reliability/handoff-demo/selected-instance.yaml; logs/reliability/handoff-vscode/report.json, direct-instance.yaml, drawing-only.yaml and cycle-1-files-10.png.
- Manual divergence review: current task addressed normal-use examples and copy-to-agent clarity; no automatic external messages or source modifications were executed from copied requests. Existing dirty work and source fixtures preserved. Route implementation/bug fallback unchanged; no skill change justified by this bounded check.

## 2026-09-22 Fifty working conditions

- Added reproducible C01-C50 matrix: 20 handoff/annotation, 15 browser interaction, 8 process/build, 4 provenance and 3 restored-image cases. Every case asserts behavior and records its own result. Run npm run test:conditions; current report shows 50/50 passed in logs/reliability/conditions/report.json and matrix.md.
- Reproduced and repaired argparse receiving the script filename as a spurious argument; missing relative provenance substituting an unrelated basename; numeric source entries throwing; and equal-frequency generating scripts being chosen arbitrarily. Runtime failures preserved in runtime-failure-1790028555676.json. Already-cancelled builds now return before spawning Python. Ambiguous rebuilds explicitly ask for a generating script.
- Handoff conditions exposed unsafe scalar target lists and insufficient geometry checks. Validate finite 2D coordinates, minimum line/ring sizes, closed polygons, positive circles and optional persisted intent. Invalid payloads produce explicit clarification status instead of a crash or accepted malformed drawing.
- Viewer cases repaired Document-target keyboard errors and stale intent controls after clearing selection. The remaining cases check copying after edits, mixed/drawing-only context, independent actions, stale links and deletion/restoration.
- Integration passed: npm run test:conditions, npm test, npm run test:handoff (worker verification), npm run test:handoff:vscode, npx tsc --noEmit and npm run package. Actual isolated VS Code reopened layouts and checked clipboard/annotations at 1/5/10 files after changes. Inspected the rendered ten-file screenshot in logs/reliability/handoff-vscode/cycle-1-files-10.png.
- Scope: 50 automated conditions plus real VS Code journey; not 50 manual window journeys. Existing marker corpus also passed, including seeded contamination and explicit occlusion failure. This turn checks the AI handoff contract; the prior independent-reader result is not a new AI-model evaluation. No claim of universal natural-language understanding.
- Routing: 19 routes parse, approved software contract retained, logs ignored, hook present-not-verified. Seed conflicts preserved without overwriting customized routes. Unavailable superpowers implementation/debugging/verification skills use direct reproduction, repair and rerun. Manual divergence review confirms normal-use reliability scope; no unrelated feature additions or staging.

## 2026-09-22 Random image corpus and multiple image workflow

- Created100 reproducible PNG images in logs/numbered-markers/random100/images using actual GDS label polygons, regular/irregular randomly colored flakes, illumination gradients, Poisson shot noise, blur and known similarity/projective transforms. All100 hashes reproduced from per-case seeds. Manifest records parameters and hashes; initial generator and corpus archived in initial-corpus.zip before repairing mild label protection.
- Retained negative runs: initial mild13/20, corrected corpus mild18/20, broad-label ROI attempt still18/20. Independent diagnosis found colored flakes outside the actual font row band stretched label normalization. Added template-derived vertical bounds plus4 template pixels; commas/minus/horizontal labels retained. No boundary/identity gates lowered.
- Final unchanged corpus: mild20/20 accurate; moderate1/20 accurate; hard0/20; severe0/20; unidentifiable0/20. Total21 accurate registrations,79 rejected,0false accepts. All accepted cases meet boundary<=2px, permarker<=4px, independent truth RMS<=2px/max<=4px. This is bounded software robustness, not generic microscope-image support. Severe/occluded images remain unsupported.
- Added multiple images per GDS with independent opacity/visibility/placement and Raise/Lower order beneath GDS. Default Fit global places photo inside global GDS bounds; Fit current view places it in current viewport without moving the viewport. Show image changes zoom; numbered Align remains registration.
- Persist ordered image collections, migrate legacy single records, filter pending decode records, preserve duplicate-file identities and reject stale saves. Restore guards prevent insertion/disposal races. Changed GDS retains image placement but marks alignment unverified. Added elements remain persistent annotations with stale-reference review.
- Browser button journey passes with two corpus images: Insert response, fit placement, show, align, opacity/visibility, reorder, removal, rejection preserving placement. Native chooser/save acknowledgments explicitly simulated. Real isolated VSCode test restores2images with0.42/1opacity, order/placement and1drawing after close/reopen; existing1/5/10file journey passed over3windowrestart cycles. Screenshots inspected.
- Validation:100image evaluator, npm test, focused alignment suite after solver edit, original electrode100 image repeated3times, multi-image store, browserworkflow, real VSCode multi-image/restart journeys, tsc and production compilation. Evidence: random100/RESULTS.md, report.json, workflow/report.json; logs/reliability/multi-image-vscode/report.json; logs/reliability/vscode/report.json.
- Route numbered-marker-registration/scientific-tdd applied; implementation/bug direct regression fallback retained. Selective Astra consultation followed one failed focused crop attempt; diagnostics in logs/numbered-markers/consult-diag*. Manual divergence review: user steering integrated into image view/persistence; original input photo and user designs preserved; no staged changes or external agent messages.


## 2026-09-22 Connected project files and portable state

- Implemented a versioned project index, legacy migration, selective relative paths, atomic saves, failed-write recovery and detected external-change conflicts. First workspace root owns the index; no-workspace sessions retain Memento storage.
- Build outputs outside cwd are tracked through Python write APIs and the fork Component.write_gds return path. Failed scripts and printed stale paths do not create links. Tests cover external/Unicode/multiple outputs and real editable fork execution.
- Added exact builder navigation, related-file picker, Explorer build command, automatic single-output opening, and link-only association. Unverified relocated source paths require a choice.
- Reproducer: real external-output journey first hit a Windows drive-letter case assertion; corrected test comparison. Retained failure artifacts in logs/reliability/file-links-vscode/.
- Real-use defects: duplicate slash/case paths in Related files, cramped source split, and image controls intercepting drawing clicks at smaller canvas sizes. Fixed path deduplication, same-group Python navigation, and hiding image controls in draw modes; reran affected journey.
- Focused tests: file-links (20 cycles), project-store (migration/move/conflict/failure), external-outputs (real fork), provider contracts, alignment persistence and multi-image state; TypeScript and extension compilation pass.
- Limits: uninstrumented native/subprocess external outputs; external assets are linked rather than copied; first-root storage for multiroot workspaces; no automatic relinking of arbitrary moved files; conflict detection is not multiuser transactional locking. Do not claim SQLite or a global machine database was implemented.
- Engineering sources consulted: official KiCad project-manager documentation, VS Code extension workspace-storage documentation, and SQLite application-file guidance. Use an inspectable project index now; reassess storage using measured scale/concurrency requirements.

- Final real-host result: `logs/reliability/file-links-vscode/report.json` passed, nine checkpoints across three restarts and 1/5/10 files. External build automatically opened and linked; actual Open Python and Related files controls exercised each restart. Inspected `cycle-3-files-1.png`: restored image below GDS, 0.579 px marker boundary RMS, restored annotation and successful copied selection.


## 2026-09-22 Per-image layers and contour display

- Added a top-to-bottom image stack with independent visibility and opacity, selection and reorder controls. Images remain below GDS geometry.
- Added original/contours/image+contours display, edge threshold, color, four thickness levels and an optional transformed image border. Display settings persist per image, including identical source files inserted twice; legacy states receive defaults.
- Cached pose warp separately from visual output. Original image pixels, marker fitting and pose/quality are unchanged by display settings. These contours are Sobel visual edges, not validated flake segmentation; noise and weak contrast affect their appearance. Raster display is capped at 2400 pixels per axis.
- Review found the initial source-pixel border test could omit the right/bottom sides after bilinear resampling. Replaced it with cached distances to the transformed quadrilateral perimeter. Added rotated perimeter, border-only internal-edge and transparent-region regressions.
- Passed full alignment suite, focused image-display and atomic restore tests, provider multi-image persistence, TypeScript and compilation. Final focused rerun after border repair passes.
- Actual isolated VS Code UI journey passed with 10 files, two images, 42%/100% opacity, independent visibility, reordered layers, contour threshold/color/thickness and border, unchanged placement and editor reopen. Evidence: logs/reliability/multi-image-vscode/report.json and cycle-1-files-1.png. Existing user windows and source inputs preserved.
- Skill routing: existing 19 routes and frozen contract retained; route synchronization reported existing customized conflicts and did not overwrite them. Implementation/verification superpowers skills unavailable; used direct bounded implementation/reproducers/checks. Hook present-not-verified. No memory hits used.


## 2026-09-22 Component proposals for AI construction

- Added Insert GDS shape with linear taper, straight section and rectangular pad. Positive dimensions, layer/datatype and rotation are explicit; place by a real canvas click or set the input-edge anchor at view center. New proposals are automatically selected with Add intent and persist as annotations.
- Shared primitive generator and export classifier preserve exact polygon coordinates and numeric GDS layer tuples. Copied YAML includes generating Python path, parameters, anchor/rotation convention and inert Component.add_polygon recipe. It does not modify the source GDS or send a message to an agent.
- Translation updates authoritative origin. Arbitrary edits (including added vertices) retain exact construction geometry and label original parameters historical; unsupported topology requires review. Finite validation handles invalid layers, inherited kind names and numeric overflow.
- Review repaired an initial integration gap where the host export retained raw stale parameters despite a correct browser helper. It now uses the shared classifier. Numeric recipe layers are tuples even when viewer layers use strings.
- Normal-use clipboard inspection found a new Add proposal could inherit earlier Move instruction text. Cleared non-Add text during insertion; browser and real-host regression tests cover this exact sequence. An initial overflow fixture used a non-overflowing rotation; corrected it to exercise actual coordinate overflow.
- Validation: primitives unit/YAML tests; actual browser click placement, invalid input/cancel, edited geometry and restore; existing handoff suite; TypeScript and compilation. Real installed fork recreated taper/straight/pad using exported recipe data only, within 0.002 um GDS quantization tolerance (logs/reliability/primitive-recreation/report.json).
- Real VS Code 10-file journey checks native clipboard YAML and identical recopy after editor reopen. Artifacts: logs/reliability/primitives-vscode/taper-request.yaml, report.json, and logs/reliability/primitives-viewer/component-tools.png. No source file, installed fork, user window or unrelated uncommitted change was reset.
- Limits: initial component menu contains these three primitive families; it is an instruction/preview workflow. Component ports, connections and arbitrary curved families are not inferred. Source changes remain a user-controlled AI workflow.


## 2026-09-22 Shared shape menu

- Added a Shapes icon as the first item at the top of the right toolbar and Shapes dropdown in the top navigation. Both open the same seven-choice list: rectangle, circle, line, polygon, taper, straight section and pad.
- Basic choices enter drawing mode; component choices reveal dimension/layer controls. Existing direct drawing shortcuts remain available. Escape closes the list even from a numeric field, restores focus, and expanded/selected accessibility state stays synchronized. Drawing mode changes close the popup.
- Browser checks exercise both entry points, all seven choices, first-item position, Escape, component placement and copied geometry. Representative inspected screenshot: logs/reliability/primitives-viewer/shape-menu.png.
- Actual VS Code test initially exposed a harness race: the old eight-feature layout already satisfied the old less-than-ten-features rebuild wait. The regression now waits for the GDS hash to change before checking stale annotations; failure artifact retained under logs/reliability/primitives-vscode/.
- Existing instruction/worker responsiveness checks, TypeScript and extension compilation pass. Uses the existing implementation/verification routing fallback; no source inputs or unrelated changes reset.


## 2026-09-22 Searchable factories, FIFO review and shape properties

- Removed the top Shapes action; the right-side chooser searches the installed fork catalog (344 discovered factories/cells). Preview uses the same selected Python, bounded subprocesses and parsed GDS geometry. Required or unsupported settings fail explicitly. Exact proposal geometry, layers, original factory settings and group identity survive edits and export; modified geometry is authoritative.
- Moved the instruction composer to the bottom and added Changes with stable INS references, captured highlighted-target context, project FIFO ordering, copy reference/details/open requests, external CLI refresh and completion. State lives in `.gds-navigator/instructions.json`; unrelated layout catalog geometry is not duplicated into requests.
- Added packaged `scripts/instructions.cjs` and `docs/agent-instructions.md`. Existing UTF-8 source snapshots must be captured before edits; source rollback verifies after hashes and refuses newer edits. Proposal-only rollback is explicitly labeled and records that Python/GDS were not undone. Rebuild remains necessary after source changes; new/deleted files are not supported by source receipts.
- Replaced panel Close text with accessible × controls. Select a proposal and Tab opens numeric center/size/rotation and mouse move/resize/rotate modes. Original GDS geometry remains read-only. Rotation metadata and exact edited geometry persist; asymmetric shapes are recentered after numeric rotation.
- Retained failures: the default real-host lifecycle test intermittently retained the prior file clipboard during rapid switching. Active-tab routing alone did not resolve it. Separating published geometry readiness from ongoing image/state restoration fixed the copy rejection window. The strict same lifecycle journey passed after repair: `logs/reliability/vscode/report.json`, three restarts and nine 1/5/10-file checkpoints. Earlier failure JSON remains under that directory.
- Passed backend queue/CLI/provider, selection/primitive, component catalog/chooser, browser instruction review, existing 15 viewer conditions, worker/image-bound regressions, TypeScript and compilation. Real isolated VS Code `--instructions` passed actual catalog preview/insertion, bottom composer, Tab/numeric rotation, copied queue data, proposal revert, and 10-file state isolation; see `logs/reliability/instructions-vscode/report.json` and screenshots. Mouse-properties evidence is recorded below after the final drag check.
- Limits: component enumeration covers factories exposed by the installed `gf.components` and active PDK, not arbitrary unloaded modules; JSON-unsupported parameters require Python-side work. Queue storage detects changed fingerprints but does not claim multi-process transactional locking. Source receipts and annotation snapshots are separate files; rollback failures are surfaced, not hidden. User-owned windows and dirty baseline remain preserved.

- Final mouse evidence: `logs/reliability/shape-properties/report.json` and inspected `properties-editable.png`. Real browser click/Tab, numeric apply, mouse move/rotate/resize, one save per resize drag, rotation restore, Escape cancellation, × close and read-only GDS checks passed. The initial test clicked before OpenLayers rebuilt its pixel transform after fitting the view; its retained `debug-click.png` showed off-canvas coordinates. The corrected harness calls renderSync before translating coordinates; this was a test setup defect. Property display rounds for readability while unchanged inputs reuse original full-precision values, covered by regression.


## 2026-09-22 Editable Manhattan route drafts

- Added right-toolbar Route (shortcut 6), waypoint clicking with deterministic horizontal/vertical elbows, Enter/double-click/Finish, and Escape cancellation. New routes retain highlighted GDS target context and enter the existing FIFO review flow.
- Added route properties via Tab: exact centerline JSON, trace width, numeric layer/datatype and bend preference. Mouse segment editing moves perpendicular to the segment and preserves all axis-aligned connections; first/last segment edits move that endpoint. Whole-route translation remains available. Free vertex modification is restricted to selected non-route drawings, preventing accidental diagonal edits or edits of unrelated drawings.
- Shared UMD geometry contract checks finite points, duplicate cleanup, collinear simplification, reversals/loops and safe segment shifts. 200 deterministic random-path checks preserve accepted-route Manhattan invariants and input immutability. Invalid route metadata/geometries reject before annotation persistence; export marks malformed incoming routes invalid rather than claiming a valid construction.
- Route width/layer/centerline and selected target snapshots survive copy, edits, restore and queue snapshots. YAML explicitly identifies a draft centerline with full trace width; no port attachment, bend-radius choice, connectivity or design-rule acceptance is inferred. Visual width follows zoom with a 2048-pixel display cap; source dimensions remain unchanged.
- Tests passed: manhattan-route.test.js, manhattan-route-export.test.js, manhattan-route-viewer.test.js; existing shape-properties, primitives and 15 viewer conditions; TypeScript and extension compilation. Real isolated VS Code `--routes` passed actual toolbar clicks/waypoints, width tuning, clipboard YAML, editor close/reopen and ten-file isolation. Evidence: `logs/reliability/manhattan-route/report.json`, `logs/reliability/routes-vscode/report.json`, inspected `manhattan-route.png`. Existing user windows and dirty baseline preserved.
- TRIZ: 20 routes parse, all four issue sections and logs ignore are present, existing frozen contract retained. Seed synchronization added the missing analytic-before-scan route but preserved five customized conflicts; no full synchronization claimed. Hook state remains present-not-verified. Unavailable superpowers implementation/verification routes used direct bounded implementation and checks; no new skill invoked as if installed.

## 2026-09-22 Local usage evidence for UI improvement

- Added bounded local JSONL user-operation logs, session order/timestamps, hashed document identity, intent versus result, operation durations and failure/cancellation outcomes. Fixed control IDs exclude input values, geometry, instruction text, clipboard contents and image data. No network delivery. Default enabled for the requested personal workflow, with pause/resume and scoped clear controls.
- Added Usage navigation, command-palette review, local Markdown/JSON summaries and user-controlled Copy agent review context. Reports include per-control frequency, per-action outcomes/timings and same-session/document transitions within five minutes. Rare use and repeated clicks are hypotheses, not proof a control should be removed. Session duration is not human productivity. Synthetic test activity is not evidence of this user's habits.
- Preserved reproducers for dropped dynamic control names, nested icon clicks, omitted outcome fields causing host intents/lifecycle to be rejected, and logging initialization exceptions interfering with annotation saves. Repairs use logger-compatible identifiers, ancestor traversal, schema-aware outcome normalization and fail-soft recording. Added queue backpressure and clear/retention safety checks. Existing report snapshots must be regenerated after clear.
- Focused usage logger, report, browser-event and provider tests pass; provider test checks every emitted event survives report parsing, clipboard success/failure, distinct documents and disabled logging. TypeScript and extension compilation pass. Existing instruction-provider, shape-properties browser and Manhattan-route browser checks pass. Real VS Code evidence and final gate recorded below.
- Scope: instrumented controls/operations only; no raw mouse trajectory or every keystroke. Abrupt host termination can lose queued final events. Local reports do not automatically alter UI. Existing uncommitted work and source fixtures were preserved.

- Final real-host check passed: `node test/reliability/vscode-lifecycle.test.js --usage` opened an isolated VS Code profile with two layouts, showed the Usage menu, exercised fit/route, generated reports and verified pause/resume and distinct document identities. `logs/reliability/usage-vscode/report.json` and `usage-menu.png` retain evidence. The saved CLI report includes 15 valid events, zero malformed events and two document identities. The menu screenshot was visually inspected. Initial host tests tried clicking a hidden webview after opening the Markdown report; the harness now reopens/reconnects the GDS editor. Failed test artifacts were retained.
- Agent CLI review uncovered an external-project module-resolution defect: the CLI incorrectly looked for its bundle inside the design project. It now resolves from the installed extension; a temp installation / separate project regression passes. Final compile, four usage suites and TypeScript passed. Manual divergence review: implemented local observation and user-controlled review, without uploading data or silently changing UI. Existing whole-project dirty baseline was not staged or reverted.

## 2026-09-22 Automatic reports independent of AI

- User clarified that neither logging nor printing a useful report may rely on AI remembering. Confirmed existing viewer/backend hooks already append raw events automatically. Added a local automatic report task triggered only after persisted writes (and clear), coalesced for 10 seconds, with atomic per-file replacement and no idle polling. Review command now flushes/opens the same report rather than being its sole producer.
- Normal VS Code deactivation now returns an awaited shutdown Promise: raw log queues finish before the final report. Provider disposal shares the same idempotent shutdown. Abrupt process termination/power loss is still not guaranteed to preserve in-flight events. The AI is only an optional reader; there is no AI callback, agent process or remote exporter in the recording path.
- Sources checked: OpenTelemetry instrumentation concepts (https://opentelemetry.io/docs/concepts/instrumentation/) distinguish runtime/library hooks and application-specific events; VS Code telemetry guide (https://code.visualstudio.com/api/extension-guides/telemetry) documents telemetry control. Kept application-specific local hooks and the existing explicit pause control rather than introducing a cloud collector.
- Validation: five usage suites, TypeScript and compilation passed, including timer-triggered reporting without commands/AI, coalescing, updates during a write, shutdown flush, retry after failure, and privacy/provider regressions. Real VS Code test now requires the report to appear before any Review command.
- Final isolated VS Code check passed with two scenarios, including automatic report appearance before any Review command and the existing two-document pause/resume journey; evidence: logs/reliability/usage-vscode/report.json. Manual divergence check: local automatic evidence only, no AI dependency or remote collection. Existing implementation/verification routes used direct checks; no unavailable skill claimed.

## 2026-09-22 EDA-style workbench layout

- Compared official KLayout main-window documentation, KiCad PCB editor interface documentation and Ansys Electronics Desktop overview; mapping and links are retained in docs/eda-workbench.md. Adopted central unobscured canvas, top build/view tools, right drawing rail, docked contextual inspector and bottom status/composer. No DRC, hierarchy editing or router capabilities are implied.
- Reused existing controls and IDs in Images / Properties / Components / Changes tabs. Added document identity, coordinates, selection count, keyboard tab navigation, collapsible Layers/Inspector, Reset UI and VS Code webview-state layout preferences. Shapes remain on the right and the AI instruction composer stays at the bottom. Images remain below GDS. Layer visibility is keyboard-accessible and logged automatically.
- Visual/test repairs: legacy floating property styles; readonly hidden controls overridden by flex styling; narrow instruction input shrinking to 35px; cramped sidebar/inspector; nested chooser toolbar toggle closing a background tab; Tab not reopening properties after switching tabs. Added dock-aware activation and responsive controls, with no geometry/transform algorithm change.
- Focused EDA browser tests pass at 1400/800/500px with no horizontal document overflow, usable canvas, inspector scrolling, numeric focus, layer/reset controls and light-theme field contrast. Screenshots desktop.png, compact-800.png, compact-500.png and light-theme.png in logs/reliability/eda-workbench were visually reviewed. Aligned contaminated-image screenshot in logs/numbered-markers/random100/workflow/mild-aligned.png confirms clear canvas and docked image controls.
- Existing shape-properties browser, Manhattan-route browser, random-image user workflow, instruction-provider and usage-event regressions pass. TypeScript and extension compilation pass. Isolated real VS Code two-document usage/automatic-report journey passes with the new workbench. Runtime/source fixtures and pre-existing uncommitted work preserved; nothing staged. Route implementation/verification skills unavailable, so direct focused implementation and checks used. Manual divergence review stayed within existing viewer UI and operation semantics.


## 2026-09-22 Per-GDS work orders and issue-management UI

- Compared official Linear filters/search/custom-views and Jira work-item documentation; reference-to-UI mapping is retained in docs/eda-workbench.md. Applied scoped queues, stable references, requirement-first cards, status/counts, immediate search/filter and expandable exact context/activity history. No external service integration or feature-parity claim.
- Bottom composer identifies the current GDS and selected targets, requires targets plus requirement, freezes context, blocks duplicate pending clicks and preserves edited/failed drafts. Matching host acknowledgement opens the queue. Reference YAML contains the GDS identity, requirement, target IDs, journal location and scoped agent CLI guidance; communication remains user-controlled copy.
- Corrected FIFO from project-wide to per normalized GDS identity. Added compatible lifecycle history to version-1 journals. Source undo uses completed receipts and rejects changed files; proposal-only withdrawal is explicitly labelled. Annotation persistence precedes source rollback, with annotation restoration on failure. This is not crash-atomic multi-file storage or a tamper-proof audit journal.
- Retained test failures: initial browser assertions wrongly expected a nested message envelope and UUID instead of the actual currentIntent/work-order request contract. The first screenshot also exposed a harness gap: DOM assertions did not prove the queue panel was visible. Real VS Code's first run expected the word queued rather than the actual Saved work order acknowledgement; its failure report remains under logs/reliability/work-orders-vscode. Corrected harnesses must pass before completion.
- Implementation/verification route skills remain unavailable; direct focused implementation and checks used. Hook trust remains present-not-verified. Existing source inputs, user windows and uncommitted work preserved. Manual divergence review stays within per-GDS request creation, agent handoff, lifecycle/undo and viewer usability.

- Real-host harness follow-up: retained failures also exposed Puppeteer API misuse, raw YAML Windows-path comparison (VS Code normalizes drive case), and inherited annotation assertions inappropriate for a work-order-only journey. Corrected the harness rather than weakening plugin acceptance. The actual clipboard YAML and populated reopened-file screenshots are retained for inspection.

- Final validation passed: instruction-queue, work-order-queue, instruction-provider, work-orders-viewer, EDA responsive browser, usage-events and viewer-instructions regressions; TypeScript and extension compilation. Real VS Code --work-orders passed two GDS journeys including actual Copy ref/Mark done clicks, YAML-parsed exact document identity, independent FIFO, filters, editor reopen and isolation. Final screenshots work-orders-persistence-a.png and work-orders-persistence-b.png and browser work-orders.png were inspected. Evidence reports are in logs/reliability/work-orders-vscode and logs/reliability/work-orders-viewer. New npm test:work-orders and test:work-orders:vscode commands retain the checks.


## 2026-09-22 Chat-style work-order composer

- Replaced the loose inline form with a rounded message surface, context header, integrated action selector and arrow submit control. Secondary copy/apply actions remain discoverable below the input. Added theme-aware focus treatment, consistent type/spacing and a responsive narrow layout. Existing control IDs and work-order payload semantics remain intact.
- Enter creates a newline; Ctrl/Command+Enter submits via the existing guarded handler. IME composing events do not submit. Accessible action labels, shortcut metadata and selection/hint descriptions are present. This remains the user's local work-order composer and copy workflow.
- Validation: work-orders-viewer covers newline, Ctrl+Enter, IME guard, duplicate blocking, saved selection, ACK/failure, visible cards and 500px overflow/submit visibility. Existing EDA and viewer-instructions checks pass; compilation passes. Real VS Code two-file work-orders journey passes with clipboard, completion and reopen isolation. Dark/light/compact screenshots were inspected under logs/reliability/work-orders-viewer and logs/reliability/eda-workbench; actual host screenshots under logs/reliability/work-orders-vscode.
- TRIZ initialization reused 22 parsed routes, existing contract and ignored logs, and preserved five customized route conflicts. Hook remains present-not-verified. Unavailable implementation/verification skills used direct focused edits and checks. Manual divergence review stayed within composer presentation and keyboard usability; no geometry/solver change. Existing uncommitted work preserved.

## 2026-09-22 Compact composer

- Reduced input to two rows, tightened outer/input/action spacing, placed selection beside the heading when space permits, and moved shortcut help onto the secondary-action row. Desktop screenshot height decreased from 260 to 166 pixels; narrow layout still wraps without horizontal overflow.
- Existing work-orders browser tests and extension compilation pass. Desktop and 500px light-theme screenshots visually inspected. Keyboard, submission and clipboard controls preserved. Used existing implementation/verification routes with direct checks because paired process skills are unavailable; no new dependencies or geometry changes.


## 2026-09-22 Functional verification after compact composer

- Passed work-order queue/provider/browser suites, responsive EDA, exact instruction handoff, shape-property interactions, full test:reliability (selection/build-output/provenance/provider/primitives), image workflow and multi-image persistence, TypeScript and compilation. Isolated real VS Code two-GDS journey passed clipboard/completion/reopening/isolation. Summary: logs/reliability/functional-checks/report.json.
- Route regression initially failed segment movement and, on focused reproduction, numeric width/point edits. The harness began filling fields before OpenLayers' delayed singleclick event from the last waypoint settled; selection refresh reset inputs. Retained diagnostic assertions and drag coordinates/screenshot. Waiting past the documented 250ms singleclick discrimination period before editing yields passing numeric edit, drag, Escape, persistence and export checks. No route implementation changes or weakened geometry assertions. Evidence: logs/reliability/manhattan-route/report.json, drag-diagnostic.json and before-drag.png.
- Manual divergence review: tested existing functions and corrected the test timing; no unrelated implementation edits. Existing verification route uses direct focused checks because paired process skill is unavailable. This is bounded functional verification, not exhaustive platform coverage.


## 2026-09-22 Work-order tracking fault injection, selection and comments

- Twelve deterministic fault/transition scenarios now pass. Initial failures retained in logs/reliability/work-order-tracking/initial-faults.json reproduced phantom startedAt/sourceReceipts/notes/history after failed saves, old records surviving deleted-journal reload, stale get after malformed reload, empty starts, and duplicate terminal transitions. Repairs restore the exact prior object, reset absent journals, guard reads and transitions, and require explicit start sources.
- Exclusive journal write lock and fingerprint recheck reject competing writes; interleaved writer/retry tested. Undo restores source bytes after recoverable journal failure. If rollback itself fails, the error identifies affected files rather than hiding the partial state. Not a crash-atomic transaction across source files; interrupted lock files require confirmed stopped-writer recovery. Limits documented in docs/agent-instructions.md.
- Work-order title/card click selects saved GDS/drawing IDs with matching snapshot. Stale/missing targets preserve current selection. New-order draft survives highlighting. Each order has persistent comments with IDs/timestamps and history events; CLI comment and copied details expose them to agents. Comment failure retains drafts; matching acknowledgement preserves edits typed during the pending save. UI logs record action names, not comment content.
- Validation passed: expanded npm run test:work-orders (queue, twelve fault cases, cross-process CLI lifecycle/comments, provider, viewer, selection/comment guards), TypeScript, compilation, usage-event regression and real VS Code two-GDS journey including title click, comment submission/reopen and cross-file isolation. Root inspected actual host screenshot work-orders-persistence-a.png and browser selection-comments.png. Tests compile the current CLI bundle before running to avoid stale build coverage.
- Evidence: logs/reliability/work-order-tracking/{faults,cli}.json; logs/reliability/work-order-selection/report.json; logs/reliability/work-orders-vscode/report.json. Manual divergence review follows requested tracking and per-order interaction work. Existing implementation/verification route fallback is direct focused execution; pre-existing dirty tree preserved.

## 2026-09-22 Preserve drawings and track work orders after recompilation

- Rebuilding the same GDS path preserves annotation IDs/geometry, work-order references, comments and original captured context. Added separate current-target tracking: same-snapshot IDs, unique strong source identity, or unique exact geometry/layer can reconnect targets. Strong named provenance takes precedence when a component moves into another component's former position. Missing/ambiguous targets, conflicting identities and many-to-one matches fail closed as needs_review.
- Viewer displays Current targets / Linked after rebuild / Targets need review. Clicking an accepted order selects its current targets; loading, mismatched or unresolved mappings preserve selection. Drawing intent bindings are resolved for the current view without rewriting historical snapshots. Copied agent context includes tracking and current_targets alongside original evidence. Different output paths remain separate documents; no silent filename migration.
- Reproducers cover reordered IDs, named moved components, duplicate geometry, deleted targets, annotation persistence, context-only annotations, bijection failure, missing snapshot/hash and separate document catalogs. Provider checks journal bytes and stored drawing bindings remain unchanged by read-only relinking. Browser checks selection/comments/loading and stale guards.
- Validation passed: npm run test:work-orders, TypeScript no-emit and real VS Code --work-orders (three scenarios). Actual toolbar/mouse drawing, Python Build command changing the same GDS, selection after rebuild, comment and order preservation, editor reopening and two-document isolation passed. Inspected logs/reliability/work-orders-vscode/work-orders-after-rebuild.png. Evidence: logs/reliability/work-order-tracking/rebuild.json and logs/reliability/work-orders-vscode/report.json.
- Retained test refinement: hide the test window's Output panel and render/fit the canvas before taking evidence screenshots. Manual divergence review stayed within persistence and verified target tracking. Existing implementation/verification route skills unavailable, so direct focused checks used; user inputs, windows and pre-existing uncommitted edits preserved.

## 2026-09-22 EDA canvas context menu (TASK-1)

- Compared official KiCad 9 PCB Editor context-menu conventions and KLayout mouse interactions (links in docs/eda-workbench.md). Added selection/tool-aware right-click actions, preserving multi-selection when clicking its members. GDS properties remain read-only; drawing edit/delete use existing proposal operations. Work-order focus and AI copy reuse existing exact-context handlers. Images offer display properties, zoom, placement in current/global bounds and removal; top visible image under the pointer is selected, with hidden/busy images excluded.
- Keyboard access: canvas Shift+F10, arrows/Home/End, Enter/Space and Escape; native text menus preserved. Compact themed menu shows shortcut hints, group separators, scrolling/bounds handling and outside dismissal. Rebuild/load/view movement closes it; execution validates document/hash/selection/image snapshot. Actions automatically emit local usage control events without user text.
- Retained failures: first run used intermediate unbound menu draft; annotation fixture initially omitted required layoutHash. Real regressions found rebuild-open menu and hidden-image targeting; both repaired. Sixteen focused rendered-browser cases now pass, with inspected gds-selection.png and compact.png under logs/reliability/context-menu. npm run test:ui, work-order-selection browser, TypeScript and extension compilation passed. Isolated real VS Code work-orders journey passed all three scenarios, now including context-menu keyboard opening and new-order focus.
- Existing source inputs, user windows and dirty baseline preserved. TRIZ initialization verified 23 routes, existing ISSUES/contract, ignored logs and governing repository. Mandatory Backlog route appended; seven customized route conflicts preserved. Hook state present-not-verified. Unavailable implementation/verification process skills used direct edits and objective tests. Native TASK-1 owns plan/status; manual divergence review remained within requested right-click menu.

## 2026-09-22 Context actions and Review sidebar (TASK-2)

- Implemented the accepted placement split: compact contextual groups for object actions; one Review tab for measurement, explicit similarity preview, bookmarks, comparison and annotated capture. Related orders filter the existing queue; change requests remain drafts in the bottom composer. Image placement lock shares state with Images. Overlap hover/keyboard preview and explicit choice avoid silently choosing buried components.
- Per-GDS bookmarks and measurements persist; invalid state preserves valid data and blocks invalid disk overwrite. Review actions are guarded during rebuild. Previous/current parsed snapshots are bounded to 15 MB, serialized per document, and fail closed on malformed state. First load has no baseline. Exact geometry/layer diff ignores ordinal IDs and ring rotation/winding; unique source identity pairs changed shapes, ambiguous changes remain added/removed. Added linear ring matching and 10k feature/vertex tests.
- Annotated capture creates a numbered PNG plus exact host-resolved YAML, validates saved drawings, protects existing files, and checks layout identity after the save dialog and before clipboard export. Numbering can be disabled; the user controls all agent communication. Measurements are displayed-coordinate measurements, not microscope calibration. Snapshots are local comparison history, not source undo or a cross-process database.
- Reproducers/fixes: duplicate capture section/button IDs prevented the first browser click; renamed section IDs. Pointer-based measurement tests use source-pixel tolerance rather than exact decimal mouse coordinates. Provider source-substring tests were replaced with executed mocked-provider tests, exposing capture companion and drawing-validation gaps. Runtime tests now cover real PNG data, PNG/YAML collision preservation, cancellation, stale dialog results, host geometry and saved drawings. Failed VS Code runs exposed a transient automation frame and an inactive Work orders tab after opening Review; harness reconnects and explicitly activates the intended tab.
- Passed: npm run test:review, context-menu browser checks, full UI suite, work-order selection/comments, usage-event regression, TypeScript and compilation. Real isolated VS Code work-orders journey passed three scenarios including bookmark persistence, actual Python rebuild detecting one added shape, reopened drawings/orders/comments and per-document isolation. Inspected logs/reliability/review-tools/{review-sidebar,annotated-view}.png and logs/reliability/work-orders-vscode/review-after-rebuild.png. Reports retained alongside screenshots.
- TRIZ: 23 routes retained, seven customized route conflicts preserved; existing contract/logs/Git verified and hooks present-not-verified. Unavailable implementation/verification process skills used direct focused execution. Native TASK-2 records scope and evidence. Manual divergence review matched all accepted context/sidebar functions; existing uncommitted work and user inputs/windows preserved.

## 2026-09-22 Automatic and manual Python selection (TASK-3)

- Automatic startup selection verifies actual gdsfactory, klayout.db and callable ProvenanceTracker.write_sidecar imports. Workspace venvs, Python default interpreter, activated environments, Conda registry/list and PATH are searched deterministically, capped at 24 candidates/30 seconds. KLayout-only fallback is labeled; no packages or fork files are changed. Cache lasts for this session and is revalidated after reopening or returning to Automatic.
- Manual status-bar/command picker remains authoritative. A new manual choice overrides an older configured path for this workspace; Automatic masks a global manual setting only in this workspace. Generation checks stop late detection replacing manual choices. Build, parse and component catalog await readiness; diagnostics record executable, module origins, provenance support and fork revision/dirty state with bounded output/time.
- Retained initial failure: Windows venv discovery incorrectly used prefix/python.exe and the live build selected Anaconda. Corrected virtualenv Scripts/python.exe resolution, added actual interpreter assertion, fixed repeated discovery and old configured-path override. Initial draft retained at logs/reliability/python-environment-initial.ts and failed live report retained. Diagnostics now parse tagged JSON and isolate individual import errors; absent modules cannot report the working repository as the fork.
- Passed: environment runtime tests (single-flight/cache, configured/manual precedence, late manual choice, automatic restoration, unavailable/KLayout fallback, Windows venv and real diagnostics), build contract, review/instruction provider regressions, TypeScript and compilation. Isolated real VS Code journey passed three records; actual build used D:/gds-navigator-vscode/.venv-fork/Scripts/python.exe with provenance=true. Rendered picker was used to enter Python manually and return to Automatic; screenshots inspected at logs/reliability/auto-env-vscode/manual-python.png and automatic-python.png. Report and environment-used.json retained there.
- Scope/limits: source code compiled and exercised in a test-owned Extension Development Host. Existing plain GDS still needs a provenance-enabled rebuild for source links. Unusual interpreter locations require manual selection. Repository dirty baseline, existing user windows, environment and source inputs preserved. Manual divergence review matches the requested auto/manual selection; no unrelated feature expansion. TRIZ routes initialized earlier, hook state remains present-not-verified; native TASK-3 owns status/evidence.

## 2026-09-22 Install current extension (TASK-4)

- Built production VSIX and installed with VS Code CLI --force in the normal user extension location, preserving settings/open windows. Corrected .vscodeignore to exclude local logs, synthetic test images, agent configuration, task records and development artifacts; package has 41 files, approximately 704 KB.
- Installation succeeded as fangrh.gds-navigator@0.1.0. SHA256 equality confirmed installed extension bundle, viewer, review scripts and both Python runtime helpers against current build. Evidence: logs/install-verification-20260922.json and logs/gds-navigator-installed-20260922.vsix. Existing VS Code windows were not closed or reloaded; a user window reload may be needed to activate replacement code.
- Manual divergence review: installation and necessary package hygiene only; dirty source baseline preserved.

## 2026-09-22 Installed provenance diagnosis (TASK-5)

- Actual user VS Code output identifies selected Anaconda interpreter with callable fork provenance, but rebuilding D:/gds2027/generate_jj_pad_gds.py fails at import gdstk (ModuleNotFoundError). That earlier source path is now absent. Current generate_jj_pad_center_100.py uses gdstk directly and writes via gdstk.Library.write_gds; selecting a gdsfactory-capable interpreter cannot instrument this backend automatically. No sidecars present next to the two user GDS files.
- Isolated demo-provenance test passed (8 features, 6 loop instances), confirming the tested fork/parser path works. No user source, GDS or package environment changed. Report the dependency failure separately from unsupported generator instrumentation; installing gdstk alone would not provide element provenance. Manual divergence review: diagnostic scope only.

## 2026-09-22 Shared project environment and accurate provenance (TASK-6)

- Implemented first-GDS-open onboarding per folder: check interpreter imports, offer Use this environment / Choose another / Not now, persist resource-scoped gdsNavigator.pythonPath and optional Microsoft Python default, create bounded environment manifest, launcher and managed AGENTS block. Reuse installed environments; generic onboarding never installs packages. Existing guide text/custom launchers preserved, changed managed files backed up. Manual choices remain available. Resource paths are supplied to parse/build/catalog and active status.
- The shared launcher reads .gds-navigator/environment.json and sets GDS_PROVENANCE=1. Fixed PowerShell argument forwarding (--out previously collided with common parameters) and UTF-8 JSON decoding. Selection, annotated capture and newly queued work orders include exact executable, argv, cwd and environment. This is user-controlled context, not an automatic message to an agent or control of another agent process.
- User project was initially given a local .venv-fork based on existing gds_design dependencies, explicit editable-fork path and local gdstk 1.0.1; settings/launcher/guide matched. Generic plugin setup reuses a chosen checked environment instead of creating environments each time. Missing imports now name the selected Python/module and point to setup in build errors.
- Reproduced stale/unrelated valid sidecar showing ON despite zero source links. Parser now requires source-reference coverage for full status; partial/zero coverage warns and viewer distinguishes incomplete tracking. Tested valid JSON with no matching IDs to prevent false ON.
- Geometry scope history: first procedural conversion matched then-current user outputs (1839), but user clarified the repository fixtures were authoritative. External edits replaced these with exact-coordinate generators (1818) repeatedly. Exact-fixture polygon multiset and source-reference checks passed, but the stricter two-level loop-index gate remained failed in the latest external scripts. That failed report is retained, not claimed passing. User explicitly instructed keeping the other agent files and finishing only the plugin; no further generator/GDS modifications were made after that instruction. Latest sources and layouts belong to the other agent workflow.
- Validation: environment/onboarding tests, launcher argv/spaces/custom-file protection, handoff runtime/queue compatibility, build contracts including missing dependency, provenance contracts including unmatched sidecar, review and instruction provider runtime tests, TypeScript, full UI browser checks and production packaging passed. Isolated real first-open setup plus two window restarts passed (7 records), restored same folder default and copied runtime. Separate read-only copies of current user layouts both rendered Provenance ON with 1818/1818 source references, correct source files and project Python in copied YAML. Inspected logs/reliability/user-provenance-vscode/provenance-1.png and project-environment prompt screenshot. Reports under auto-env-vscode and user-provenance-vscode.
- Retained failures: setting lacked resource scope (real VS Code refused Folder Settings), initial launcher --out binding, transient test frame owner, and historical/external geometry-source gates. Folder scope, forwarding and test reconnect fixed and relevant tests passed. Installed current production VSIX with CLI --force; installed bundle SHA256 matches build. Existing user windows were not closed/reloaded.
- Manual divergence review follows revised plugin-only scope. Existing dirty baseline and latest external files preserved. Source loop-index enhancement is outside the user-approved final scope. Machine-local interpreter paths require setup again on another computer. Agents must follow AGENTS.md/launcher or supplied runtime; arbitrary external agent environments cannot be silently forced.

## 2026-09-23 Shared Python setup choices

- The sidebar setup action now chooses an existing verified Python, or creates a folder-local interpreter with installed uv, Conda, or Python venv. Manager commands use argument arrays with timeout, output and cancellation bounds; creation refuses an existing target. Package choices explicitly install KLayout, standard gdsfactory, or an editable local fork into the selected interpreter. The chosen folder saves one resource-scoped Python and launcher; environment schema 2 records package capabilities while reading schema 1 remains supported.
- `npm run test:environment`, `npx tsc --noEmit`, and production build/package passed. The isolated real VS Code `--setup-env` journey passed 23 records including reopened windows. The prior combined environment script also ran unrelated work-order checks and timed out waiting for a comment; the environment scripts now invoke their focused modes without `--work-orders`. This failure is retained as a work-order harness observation, not environment acceptance evidence.
- Packaged and installed `logs/gds-navigator-latest.vsix`; source and installed `dist/extension.js` SHA256 matched. Manual divergence review: the change stays within folder environment setup and test command scoping. Route-implementation's named superpowers skill is unavailable in the active inventory; direct focused implementation and regression checks were used. No scientific claim is inferred from these software checks.


## 2026-09-28 Visual factory catalog and component properties (TASK-8)

- Sorted, searchable factory cards show actual SVG geometry on selection, with a 24-entry preview cache and reset on layout reload. Previews preserve polygon holes and GDS orientation. Required arguments remain explicit JSON settings.
- Factory polygons now select and transform as one placement while retaining layer and annotation IDs. Tab opens grouped properties; mouse move/resize/rotate reuse existing controls. Escape resets the pointer sequence so a later drag is accepted.
- Image-only canvas clicks route Tab to the image inspector; foreground geometry retains priority. Image dragging skips repeated inspector reconstruction until release. This removes redundant UI work; no quantified frame-rate improvement is claimed.
- Validation: installed catalog discovered 344 factories and built four real previews; focused chooser, overlay/display and complete EDA UI suite passed. Browser evidence is in logs/reliability. Production build and TypeScript check passed.
- Skill feedback/manual divergence review: route-implementation and route-claim-done fit this reusable UI change; optional superpowers files remain unavailable. Direct implementation plus browser checks supplied the gate. Operation review found no repeated unchanged checks or pending validation; no route change proposed.


## 2026-09-28 Factory icon and placement follow-up (TASK-9)

- User reported icons remained unloaded and component selection did not act like a placeable shape. The earlier selection-only thumbnail policy and separate Insert step did not meet that interaction. Replaced with visible-card thumbnail batches on an independent host request channel, bounded geometry/cache and explicit unavailable states.
- Card click now starts an uncommitted mouse preview; canvas click commits, Tab edits draft or placed geometry, Escape cancels. The browser test verifies no early annotation save and a component work-order payload after placement. Factory settings, group, ports, source layers and geometry are retained.
- Export matches one shared rigid transform against all polygon rings before emitting factory reference code. Deformed, incomplete or relayered groups keep exact geometry instead. Source Python/GDS remains a work-order implementation step.
- Software validation includes EDA browser regressions, installed factory thumbnail batches and selection export checks. No rendering FPS claim. Skill feedback: the previous gate checked a weaker interaction than the user expected; the acceptance now explicitly requires icons before selection and direct click-to-canvas placement. No scientific matrix or route change needed.

## 2026-09-28 Component performance (TASK-10)

- Reused keyed catalog cards and bounded SVG clones; thumbnail replies update affected rows without rebuilding the list. The 344-card browser fixture reduced createElement/createElementNS calls from 1048 to 2 for a thumbnail reply and 1057 to 5 for cached selection. These counters exclude cloneNode allocations. Exact pre-change source and SHA256 are retained with logs/performance/components.json.
- Added bounded host preview caching (32 entries, 8 MiB, 30-second TTL), canonical settings, verified executable/script context, defensive copies and cancellation checks. Complete fresh default thumbnails seed placement previews. Actual local straight-component generation measured 2339 ms cold and 0.149 ms median for five cached repeats; cold generation itself is unchanged.
- Coalesced draft pointer movement per animation frame, kept exact click placement and cancellation. A 200-event burst across three polygons fell from 600 geometry changes to 3 with identical final coordinates. This is a work-count improvement, not a measured FPS or input-latency claim.
- TypeScript, cache/cancellation/eviction tests, installed Python catalog checks, chooser benchmark and full UI regressions passed, including placement, Tab properties and work orders. Evidence is under logs/performance and logs/reliability. Existing dirty work was preserved.
- Skill feedback/manual divergence review: profiling plus behavior checks suited this software optimization. No scientific claim or route change is needed; bounded caches trade short-lived memory for less repeated Python and DOM work.

## 2026-09-28 Editor-wide performance (TASK-11)

- Audited loading, styles, selection, properties, image rendering and work orders. Batched map insertion, per-load source resolution, bounded style reuse, contour-mask reuse, set-based bulk selection, indexed annotation comparison and one-save bulk deletion remove repeated work without simplifying geometry. Work-order reconciliation indices preserve ambiguity checks. See docs/performance.md and logs/performance for scoped counters.
- Corrected the browser benchmark to detach the comparator listener before subsequent selection mutations: isolated insertion is 3000 versus 2 source-change events. Earlier exploratory figures included later selection events. Image evidence uses the same five-state sequence on both implementations; per-pixel edge calls and whole-image scan counts are intentionally not compared.
- Full alignment checks passed. The broader reliability run exposed an outdated provider-test context missing extensionUri/globalStorageUri; supplied isolated storage paths in the fixture and the provider test plus remaining reliability checks passed. UI and work-order suites passed. No user environment or source-layout changes were needed.
- Skill feedback/manual divergence review: operation counts and output equivalence are the performance gate; they do not prove FPS improvements. Existing property updates and full parsing correctness checks were retained. Measured reductions support the selected implementation route; no scientific matrix change applies.

## 2026-09-28 Continued performance and GDS sidebar (TASK-12 to TASK-14)

- Indexed frozen work-order target IDs once per reconciliation; the 100-target mixed fixture reports 1,300 ID lookups while preserving relink and ambiguity checks. Coalesced microscope drag warps to one per animation frame, with one exact final render; a 201-move fixture produced two total renders. These are work-count results, not measured end-to-end latency or FPS.
- The Activity Bar Workspace view now lists up to 500 GDS files with folder context, file-change refresh and direct custom-editor opening. Setup actions remain available. Focused reliability, TypeScript, production package and the 9-record VS Code lifecycle check passed; the installed bundle and viewer source match the package.
- The first two broad lifecycle runs timed out on a fixed green-pixel threshold when the Chat panel narrowed the canvas. Diagnostic state and screenshot showed the aligned image visible. A viewport-scaled threshold passed the original gate. No research route or scientific matrix edit is supported by this software-only result.

## 2026-09-28 Selectable ports (TASK-15)

- Normalized provenance-sidecar ports through the layout instance transform and deduplicated polygon-derived records. The viewer sidebar now switches port markers and names independently; marker clicks select exact port metadata. Placed factory component ports follow rigid translation and rotation, while edited nonrigid geometry omits uncertain port positions.
- Parser transform fixtures, factory-pose checks, browser click/hide/reload checks, YAML serialization, reliability and performance suites passed. Packaged and installed the VSIX; installed parser and overlay hashes match the workspace build.
- Skill feedback/manual divergence review: the implementation route and focused gates fit this software UI change. The operation review reported no repeated checks or pending validation and produced no new skill proposal. Factory port selections remain inspect/copy context; component geometry is the work-order target.
## 2026-09-30 EDA review and continued optimization (TASK-17)

- Preserved the preexisting feature set in commit a92d581 before further edits. Added KLayout-style F2 fit and KiCad-style E properties, retained Tab, and protected text fields/modifier combinations. Browser checks cover navigation, 1400/800/500-pixel layouts and properties workflows.
- Sidebar queries share bounded discovery and cached nodes; generation checks reject stale cache writes and failed loads remain retryable. Coordinate status reduces a 201-event burst to one DOM write with the exact latest displayed point and mouse-leave clearing. These are operation-count results, not a universal FPS claim.
- Concept validation exposed an existing low-resolution three-marker fixture with a competing correspondence (margin 0.01955 below 0.025). Retained its explicit rejection and added a separately defined double-resolution, 80-pixel-pad positive with exact IDs, independent transform and boundary checks. Production alignment and thresholds remain unchanged; real-image, nonmarker-invariance and occlusion checks pass.
- Project component previews failed when the provenance fork compared a C-drive project with the D-drive extension. Factory execution now uses the project root with scoped provenance bridge handling and restoration. Project preview, provider trust/isolation, cache, chooser and generated-reference checks pass; upstream compatibility is covered separately.
- Packaged and installed logs/gds-navigator-latest.vsix. Installed extension bundle, viewer, workbench and Python bridge hashes match the source; the manifest matches after excluding VS Code installer metadata. TASK-17 finalization checker passed.
- Skill feedback: implementation, bug diagnosis and verification routes fit this software task. Manual drift review retains proposal/source/port/alignment/work-order concepts. Operation review reports no repeated unchanged checks or new matrix proposals; unavailable timing remains unknown.
## 2026-09-30 Managed optimization pass (TASK-18)

- Used native Backlog target and three child contributions for port projection, inspector behavior and reusable verification; owners, acceptance criteria, evidence returns and finalization are recorded in the task store.
- Reduced port verification to dirty live groups while preserving rigid-pose gates and exact output ordering. Integration repaired reset/conversion handling and replaced global removal arrays with an ordered Map. Browser two-group and lifecycle checks passed.
- Coalesced inspector resize/persistence, skipped same-panel activation work, linked tabs to their panel and restored focus on collapse. Browser burst, keyboard and 1400/800/500 layout checks passed.
- Extracted repeated validation setup into check/run/status with runtime preflight, sequential suites, bounded stage execution, raw logs and versioned results. First Windows PATH launcher failure remains recorded; normalization repair and full release rerun passed. Report: docs/managed-optimization-review.md.
- All eight release stages passed; exact VSIX installed and runtime hashes/manifest verified. Full GDS content hashing, geometry/provenance, port identity, alignment thresholds and work-order concepts remain unchanged.
- Skill feedback/manual divergence review: implementation and workflow-extraction routes fit; native tasks remain the only status store. Operation counts support less repeated work, not universal FPS. No scientific matrix edit is warranted; no additional unrelated optimization is introduced after the release gate.

## 2026-10-01 Component recovery and layer interaction (TASK-19)

- Added independent keyboard-accessible thumbnail recovery with successful cache preservation, timeout/stale-response handling, duplicate-request protection and wrapping toolbar. Twelve failed previews recover in batches of eight then four, preserving the host limit and avoiding placement.
- Indexed loaded GDS by layer. A 3,000-feature browser fixture updates only 1,000 affected features with zero layer-key scans; hidden selections and highlights are cleared, keyboard toggles cannot finish routes, and reload discards old index entries. Exact geometry and source references remain.
- First release browser failure sampled the asynchronous retry request too early; raw run 20261001064729984-1c842ee8 is retained. TASK-19.1.1 records the batching and test-timing repair. Final run 20261001065605089-c595e9f0 passed all eight stages. Report: docs/component-layer-review.md.
- Exact VSIX installed; runtime hashes and manifest verified. Component, provenance, port, alignment and work-order concepts remain covered. Native child results returned before parent completion.
- Skill feedback/manual divergence review: bug, implementation and completion routes fit this bounded software pass. Operation review found no pending validations or unchanged repeated checks, and no new skill proposal. Stage timing is retained; implementation duration and first-result timing remain unknown. Operation counts do not establish universal FPS; no scientific matrix update is warranted.
