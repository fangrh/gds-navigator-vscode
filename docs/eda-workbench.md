# EDA-style viewer workbench

The redesign borrows established layout patterns rather than copying another product's branding or claiming its editing capabilities.

| Reference | Documented convention | GDS Navigator implementation |
|---|---|---|
| [KLayout main window](https://www.klayout.org/downloads/master/doc-qt5/manual/main_window.html) | Central canvas with separate navigation/layer controls and rearrangeable panels | Dedicated layer sidebar, unobscured center canvas and collapsible right inspector |
| [KiCad PCB editor](https://docs.kicad.org/9.0/en/pcbnew/pcbnew.html#the-pcb-editor-user-interface) | Top file/view tools, right drawing tools, appearance panel and status bar | Top build/zoom/copy toolbar; existing right drawing tools; Images/Properties/Components/Work orders inspector tabs; coordinate and selection status |
| [Ansys Electronics Desktop](https://ansyshelp.ansys.com/public/views/secured/electronics/v251/en/subsystems/maxwell/content/GettingStarted/TheANSYSElectronicsDesktop.htm) | Main design area surrounded by context-dependent windows and toolbars | Contextual property panels remain outside the canvas and share one dock |

## Everyday use

- Open Python, Related files and Usage remain at the top. Shapes stay in the right tool rail, including the searchable component chooser.
- Images, shape properties, Manhattan route properties and queued Work orders use the inspector instead of floating over the layout. Existing operations and exact geometry are unchanged.
- Press Tab on a selected object to inspect it; Tab also reopens Properties after switching inspector tabs. Inspector tabs support arrow keys, Home and End.
- Layers and Inspector buttons collapse their panels. Reset UI restores defaults. Panel choices are stored in the VS Code webview state without modifying GDS/image placement.
- The instruction composer stays at the bottom. It wraps and scrolls in narrow editors. Narrow windows prioritize the canvas; opening Layers hides the inspector when necessary.
- Existing VS Code theme colors style the workbench; GDS layer colors remain unchanged. Coordinate readout uses micrometres.

This pass does not introduce cell-hierarchy editing, a DRC engine, connectivity-aware routing or arbitrary floating/resizable dock windows. It reorganizes the supported viewer, image and proposal workflows.

## Work-order interaction references

The work-order UI follows established issue-management conventions, adapted to a local GDS editor:

| Reference | Adopted pattern |
|---|---|
| [Linear filters](https://linear.app/docs/filters) | Immediate status filtering inside a scoped list |
| [Linear search](https://linear.app/docs/search) | Find work by stable identifier and requirement text |
| [Linear custom views](https://linear.app/docs/custom-views) | Make the list scope visible; here each GDS is an independent queue |
| [Jira work items](https://www.atlassian.com/software/jira/guides/issues/overview) | Treat a request as a durable item with status and supporting context |

The bottom composer shows the GDS and selected targets before submission. The right **Work orders** inspector prioritizes the requirement, next reference and status; exact geometry and activity history are expandable. **Copy ref** carries lookup instructions for the AI agent. **Undo changes** appears only with completed source receipts; otherwise the action is explicitly **Withdraw proposal**. These are interface precedents, not claims of feature parity or integration with those products.

## Canvas context menu conventions

The right-click menu follows the [KiCad 9 PCB Editor context-menu convention](https://docs.kicad.org/9.0/en/pcbnew/pcbnew.html): available actions depend on the selection and active tool. Properties, selection operations and view actions reuse the same commands as the toolbar. This is a workflow reference, not PCB routing or connectivity support.

[KLayout's documented mouse interaction](https://www.klayout.de/forum/discussion/2841/confusion-about-mouse-button-pressed-event-vs-mouse-button-released-event-vs-mouse-moved-event) uses the right button for zoom-box interaction; this viewer intentionally chooses a context menu instead. GDS geometry remains inspected and changed through work orders, while local proposal drawings use their existing editing operations. Image placement remains separate from marker registration.

Right-clicking a selected object preserves the current multi-selection; clicking another object targets that object. Keyboard access uses Shift+F10, arrow keys and Enter; Escape dismisses the menu. Text-entry fields keep their normal editing menu.

## Validation commands

## Review tools and action placement

The main context menu keeps frequent object actions visible. **Select / view** opens overlap choice, similar selection, temporary layer isolation and fit actions. **Review / work orders** opens change-request drafting, measurement, annotated capture and bookmarks. The new **Review** inspector tab holds settings and results; **Related work orders** filters the existing Work orders tab and offers **Show all work orders** to remove the filter.

- Overlap choices highlight the hovered candidate before explicit selection. Similar selection previews only visible GDS elements and requires explicit criteria and an Apply action. Dimensions are axis-aligned bounding dimensions, not geometric equivalence.
- Measurements use two picked GDS coordinates in micrometres, with signed X/Y separation and counter-clockwise angle. They are measurements of the displayed coordinates, not calibrated microscope metrology. Measurements from an older GDS hash are labelled accordingly.
- Bookmarks save view center, resolution, rotation and visible layers. Names can be edited in the sidebar. Bookmarks and measurements belong to the exact GDS path and persist with project review state.
- Build comparison uses the preceding successfully stored, different-hash parsed GDS snapshot. The first visit has no previous snapshot. Exact geometry/layer matches ignore element ordinals and polygon ring starting point/winding; a unique source instance can pair changed geometry. Ambiguous changes remain added/removed. Red is previous geometry; green/yellow is current. Snapshots are local, bounded to 15 MB, and are not source-control history or a GDS undo mechanism.
- Annotated capture saves the canvas PNG and exact selected context in a YAML companion, then copies context for the user's agent. It does not contact an agent. Numbered markers identify the selected elements; unselected visible geometry is background context. Image display and placement controls remain in Images; the context menu shares the placement-lock state.
- Change requests populate the existing bottom composer. They remain drafts until the user adds the work order; they never directly modify Python or GDS.

`npm run test:review` checks review algorithms, persistence, provider export and rendered review interactions. The real VS Code work-orders journey also verifies bookmark persistence and comparison after an actual Python rebuild.

`node test/reliability/eda-workbench.test.js` exercises desktop/compact layouts, docking, tabs, keyboard properties, collapsing and reset, with screenshots in `logs/reliability/eda-workbench`. Existing shape/route/image workflow checks guard unchanged operations. `npm run test:usage:vscode` checks the extension in an isolated real VS Code profile.

Work-order checks: `npm run test:work-orders` covers the queue, host and rendered browser controls; `npm run test:work-orders:vscode` exercises an isolated two-GDS VS Code journey and writes screenshots under `logs/reliability/work-orders-vscode`.
