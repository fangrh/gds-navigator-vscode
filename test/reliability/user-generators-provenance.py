"""Verify exact-fixture generators, polygon provenance, and source arrays."""

from __future__ import annotations

import argparse
import ast
import collections
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import gdstk

ROOT = Path(__file__).resolve().parents[2]
GDS2027 = Path(r"D:\gds2027")
BACKUP = GDS2027 / ".gds-navigator" / "backups" / "exact-fixture-20260922"
PARSER = ROOT / "python" / "parse_gds.py"
ARRAY_NAMES = ("L8_POLYS", "L1_POLYS", "L9_POLYS", "L4_POLYS")


def source_arrays(path: Path) -> dict[str, str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    nodes = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name) and target.id in ARRAY_NAMES + ("JJ_PAD", "JJ_LEAD", "JJ_CENTER"):
                nodes[target.id] = node.value
    if "L4_POLYS" not in nodes and all(name in nodes for name in ("JJ_PAD", "JJ_LEAD", "JJ_CENTER")):
        nodes["L4_POLYS"] = ast.Tuple(
            elts=[nodes[name] for name in ("JJ_PAD", "JJ_LEAD", "JJ_CENTER")],
            ctx=ast.Load(),
        )
    values = {
        name: ast.dump(nodes[name], include_attributes=False)
        for name in ARRAY_NAMES
        if name in nodes
    }
    return values


def canonical_polygon(points) -> tuple[tuple[int, int], ...]:
    nm = [(round(float(x) * 1000), round(float(y) * 1000)) for x, y in points]
    forward = min(tuple(nm[i:] + nm[:i]) for i in range(len(nm)))
    reversed_points = list(reversed(nm))
    backward = min(tuple(reversed_points[i:] + reversed_points[:i]) for i in range(len(nm)))
    return min(forward, backward)


def polygon_multiset(path: Path) -> collections.Counter:
    library = gdstk.read_gds(path)
    cell = next(cell for cell in library.cells if cell.name == "chip")
    return collections.Counter(
        (int(polygon.layer), int(polygon.datatype), canonical_polygon(polygon.points))
        for polygon in cell.polygons
    )


def parse_provenance(path: Path, source: Path) -> dict:
    parsed = json.loads(subprocess.check_output([sys.executable, str(PARSER), str(path)], text=True))
    features = parsed.get("features", [])
    missing, wrong_source, weak_chain, bad_loop = [], [], [], []
    for index, feature in enumerate(features):
        provenance = feature.get("properties", {}).get("provenance")
        if not provenance:
            missing.append(index)
            continue
        provenance_file = Path(provenance.get("file", ""))
        if provenance_file.name != source.name:
            wrong_source.append(index)
        chain = provenance.get("call_chain", [])
        if not chain or not all(item.get("file") and item.get("function") for item in chain):
            weak_chain.append(index)
        if not provenance.get("loop_index") or len(provenance["loop_index"]) != 2:
            bad_loop.append(index)
    return {
        "feature_count": len(features),
        "missing_provenance": missing,
        "wrong_source": wrong_source,
        "weak_call_chain": weak_chain,
        "bad_loop_index": bad_loop,
        "passed": len(features) == 1818 and not (missing or wrong_source or weak_chain or bad_loop),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    results = {}
    with tempfile.TemporaryDirectory(prefix="jj-generator-exact-", dir=GDS2027 / ".gds-navigator") as temp:
        out_dir = Path(temp)
        for size in (50, 100):
            source = GDS2027 / f"generate_jj_pad_center_{size}.py"
            backup_source = BACKUP / source.name
            fixture = ROOT / "test" / "fixtures" / f"jj_pad_center_{size}_test.gds"
            generated = out_dir / f"jj_pad_center_{size}_test.gds"
            subprocess.run([sys.executable, str(source), "--out", str(generated)], check=True, capture_output=True, text=True)
            expected_arrays = source_arrays(backup_source)
            actual_arrays = source_arrays(source)
            fixture_polys = polygon_multiset(fixture)
            generated_polys = polygon_multiset(generated)
            results[str(size)] = {
                "array_literals_unchanged": actual_arrays == expected_arrays,
                "reference_polygon_count": sum(fixture_polys.values()),
                "generated_polygon_count": sum(generated_polys.values()),
                "exact_polygon_multiset": fixture_polys == generated_polys,
                "provenance": parse_provenance(generated, source),
            }
    passed = all(item["array_literals_unchanged"] and item["exact_polygon_multiset"] and item["provenance"]["passed"] for item in results.values())
    report = {"status": "passed" if passed else "failed", "results": results}
    rendered = json.dumps(report, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
