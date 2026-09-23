# 50 µm JJ pad starter template

`jj_pad_center_50_test.gds` is a byte-for-byte copy of
`test/fixtures/jj_pad_center_50_test.gds`, the user's requested marker layout.
`generate_jj_pad_center_50.py` is adapted from the matching user generator.
Its default output goes to the new project's `layouts/` folder. The three
layer-4 JJ polygons are positioned to match this GDS fixture; the original
generator placed them 250 µm lower. Numbered marker polygons on layers 1, 8,
and 9 are unchanged.

The script supports `--out` and `--plain`. A normal build uses gdsfactory and
can provide source provenance when run with the compatible fork. The bundled
GDS is immediately viewable without rebuilding it.
