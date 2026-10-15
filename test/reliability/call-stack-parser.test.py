#!/usr/bin/env python3
"""Focused contract for compiled call-stack parsing and provenance isolation."""

import importlib.util
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PARSER = ROOT / "python" / "parse_gds.py"


def load_parser():
    spec = importlib.util.spec_from_file_location("parse_gds_call_stack_parser", PARSER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def head_parse(frame):
    """HEAD reference behavior, independent of the implementation under test."""
    match = re.match(r"^(.+?):(\d+)\s+in\s+(.+)$", frame)
    if not match:
        return None
    return {"file": match.group(1), "line": int(match.group(2)), "function": match.group(3)}


class _FakeShape:
    def __init__(self, properties):
        self.properties = properties

    def property(self, key):
        return self.properties.get(key)


class _FakeInst:
    def __init__(self, properties):
        self.properties = properties

    def property(self, key):
        return self.properties.get(key)


class _FakePathEntry:
    def __init__(self, properties):
        self._inst = _FakeInst(properties)

    def inst(self):
        return self._inst


class _FakeCell:
    name = "TOP"


class _FakeIterator:
    def __init__(self, shape_properties, path_properties):
        self._shape = _FakeShape(shape_properties)
        self._path = [_FakePathEntry(path_properties)]

    def shape(self):
        return self._shape

    def path(self):
        return self._path

    def cell(self):
        return _FakeCell()


class CallStackParserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.parser = load_parser()

    def test_head_formats_and_malformed_values_match_reference(self):
        frames = [
            "user_script.py:10 in make_top",
            "nested:dir/source.py:0012 in f",
            r"C:\\work\\布局.py:7 in 建立",
            "/tmp/a:b/long name.py:99 in <module>",
            "",
            "missing line in f",
            "x.py:-1 in f",
            "x.py:3in f",
            "x.py:3 in ",
            "x.py:not-a-line in f",
            "x.py:3 in f\nextra",
        ]
        for frame in frames:
            with self.subTest(frame=frame):
                self.assertEqual(self.parser._parse_call_stack_string(frame), head_parse(frame))

    def test_nonstring_errors_match_reference(self):
        class UnhashableString(str):
            __hash__ = None

        for frame in (None, [], {}, b"x.py:1 in f"):
            with self.subTest(frame=repr(frame)):
                with self.assertRaises(TypeError) as expected:
                    head_parse(frame)
                with self.assertRaises(TypeError) as actual:
                    self.parser._parse_call_stack_string(frame)
                self.assertEqual(type(actual.exception), type(expected.exception))

        # A str subclass may be unhashable.  Parsing must preserve the ordinary
        # string result without requiring hashability.
        frame = UnhashableString("x.py:1 in f")
        self.assertEqual(self.parser._parse_call_stack_string(frame), head_parse(frame))

    def test_same_frame_uses_each_primary_directory_in_sidecar_builder(self):
        frame = "worker.py:12 in build"
        first = self.parser._build_provenance_from_sidecar(
            {"file": "/project/one/top.py", "line": 1, "call_stack": [frame]}, "TOP"
        )
        second = self.parser._build_provenance_from_sidecar(
            {"file": "/project/two/top.py", "line": 1, "call_stack": [frame]}, "TOP"
        )
        self.assertEqual(first["call_chain"][1]["file"], "/project/one/worker.py")
        self.assertEqual(second["call_chain"][1]["file"], "/project/two/worker.py")

    def test_same_frame_uses_each_primary_directory_in_placement_rebuild(self):
        frame = "worker.py:12 in build"

        def provenance_for(placement_id):
            iterator = _FakeIterator(
                {1002: 1},
                {1005: '{"instance_prov_id": %d}' % placement_id},
            )
            return self.parser._get_feature_provenance(
                iterator,
                {},
                {
                    1: {"id": 1, "file": "created.py", "line": 2, "component": "TOP"},
                    placement_id: {
                        "id": placement_id,
                        "file": "/project/%d/top.py" % placement_id,
                        "line": 3,
                        "call_stack": [frame],
                    },
                },
            )

        first = provenance_for(10)
        second = provenance_for(20)
        self.assertEqual(first["call_chain"][1]["file"], "/project/10/worker.py")
        self.assertEqual(second["call_chain"][1]["file"], "/project/20/worker.py")

    def test_results_are_fresh_maps(self):
        parser = self.parser
        frame = "unicode-布局.py:8 in 建立"
        first = parser._parse_call_stack_string(frame)
        first["file"] = "mutated.py"
        second = parser._parse_call_stack_string(frame)
        self.assertEqual(second, {"file": "unicode-布局.py", "line": 8, "function": "建立"})
        self.assertIsNot(first, second)

    def test_repeated_sidecar_builder_calls_reflect_new_metadata(self):
        frame = "worker.py:12 in build"
        first = self.parser._build_provenance_from_sidecar(
            {"file": "/project/top.py", "line": 1, "function": "old", "call_stack": [frame]}, "TOP"
        )
        second = self.parser._build_provenance_from_sidecar(
            {"file": "/project/top.py", "line": 99, "function": "new", "call_stack": [frame]}, "TOP"
        )
        self.assertEqual(first["line"], 1)
        self.assertEqual(second["line"], 99)
        self.assertEqual(first["function"], "old")
        self.assertEqual(second["function"], "new")
        self.assertEqual(first["call_chain"][1], second["call_chain"][1])


if __name__ == "__main__":
    unittest.main()
