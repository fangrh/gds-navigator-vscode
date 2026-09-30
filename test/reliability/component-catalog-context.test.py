#!/usr/bin/env python3
"""Cheap lifecycle coverage for the optional project-factory context."""
import os
from pathlib import Path
import sys
import tempfile
import types

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from python.component_catalog import _factory_working_directory


def main():
    before = os.getcwd()
    original_package = sys.modules.get("gdsfactory")
    original_provenance = sys.modules.get("gdsfactory.provenance_inject")
    try:
        package = types.ModuleType("gdsfactory")
        package.__path__ = []
        provenance = types.ModuleType("gdsfactory.provenance_inject")
        provenance._PROJECT_ROOT = "old-root"
        provenance._is_internal = lambda filepath: False
        sys.modules["gdsfactory"] = package
        sys.modules["gdsfactory.provenance_inject"] = provenance
        with tempfile.TemporaryDirectory() as project:
            with _factory_working_directory("project", project):
                assert Path.cwd() == Path(project).resolve()
                assert provenance._PROJECT_ROOT == str(Path(project).resolve())
                assert provenance._is_internal(str(ROOT / "python" / "component_catalog.py"))
            assert Path.cwd() == Path(before).resolve()
        missing = Path(tempfile.gettempdir()) / "gds-catalog-context-missing"
        try:
            with _factory_working_directory("project", missing):
                raise AssertionError("missing project root unexpectedly entered")
        except FileNotFoundError:
            pass
        assert Path.cwd() == Path(before).resolve()
        assert provenance._PROJECT_ROOT == "old-root"
        assert provenance._is_internal("user.py") is False

        # An upstream-style package without the optional module remains valid.
        sys.modules.pop("gdsfactory.provenance_inject")
        with tempfile.TemporaryDirectory() as project:
            with _factory_working_directory("project", project):
                assert Path.cwd() == Path(project).resolve()
            assert Path.cwd() == Path(before).resolve()
    finally:
        if original_package is None:
            sys.modules.pop("gdsfactory", None)
        else:
            sys.modules["gdsfactory"] = original_package
        if original_provenance is None:
            sys.modules.pop("gdsfactory.provenance_inject", None)
        else:
            sys.modules["gdsfactory.provenance_inject"] = original_provenance
    print("component catalog context lifecycle passed")


if __name__ == "__main__":
    main()
