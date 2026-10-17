"""Regression contract for parser collection and per-feature bounds.

The collection bbox must retain the unrounded coordinates emitted by geometry,
while each feature's display metadata remains rounded to six decimal places.
"""
import importlib.util
import math
import os
import tempfile
import unittest

import klayout.db as kdb


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
PARSER_PATH = os.path.abspath(os.environ.get("GDS_PARSER_UNDER_TEST", os.path.join(ROOT, "python", "parse_gds.py")))


def load_parser():
    spec = importlib.util.spec_from_file_location("gds_navigator_parse_gds_bounds", PARSER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def coordinate_points(geometry):
    """Yield every coordinate pair from a GeoJSON geometry."""
    stack = [geometry.get("coordinates", [])]
    while stack:
        value = stack.pop()
        if isinstance(value, (list, tuple)) and len(value) == 2 and all(isinstance(x, (int, float)) for x in value):
            yield value
        elif isinstance(value, (list, tuple)):
            stack.extend(reversed(value))


class ParserBoundsTests(unittest.TestCase):
    def make_layout(self, directory):
        layout = kdb.Layout()
        # Native database units are deliberately finer than six decimal um.
        layout.dbu = 1e-7
        top = layout.create_cell("TOP")
        child = layout.create_cell("CHILD")
        intermediate = layout.create_cell("INTERMEDIATE")
        layer_box = layout.layer(1, 0)
        layer_polygon = layout.layer(2, 3)
        layer_path = layout.layer(7, 1)
        layer_unsupported = layout.layer(9, 9)

        # Explicit high-precision negative extrema: -0.1234567 and -0.7654321.
        top.shapes(layer_box).insert(kdb.Box(-1234567, -7654321, -1234501, -7654200))
        top.shapes(layer_polygon).insert(kdb.Polygon([
            kdb.Point(2345678, 1000000), kdb.Point(3345678, 1000000),
            kdb.Point(3345678, 2123456), kdb.Point(2345678, 1000000)
        ]))
        # A path exercises parser conversion to a polygon on another layer.
        child.shapes(layer_polygon).insert(kdb.Polygon([
            kdb.Point(-800000, 300000), kdb.Point(200000, 300000),
            kdb.Point(200000, 900000), kdb.Point(-800000, 300000)
        ]))
        child.shapes(layer_path).insert(kdb.Path([
            kdb.Point(0, 0), kdb.Point(1000000, 0), kdb.Point(1000000, 500000)
        ], 200000))
        # Nested reflected/rotated instance, then a 2x2 array of that instance.
        intermediate.insert(kdb.CellInstArray(child.cell_index(), kdb.Trans(kdb.Trans.M90, kdb.Vector(5000000, -2000000))))
        intermediate_a = kdb.Vector(3000000, 0)
        intermediate_b = kdb.Vector(0, 4000000)
        top.insert(kdb.CellInstArray(intermediate.cell_index(), kdb.Trans(0, 0), intermediate_a, intermediate_b, 2, 2))
        # Text is unsupported geometry and must not become a polygon feature.
        top.shapes(layer_unsupported).insert(kdb.Text("unsupported", kdb.Trans(0, 0)))

        path = os.path.join(directory, "bounds.gds")
        layout.write(path)
        return path

    def test_unrounded_collection_bbox_and_rounded_feature_metadata(self):
        parser = load_parser()
        with tempfile.TemporaryDirectory(prefix="gds-parser-bounds-") as directory:
            result = parser.parse_gds(self.make_layout(directory))

        self.assertEqual(len(result["features"]), 10, "top shapes plus two nested shapes in a 2x2 array")
        all_points = [point for feature in result["features"] for point in coordinate_points(feature["geometry"])]
        expected = [min(p[0] for p in all_points), min(p[1] for p in all_points),
                    max(p[0] for p in all_points), max(p[1] for p in all_points)]
        self.assertEqual(result["bbox"], expected)
        # This explicit scalar catches reuse of a six-decimal rounded bbox.
        self.assertAlmostEqual(result["bbox"][0], -0.1234567, places=12)
        self.assertNotEqual(result["bbox"][0], round(result["bbox"][0], 6))
        self.assertAlmostEqual(result["bbox"][1], -0.7654321, places=12)

        layers = set()
        for feature in result["features"]:
            layers.add((feature["properties"]["layer"], feature["properties"]["data_type"]))
            points = list(coordinate_points(feature["geometry"]))
            raw = [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)]
            self.assertEqual(feature["properties"]["bbox"], [round(value, 6) for value in raw])
            self.assertTrue(math.isfinite(feature["properties"]["area_um2"]))
            self.assertGreaterEqual(feature["properties"]["vertex_count"], 3)
        self.assertTrue({(1, 0), (2, 3), (7, 1)}.issubset(layers))
        self.assertEqual(sum(1 for f in result["features"] if (f["properties"]["layer"], f["properties"]["data_type"]) == (2, 3)), 5)
        self.assertEqual(sum(1 for f in result["features"] if (f["properties"]["layer"], f["properties"]["data_type"]) == (7, 1)), 4)
        self.assertNotIn((9, 9), layers)

    def test_empty_layout_has_no_collection_bbox(self):
        parser = load_parser()
        with tempfile.TemporaryDirectory(prefix="gds-parser-empty-") as directory:
            layout = kdb.Layout()
            layout.dbu = 1e-7
            layout.create_cell("TOP")
            path = os.path.join(directory, "empty.gds")
            layout.write(path)
            result = parser.parse_gds(path)
        self.assertEqual(result["features"], [])
        self.assertNotIn("bbox", result)
        self.assertEqual(result["ports"], [])


if __name__ == "__main__":
    unittest.main()
