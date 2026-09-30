"""Bounded, introspection-only bridge for the installed gdsfactory fork.

The catalog path never calls a factory. Preview accepts only a cataloged name and
JSON settings, creates that one component in this subprocess, and sends its GDS
through the repository parser before removing the temporary directory.
"""
from __future__ import annotations

import argparse
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any
import contextlib
import re

MAX_CATALOG = 16_000
MAX_JSON = 32 * 1024 * 1024
PARSE_TIMEOUT = 20
MAX_THUMBNAIL_NAMES = 8
MAX_THUMBNAIL_FEATURES = 128
MAX_THUMBNAIL_VERTICES = 4096
PROJECT_MODULE = "gds_components"
PROJECT_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
MAX_PROJECT_KEY = 152


@contextlib.contextmanager
def _factory_working_directory(source: str, project_root: str | os.PathLike[str] | None):
    """Keep project factory paths on one drive while gdsfactory builds cells.

    gdsfactory derives diagnostic/cell paths from the current directory. A
    workspace on another Windows drive otherwise raises when it compares the
    project module path with the extension process directory.
    """
    if source != "project" or project_root is None:
        yield
        return
    previous = os.getcwd()
    provenance = None
    previous_root = None
    previous_internal = None
    try:
        os.chdir(Path(project_root).expanduser().resolve())
        # Upstream gdsfactory has no provenance_inject module. The fork's
        # optional hook is used only when its private state API is present.
        try:
            import gdsfactory.provenance_inject as provenance_module
        except ModuleNotFoundError as exc:
            if exc.name != "gdsfactory.provenance_inject":
                raise
        else:
            expected = ("_PROJECT_ROOT", "_is_internal")
            if all(hasattr(provenance_module, name) for name in expected):
                # Ignore this bridge frame so a project on another Windows
                # drive can retain project-file provenance.
                provenance = provenance_module
                previous_root = provenance._PROJECT_ROOT
                previous_internal = provenance._is_internal
                bridge_file = os.path.normcase(os.path.abspath(__file__))
                provenance._PROJECT_ROOT = str(Path(project_root).expanduser().resolve())
                provenance._is_internal = lambda filepath: (
                    previous_internal(filepath)
                    or (filepath and os.path.normcase(os.path.abspath(filepath)) == bridge_file)
                )
        yield
    finally:
        if provenance is not None:
            provenance._PROJECT_ROOT = previous_root
            provenance._is_internal = previous_internal
        os.chdir(previous)


def _json_value(value: Any) -> tuple[bool, Any]:
    if value is None or isinstance(value, (str, bool, int)):
        return True, value
    if isinstance(value, float):
        return (True, value) if value == value and abs(value) != float("inf") else (False, None)
    if isinstance(value, (list, tuple)):
        items = [_json_value(item) for item in value]
        return (all(ok for ok, _ in items), [item for _, item in items])
    if isinstance(value, dict):
        items = {str(k): _json_value(v) for k, v in value.items()}
        return (all(ok for ok, _ in items.values()), {k: item for k, (_, item) in items.items()})
    return False, None


def _type_name(annotation: Any) -> str | None:
    if annotation is inspect.Parameter.empty:
        return None
    if isinstance(annotation, str):
        return annotation[:160]
    try:
        return str(annotation).replace("typing.", "")[:160]
    except Exception:
        return None


def _parameters(factory: Any) -> list[dict[str, Any]]:
    try:
        signature = inspect.signature(factory)
    except (TypeError, ValueError):
        return []
    result: list[dict[str, Any]] = []
    for parameter in signature.parameters.values():
        if parameter.name in {"self", "cls"} or parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
            continue
        item: dict[str, Any] = {"name": parameter.name, "required": parameter.default is parameter.empty}
        type_name = _type_name(parameter.annotation)
        if type_name:
            item["type"] = type_name
        if parameter.default is not parameter.empty:
            ok, default = _json_value(parameter.default)
            if ok:
                item["default"] = default
            else:
                item["defaultRepresentable"] = False
        result.append(item)
    return result


def _description(factory: Any) -> str:
    doc = inspect.getdoc(factory) or ""
    return doc.splitlines()[0][:500] if doc else ""


def _load_project_factories(project_root: str | os.PathLike[str] | None) -> tuple[dict[str, tuple[Any, str, dict[str, Any]]], list[str]]:
    if project_root is None:
        return {}, []
    root = Path(project_root).expanduser().resolve()
    module_path = root / f"{PROJECT_MODULE}.py"
    if not root.is_dir():
        return {}, [f"project component root is not a directory: {root}"]
    if not module_path.is_file():
        return {}, []
    import types
    try:
        sys.path.insert(0, str(root))
        module = types.ModuleType(PROJECT_MODULE)
        module.__file__ = str(module_path)
        module.__package__ = ""
        sys.modules[PROJECT_MODULE] = module
        with contextlib.redirect_stdout(sys.stderr):
            source = module_path.read_text(encoding="utf-8")
            exec(compile(source, str(module_path), "exec"), module.__dict__)
        registry = getattr(module, "COMPONENTS", None)
        if not isinstance(registry, dict):
            raise ValueError("COMPONENTS must be a dict[str, callable]")
        found: dict[str, tuple[Any, str, dict[str, Any]]] = {}
        warnings: list[str] = []
        for key, factory in registry.items():
            if not isinstance(key, str) or not PROJECT_KEY.fullmatch(key) or len(key) > MAX_PROJECT_KEY:
                warnings.append(f"invalid project component key: {key!r}")
                continue
            if not callable(factory) or inspect.isclass(factory):
                warnings.append(f"project component {key!r} is not a callable factory")
                continue
            try:
                inspect.signature(factory)
            except (TypeError, ValueError) as exc:
                warnings.append(f"project component {key!r} has no inspectable signature: {exc}")
                continue
            found[f"project:{key}"] = (factory, "project", {"module": PROJECT_MODULE, "exportName": key})
        return found, warnings
    except Exception as exc:
        return {}, [f"project component registry failed: {exc}"]


def _factories(project_root: str | os.PathLike[str] | None = None) -> tuple[dict[str, tuple[Any, str, dict[str, Any] | None]], list[str]]:
    import gdsfactory as gf

    gf.gpdk.PDK.activate()
    found: dict[str, tuple[Any, str, dict[str, Any] | None]] = {}
    for name in dir(gf.components):
        if name.startswith("_"):
            continue
        factory = getattr(gf.components, name, None)
        if callable(factory) and not inspect.isclass(factory):
            try:
                inspect.signature(factory)
            except (TypeError, ValueError):
                continue
            found[name] = (factory, "components", None)
    for name, factory in gf.get_active_pdk().cells.items():
        if name.startswith("_") or not callable(factory):
            continue
        try:
            inspect.signature(factory)
        except (TypeError, ValueError):
            continue
        found.setdefault(name, (factory, "pdk", None))
    project, warnings = _load_project_factories(project_root)
    for name, entry in project.items():
        if name in found:
            warnings.append(f"project component name collides with built-in: {name}")
        else:
            found[name] = entry
    return found, warnings


def catalog(project_root: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    factories, warnings = _factories(project_root)
    components = []
    for name in sorted(factories):
        factory, source, library = factories[name]
        item = {
            "name": name,
            "description": _description(factory),
            "parameters": _parameters(factory),
            "source": source,
        }
        if library is not None:
            item["category"] = "Project components"
            item["library"] = library
        components.append(item)
        if len(components) >= MAX_CATALOG:
            break
    import gdsfactory as gf
    result = {"components": components, "environment": {
        "python": sys.executable,
        "gdsfactory": getattr(gf, "__version__", None),
        "path": str(Path(gf.__file__).resolve()),
        "activePdk": getattr(gf.get_active_pdk(), "name", None),
    }}
    if warnings:
        result["warnings"] = warnings
    return result


def _parse_gds(gds_path: str) -> dict[str, Any]:
    parser = Path(__file__).with_name("parse_gds.py")
    proc = subprocess.Popen([sys.executable, str(parser), gds_path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        stdout, stderr = proc.communicate(timeout=PARSE_TIMEOUT)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise RuntimeError("component geometry parsing timed out")
    if len(stdout.encode("utf-8")) + len(stderr.encode("utf-8")) > MAX_JSON:
        raise RuntimeError("component geometry output exceeded limit")
    if proc.returncode:
        raise RuntimeError(stderr.strip() or "component geometry parsing failed")
    result = json.loads(stdout)
    if result.get("error"):
        raise RuntimeError(str(result["error"]))
    return result


def _thumbnail_geometry(geojson: dict[str, Any]) -> None:
    """Reject geometry too large for a chooser thumbnail rather than truncating it."""
    features = geojson.get("features")
    if not isinstance(features, list):
        raise ValueError("thumbnail geometry is not a feature collection")
    if len(features) > MAX_THUMBNAIL_FEATURES:
        raise ValueError(f"thumbnail has too many polygons ({len(features)} > {MAX_THUMBNAIL_FEATURES})")
    vertices = 0
    for feature in features:
        geometry = feature.get("geometry") if isinstance(feature, dict) else None
        coordinates = geometry.get("coordinates") if isinstance(geometry, dict) else None
        if geometry and geometry.get("type") != "Polygon":
            raise ValueError("thumbnail contains unsupported geometry")
        if not isinstance(coordinates, list):
            raise ValueError("thumbnail contains invalid polygon geometry")
        vertices += sum(len(ring) for ring in coordinates if isinstance(ring, list))
    if vertices > MAX_THUMBNAIL_VERTICES:
        raise ValueError(f"thumbnail has too many polygon points ({vertices} > {MAX_THUMBNAIL_VERTICES})")


def _component_ports(component: Any) -> list[dict[str, Any]]:
    ports = []
    for port in getattr(component, "ports", ()):
        ports.append({"name": str(port.name), "center": [float(port.center[0]), float(port.center[1])], "width": float(port.width), "orientation": float(port.orientation), "layer": list(port.layer)})
    return ports


def thumbnails(names: Any, project_root: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    if not isinstance(names, list) or not names or len(names) > MAX_THUMBNAIL_NAMES:
        raise ValueError(f"thumbnail request must contain 1-{MAX_THUMBNAIL_NAMES} names")
    if any(not isinstance(name, str) or not name or len(name) > 160 for name in names):
        raise ValueError("thumbnail component name is invalid")
    factories, _ = _factories(project_root)
    items: list[dict[str, Any]] = []
    import gdsfactory as gf
    # Keep the batch in one interpreter. Preview retains its isolated parser
    # subprocess, while thumbnails use the same parser function directly to
    # avoid starting one subprocess per icon.
    from parse_gds import parse_gds
    for name in names:
        item: dict[str, Any] = {"name": name}
        try:
            if name not in factories:
                raise ValueError("unknown component name")
            # get_component applies the installed factory's normal defaults and
            # validation; no user-provided expression or callable is evaluated.
            factory, source, library = factories[name]
            with _factory_working_directory(source, project_root):
                with contextlib.redirect_stdout(sys.stderr):
                    component = gf.get_component(factory if source == "project" else name)
                with tempfile.TemporaryDirectory(prefix="gds-thumbnail-") as directory:
                    gds_path = str(Path(directory) / "component.gds")
                    component.write_gds(gds_path)
                    geojson = parse_gds(gds_path)
            _thumbnail_geometry(geojson)
            item["geojson"] = geojson
            item["settings"] = {}
            item["ports"] = _component_ports(component)
            if library is not None:
                item["library"] = library
        except Exception as exc:
            item["error"] = str(exc)
        items.append(item)
    return {"items": items}


def preview(name: str, settings: Any, project_root: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    if not isinstance(name, str) or not name or len(name) > 160:
        raise ValueError("component name is invalid")
    if not isinstance(settings, dict):
        raise ValueError("settings must be a JSON object")
    ok, _ = _json_value(settings)
    if not ok:
        raise ValueError("settings contain a value that is not JSON representable")
    factories, _ = _factories(project_root)
    if name not in factories:
        raise ValueError("unknown component name")
    factory, source, library = factories[name]
    parameters = {p["name"]: p for p in _parameters(factory)}
    unknown = sorted(set(settings) - set(parameters))
    if unknown:
        raise ValueError("unknown setting(s): " + ", ".join(unknown))
    for key, value in settings.items():
        if parameters[key].get("type", "").lower().find("callable") >= 0:
            raise ValueError(f"setting {key} requires a callable and is not JSON representable")
        if isinstance(value, (dict, list)) and parameters[key].get("type", "").lower().find("callable") >= 0:
            raise ValueError(f"setting {key} is not JSON representable")
    import gdsfactory as gf
    with _factory_working_directory(source, project_root):
        with tempfile.TemporaryDirectory(prefix="gds-component-") as directory:
            gds_path = str(Path(directory) / "component.gds")
            with contextlib.redirect_stdout(sys.stderr):
                component = gf.get_component(factory if source == "project" else name, settings=settings)
            component.write_gds(gds_path)
            geojson = _parse_gds(gds_path)
    ports = _component_ports(component)
    result = {"geojson": geojson, "name": name, "settings": settings, "ports": ports}
    if library is not None:
        result["library"] = library
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", action="store_true")
    parser.add_argument("--preview", nargs=2, metavar=("NAME", "SETTINGS"))
    parser.add_argument("--thumbnails", metavar="NAMES_JSON")
    parser.add_argument("--project-root", metavar="PATH")
    args = parser.parse_args()
    try:
        result = catalog(args.project_root) if args.catalog else preview(args.preview[0], json.loads(args.preview[1]), args.project_root) if args.preview else thumbnails(json.loads(args.thumbnails), args.project_root) if args.thumbnails else None
        if result is None:
            raise ValueError("choose --catalog, --preview NAME JSON, or --thumbnails NAMES_JSON")
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
