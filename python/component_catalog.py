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

MAX_CATALOG = 16_000
MAX_JSON = 32 * 1024 * 1024
PARSE_TIMEOUT = 20


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


def _factories() -> dict[str, tuple[Any, str]]:
    import gdsfactory as gf

    gf.gpdk.PDK.activate()
    found: dict[str, tuple[Any, str]] = {}
    for name in dir(gf.components):
        if name.startswith("_"):
            continue
        factory = getattr(gf.components, name, None)
        if callable(factory) and not inspect.isclass(factory):
            try:
                inspect.signature(factory)
            except (TypeError, ValueError):
                continue
            found[name] = (factory, "components")
    for name, factory in gf.get_active_pdk().cells.items():
        if name.startswith("_") or not callable(factory):
            continue
        try:
            inspect.signature(factory)
        except (TypeError, ValueError):
            continue
        found.setdefault(name, (factory, "pdk"))
    return found


def catalog() -> dict[str, Any]:
    factories = _factories()
    components = []
    for name in sorted(factories):
        factory, source = factories[name]
        components.append({
            "name": name,
            "description": _description(factory),
            "parameters": _parameters(factory),
            "source": source,
        })
        if len(components) >= MAX_CATALOG:
            break
    import gdsfactory as gf
    return {"components": components, "environment": {
        "python": sys.executable,
        "gdsfactory": getattr(gf, "__version__", None),
        "path": str(Path(gf.__file__).resolve()),
        "activePdk": getattr(gf.get_active_pdk(), "name", None),
    }}


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


def preview(name: str, settings: Any) -> dict[str, Any]:
    if not isinstance(name, str) or not name or len(name) > 160:
        raise ValueError("component name is invalid")
    if not isinstance(settings, dict):
        raise ValueError("settings must be a JSON object")
    ok, _ = _json_value(settings)
    if not ok:
        raise ValueError("settings contain a value that is not JSON representable")
    factories = _factories()
    if name not in factories:
        raise ValueError("unknown component name")
    factory, _ = factories[name]
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
    with tempfile.TemporaryDirectory(prefix="gds-component-") as directory:
        gds_path = str(Path(directory) / "component.gds")
        component = gf.get_component(name, settings=settings)
        component.write_gds(gds_path)
        geojson = _parse_gds(gds_path)
    ports = []
    for port in getattr(component, "ports", ()):
        ports.append({"name": str(port.name), "center": [float(port.center[0]), float(port.center[1])], "width": float(port.width), "orientation": float(port.orientation), "layer": list(port.layer)})
    return {"geojson": geojson, "name": name, "settings": settings, "ports": ports}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", action="store_true")
    parser.add_argument("--preview", nargs=2, metavar=("NAME", "SETTINGS"))
    args = parser.parse_args()
    try:
        result = catalog() if args.catalog else preview(args.preview[0], json.loads(args.preview[1])) if args.preview else None
        if result is None:
            raise ValueError("choose --catalog or --preview NAME JSON")
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
