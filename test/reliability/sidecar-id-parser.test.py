#!/usr/bin/env python3
"""Regression contract for canonical, unambiguous sidecar provenance IDs."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
import importlib.util
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


def write_layout(directory: Path, entries, *, placement=False):
    """Write a deterministic KLayout fixture and its adjacent sidecar."""
    gds = directory / "chip.gds"
    layout = kdb.Layout()
    layout.dbu = 0.001
    top = layout.create_cell("TOP")
    child = layout.create_cell("CHILD") if placement else None
    layer = layout.layer(1, 0)

    first = top.shapes(layer).insert(kdb.Box(0, 0, 1000, 1000))
    first.set_property(1002, 0)

    second = top.shapes(layer).insert(kdb.Box(2000, 0, 3000, 1000))
    second.set_property(1002, 7)
    if placement:
        second.set_property(1004, json.dumps({"instance_prov_id": "8", "file": "shape_inline.py", "line": 801}))

    if placement:
        child_shape = child.shapes(layer).insert(kdb.Box(4000, 0, 5000, 1000))
        child_shape.set_property(1002, 7)
        instance = top.insert(kdb.CellInstArray(child.cell_index(), kdb.Trans(0, 0)))
        instance.set_property(1005, json.dumps({"instance_prov_id": "9", "file": "instance_inline.py", "line": 901}))

    layout.write(str(gds))
    (directory / "chip.provenance.json").write_text(
        json.dumps({"version": 1, "entries": entries, "ports": {}, "ref_names": {}}, sort_keys=True),
        encoding="utf-8",
    )
    return gds


def parse(gds: Path):
    return json.loads(
        subprocess.check_output(
            [str(parser_python()), str(PARSER), str(gds)],
            cwd=ROOT,
            text=True,
        )
    )


def source_entry(identifier, name, line, **extra):
    return {"id": identifier, "file": f"{name}.py", "line": line, "function": "build", "component": "TOP", **extra}


def feature_by_x(result, x):
    for feature in result["features"]:
        if feature["properties"]["bbox"][0] == x:
            return feature
    raise AssertionError(f"no feature at x={x}: {result['features']}")


class SidecarIdParserTest(unittest.TestCase):
    def test_integer_and_canonical_string_ids_are_exactly_equivalent(self):
        entries_int = [source_entry(0, "zero", 10), source_entry(7, "seven", 20), source_entry(-3, "negative", 30)]
        entries_str = [source_entry(" 000 ", "zero", 10), source_entry("+007", "seven", 20), source_entry("-003", "negative", 30)]
        with tempfile.TemporaryDirectory() as temp:
            integer_dir = Path(temp) / "integer"
            string_dir = Path(temp) / "string"
            integer_dir.mkdir()
            string_dir.mkdir()
            integer = parse(write_layout(integer_dir, entries_int))
            strings = parse(write_layout(string_dir, entries_str))
        self.assertEqual(strings, integer)
        self.assertEqual(integer["_diag"]["sidecar_warnings"], [])
        self.assertEqual([f["properties"]["provenance"]["file"] for f in integer["features"]], ["zero.py", "seven.py"])

    def test_shape_and_instance_placement_string_ids_resolve_consistently(self):
        entries = [
            source_entry("0", "zero", 10),
            source_entry("7", "creation", 20),
            source_entry("8", "shape_placement", 80, loop_index=["shape", 8]),
            source_entry("9", "instance_placement", 90, loop_index=["instance", 9]),
        ]
        with tempfile.TemporaryDirectory() as temp:
            result = parse(write_layout(Path(temp), entries, placement=True))
        shape = feature_by_x(result, 2.0)
        child = feature_by_x(result, 4.0)
        self.assertEqual(shape["properties"]["provenance"]["file"], "shape_inline.py")
        self.assertEqual(shape["properties"]["provenance"]["line"], 801)
        self.assertEqual(shape["properties"]["provenance"]["placement_line"], 801)
        self.assertEqual(shape["properties"]["provenance"]["loop_index"], ["shape", 8])
        self.assertEqual(child["properties"]["provenance"]["file"], "instance_inline.py")
        self.assertEqual(child["properties"]["provenance"]["line"], 901)
        self.assertEqual(child["properties"]["provenance"]["placement_line"], 901)
        self.assertEqual(child["properties"]["provenance"]["loop_index"], ["instance", 9])
        self.assertEqual(result["_diag"]["sidecar_warnings"], [])

    def test_unknown_entry_fields_survive_id_normalization(self):
        with tempfile.TemporaryDirectory() as temp:
            gds = write_layout(Path(temp), [source_entry("007", "seven", 20, retained_field={"keep": True})])
            spec = importlib.util.spec_from_file_location("parse_gds_for_id_test", PARSER)
            parser = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(parser)
            entries, _, _, warnings = parser._load_sidecar(str(gds))
        self.assertEqual(warnings, [])
        self.assertEqual(entries[7]["retained_field"], {"keep": True})

    def test_canonical_duplicate_ids_are_omitted_in_either_order_and_repeats(self):
        cases = [
            [source_entry("7", "string_first", 70), source_entry(7, "int_second", 71), source_entry(0, "zero", 10)],
            [source_entry(7, "int_first", 70), source_entry("007", "string_second", 71), source_entry(0, "zero", 10)],
            [source_entry("7", "first", 70), source_entry("+7", "second", 71), source_entry(7, "third", 72), source_entry(0, "zero", 10)],
        ]
        for entries in cases:
            with self.subTest(ids=[entry["id"] for entry in entries]):
                with tempfile.TemporaryDirectory() as temp:
                    result = parse(write_layout(Path(temp), entries))
                zero = feature_by_x(result, 0.0)
                seven = feature_by_x(result, 2.0)
                self.assertEqual(zero["properties"]["provenance"]["file"], "zero.py")
                self.assertNotIn("file", seven["properties"].get("provenance", {}))
                self.assertTrue(any("duplicate" in warning.lower() for warning in result["_diag"]["sidecar_warnings"]))

    def test_zero_alias_collision_is_omitted_while_unique_id_resolves(self):
        entries = [
            source_entry(0, "zero_int", 10),
            source_entry("-0", "zero_negative_alias", 11),
            source_entry("000", "zero_padded_alias", 12),
            source_entry(7, "seven", 20),
        ]
        with tempfile.TemporaryDirectory() as temp:
            result = parse(write_layout(Path(temp), entries))
        zero = feature_by_x(result, 0.0)
        seven = feature_by_x(result, 2.0)
        self.assertNotIn("file", zero["properties"].get("provenance", {}))
        self.assertEqual(seven["properties"]["provenance"]["file"], "seven.py")
        self.assertTrue(any("duplicate" in warning.lower() and "0" in warning for warning in result["_diag"]["sidecar_warnings"]))

    def test_invalid_ids_are_rejected_with_warnings(self):
        invalid = [True, False, 7.0, "", "7.5", "abc"]
        with tempfile.TemporaryDirectory() as temp:
            result = parse(write_layout(Path(temp), [source_entry(value, f"invalid_{index}", 100 + index) for index, value in enumerate(invalid)]))
        self.assertEqual(len(result["features"]), 2)
        for feature in result["features"]:
            self.assertNotIn("file", feature["properties"].get("provenance", {}))
        warnings = result["_diag"]["sidecar_warnings"]
        self.assertGreaterEqual(len(warnings), len(invalid))
        self.assertTrue(all("sidecar" in warning.lower() for warning in warnings))


if __name__ == "__main__":
    unittest.main()
