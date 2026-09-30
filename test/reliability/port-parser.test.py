"""Focused parser contract for normalized sidecar ports."""
import importlib.util
import json
import math
import os
import tempfile
import unittest

try:
    import klayout.db as kdb
except ImportError:  # pragma: no cover - reported as skipped by unittest
    kdb = None


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
PARSER_PATH = os.path.join(ROOT, "python", "parse_gds.py")


def load_parser():
    spec = importlib.util.spec_from_file_location("gds_navigator_parse_gds", PARSER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(kdb is not None, "klayout is unavailable")
class PortParserTests(unittest.TestCase):
    def make_layout(self, directory):
        layout = kdb.Layout()
        layout.dbu = 0.001
        top = layout.create_cell("TOP")
        component = layout.create_cell("COMP")
        polygon_layer = layout.layer(1, 0)
        provenance_layer = layout.layer(255, 255)
        component.shapes(polygon_layer).insert(kdb.Box(0, 0, 1000, 500))
        component.shapes(polygon_layer).insert(kdb.Box(1500, 0, 2500, 500))
        component.shapes(provenance_layer).insert(kdb.Text(json.dumps({"cell": "COMP", "component": "COMP"}), kdb.Trans(0, 0)))
        top.insert(kdb.CellInstArray(component.cell_index(), kdb.Trans(kdb.Trans.R90, kdb.Vector(10000, 20000))))
        gds_path = os.path.join(directory, "ports.gds")
        layout.write(gds_path)
        with open(os.path.join(directory, "ports.provenance.json"), "w", encoding="utf-8") as stream:
            json.dump({"entries": [], "ports": {"COMP": [{"name": "in", "center": [0, 0.25], "width": 0.5, "orientation": 0, "layer": [1, 0]}]}}, stream)
        return gds_path

    def test_transforms_and_deduplicates_ports(self):
        parser = load_parser()
        with tempfile.TemporaryDirectory(prefix="gds-port-parser-") as directory:
            result = parser.parse_gds(self.make_layout(directory))
        self.assertEqual(len(result["ports"]), 1)
        port = result["ports"][0]
        self.assertEqual(port["name"], "in")
        self.assertEqual(port["coordinate_frame"], "layout")
        self.assertEqual(port["source_center"], [0, 0.25])
        self.assertEqual(port["layer"], [1, 0])
        self.assertAlmostEqual(port["center"][0], 9.75, places=6)
        self.assertAlmostEqual(port["center"][1], 20.0, places=6)
        self.assertAlmostEqual(port["orientation"], 90.0, places=6)
        self.assertEqual(port["provenance"]["cell"], "COMP")
        self.assertTrue(math.isfinite(port["center"][0]))

    def test_malformed_port_is_rejected_with_warning(self):
        parser = load_parser()
        with tempfile.TemporaryDirectory(prefix="gds-port-parser-") as directory:
            gds_path = self.make_layout(directory)
            sidecar = os.path.join(directory, "ports.provenance.json")
            with open(sidecar, "w", encoding="utf-8") as stream:
                json.dump({"entries": [], "ports": {"COMP": [{"name": "bad", "center": ["nan", 0], "width": 1, "orientation": 0, "layer": [1, 0]}]}}, stream)
            result = parser.parse_gds(gds_path)
        self.assertEqual(result["ports"], [])
        self.assertTrue(any("port COMP[0] is malformed" in warning for warning in result["_diag"]["sidecar_warnings"]))


if __name__ == "__main__":
    unittest.main()
