# Keyboard and compact editor usability

TASK-20 exercises component browsing and narrow split editors.

The component catalog has one keyboard tab stop. Arrow keys move focus;
Home/End jump to the first/last visible result. Enter/Space choose a component
through the existing preview and placement flow. Moving focus alone does not
request a component preview. Filtering and thumbnail responses retain a usable
focus target.

At widths up to 480 px, the header wraps across the available width and the
inspector stacks below the canvas. This preserves the canvas width and keeps the
inspector close button and scrollable controls within the editor. Wider editors
retain their side-by-side arrangement.

Browser checks cover 320, 400, 500, 800 and 1400 px layouts, keyboard activation,
filtered results and component placement. Screenshots and reports are saved in
`logs/reliability/eda-workbench` and `logs/reliability/component-catalog`.

The VS Code lifecycle runner accepts `GDS_TEST_VSIX` to install the given package
into its temporary extensions directory. This mode omits the workspace extension
development path, so the journey exercises packaged runtime files. The default
journey checks 1/5/10 open layouts over three isolated windows, drawing, clipboard,
reopening and rebuilding. Its report records the package and installation paths.

These checks cover software interactions and the supplied fixtures; they are not
fabrication or scientific validation.
