# Alignment experiments

The `debug-*.js`, `probe-*.js`, and `measure-pad.js` files preserve exploratory
diagnostics used while developing microscope alignment. They are outside
`npm test` and may assume local fixture paths, fixed localhost ports, or a
specific Edge installation. Results belong in `logs/` or `test/alignment/out/`.

The `patch-*.js` files are historical one-shot source patchers. They can edit
`webview/viewer.html`; inspect their anchors and the current source before
running them. They are retained for development history, not build steps.

Use the `*.test.js` files and `npm run test:alignment` for regression checks.
