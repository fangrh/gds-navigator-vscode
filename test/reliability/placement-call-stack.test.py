#!/usr/bin/env python3
"""Regression contract for malformed placement call_stack metadata."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import klayout.db as kdb


ROOT = Path(__file__).resolve().parents[2]
PARSER = ROOT / "python" / "parse_gds.py"


def parser_python():
    for name in ("GDS_TEST_PYTHON", "GDS_PYTHON"):
        value = os.environ.get(name, "").strip()
        if value:
            return Path(value)
    return Path(sys.executable)


def write_layout(directory: Path, placement_property: int, call_stack, *, placement_file="/project/placement.py"):
    """Write a real KLayout layout and one malformed placement sidecar."""
    gds = directory / "placement.gds"
    layout = kdb.Layout()
    layout.dbu = 0.001
    top = layout.create_cell("TOP")
    child = layout.create_cell("CHILD") if placement_property == 1005 else None
    layer = layout.layer(1, 0)

    created = top.shapes(layer).insert(kdb.Box(0, 0, 1000, 1000))
    created.set_property(1002, 7)

    placement_id = 8 if placement_property == 1004 else 9
    if isinstance(call_stack, list):
        call_stack = [
            f"{directory / 'absolute.py'}:35 in absolute" if frame == "/absolute.py:35 in absolute" else frame
            for frame in call_stack
        ]
    placement = {
        "id": placement_id,
        "file": placement_file,
        "line": 808 if placement_property == 1004 else 909,
        "function": "place_component",
        "component": "TOP",
        "loop_index": ["placement", placement_id],
        "variable_name": "component_ref",
        "call_stack": call_stack,
    }

    if placement_property == 1004:
        placed = top.shapes(layer).insert(kdb.Box(2000, 0, 3000, 1000))
        placed.set_property(1002, 7)
        placed.set_property(1004, json.dumps({
            "instance_prov_id": placement_id,
            "file": "inline_shape.py",
            "line": 1804,
            "source_text": "top.add_ref(component)",
        }))
    else:
        child_shape = child.shapes(layer).insert(kdb.Box(4000, 0, 5000, 1000))
        child_shape.set_property(1002, 7)
        instance = top.insert(kdb.CellInstArray(child.cell_index(), kdb.Trans(0, 0)))
        instance.set_property(1005, json.dumps({
            "instance_prov_id": placement_id,
            "file": "inline_instance.py",
            "line": 1905,
            "source_text": "top.add_ref(component)",
        }))

    layout.write(str(gds))
    entries = [
        {
            "id": 7,
            "file": str(directory / "project" / "creation.py"),
            "line": 707,
            "function": "build_component",
            "component": "TOP",
            "call_stack": ["factory.py:12 in make_component"],
        },
        placement,
    ]
    (directory / "placement.provenance.json").write_text(
        json.dumps({"version": 1, "entries": entries, "ports": {}, "ref_names": {}}, sort_keys=True),
        encoding="utf-8",
    )
    return gds


def parse_cli(gds: Path):
    completed = subprocess.run(
        [str(parser_python()), str(PARSER), str(gds)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode:
        raise AssertionError(
            f"parse_gds CLI failed with {completed.returncode}: "
            f"{completed.stdout.strip() or completed.stderr.strip()}"
        )
    return json.loads(completed.stdout)


def feature_at_x(result, x):
    for feature in result["features"]:
        if feature["properties"]["bbox"][0] == x:
            return feature
    raise AssertionError(f"no feature at x={x}: {result['features']}")


class PlacementCallStackTest(unittest.TestCase):
    CASES = (
        ("null", None),
        ("scalar-string", "factory.py:12 in make_component"),
        ("nonlist-number", 123),
        ("nonlist-dict", {"bad": True}),
        ("mixed-list", [None, {}, True, ["bad"], "worker.py:34 in place_component", "/absolute.py:35 in absolute", 42]),
    )

    def assert_placement_metadata(self, result, placement_property, expected_primary, expected_chain):
        x = 2.0 if placement_property == 1004 else 4.0
        feature = feature_at_x(result, x)
        properties = feature["properties"]
        provenance = properties["provenance"]
        self.assertEqual(properties["bbox"][2:], [x + 1.0, 1.0])
        self.assertEqual(provenance["file"], "inline_shape.py" if placement_property == 1004 else "inline_instance.py")
        self.assertEqual(provenance["line"], 1804 if placement_property == 1004 else 1905)
        self.assertEqual(provenance["placement_line"], provenance["line"])
        self.assertEqual(provenance["source_text"], "top.add_ref(component)")
        self.assertEqual(provenance["loop_index"], ["placement", 8 if placement_property == 1004 else 9])
        self.assertEqual(provenance["variable_name"], "component_ref")
        self.assertEqual(provenance["call_chain"], expected_chain)
        self.assertEqual(provenance["call_chain"][0], {
            "file": expected_primary,
            "line": 808 if placement_property == 1004 else 909,
            "function": "place_component",
        })

    def test_malformed_placement_call_stack_preserves_both_placement_encodings(self):
        for label, call_stack in self.CASES:
            for placement_property in (1004, 1005):
                with self.subTest(case=label, placement_property=placement_property):
                    with tempfile.TemporaryDirectory() as temp:
                        directory = Path(temp)
                        primary = str(directory / "project" / "placement.py")
                        relative = str(directory / "project" / "worker.py")
                        absolute = str(directory / "absolute.py")
                        primary_chain = [{
                            "file": primary,
                            "line": 808 if placement_property == 1004 else 909,
                            "function": "place_component",
                        }]
                        expected_chain = primary_chain + ([
                            {"file": relative, "line": 34, "function": "place_component"},
                            {"file": absolute, "line": 35, "function": "absolute"},
                        ] if label == "mixed-list" else [])
                        result = parse_cli(write_layout(directory, placement_property, call_stack, placement_file=primary))
                    self.assertEqual(result["type"], "FeatureCollection")
                    self.assertEqual(len(result["features"]), 2)
                    self.assert_placement_metadata(result, placement_property, primary, expected_chain)

    def test_malformed_placement_file_keeps_inline_source_and_call_frames(self):
        for placement_property in (1004, 1005):
            with self.subTest(placement_property=placement_property):
                with tempfile.TemporaryDirectory() as temp:
                    gds = write_layout(
                        Path(temp),
                        placement_property,
                        ["worker.py:34 in place_component", "/absolute.py:35 in absolute"],
                        placement_file=123,
                    )
                    result = parse_cli(gds)
                self.assertEqual(len(result["features"]), 2)
                x = 2.0 if placement_property == 1004 else 4.0
                provenance = feature_at_x(result, x)["properties"]["provenance"]
                self.assertEqual(provenance["file"], "inline_shape.py" if placement_property == 1004 else "inline_instance.py")
                self.assertEqual(provenance["source_text"], "top.add_ref(component)")
                self.assertEqual(provenance["call_chain"][0]["file"], "")
                self.assertEqual(provenance["call_chain"], [
                    {"file": "", "line": 808 if placement_property == 1004 else 909, "function": "place_component"},
                    {"file": "worker.py", "line": 34, "function": "place_component"},
                    {"file": str(Path(temp) / "absolute.py"), "line": 35, "function": "absolute"},
                ])


if __name__ == "__main__":
    unittest.main()
