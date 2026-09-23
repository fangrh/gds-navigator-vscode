#!/usr/bin/env python3
"""Deterministic synthetic microscope corpus for numbered-marker alignment."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "logs" / "numbered-markers" / "random100"
IMG_DIR = OUT / "images"
FIXTURE = ROOT / "test" / "fixtures" / "jj_pad_center_50_geo.json"
SEED = 20260922
SIZE = 720
CENTERS = [[-200, -200], [0, -200], [-200, -400], [0, -400]]
SEVERITIES = ("mild", "moderate", "hard", "severe", "unidentifiable")


def truth(deg: float, perspective: bool = False) -> list[float]:
    t = math.radians(deg)
    a, b = 0.5 * math.cos(t), 0.5 * math.sin(t)
    g = 0.000045 if perspective else 0.0
    h = -0.000055 if perspective else 0.0
    z = 1 + 360 * g + 360 * h
    # Image pixels -> GDS, matching numbered-markers.test.js exactly.
    return [a, b, -100 * z - 360 * (a + b), b, -a,
            -300 * z - 360 * (b - a), g, h, 1]


def inverse(m: list[float]) -> list[float]:
    b = [m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
         m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
         m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3]]
    d = m[0] * b[0] + m[1] * b[3] + m[2] * b[6]
    return [x / d for x in b]


def project(h: list[float], x: float, y: float) -> tuple[float, float]:
    z = h[6] * x + h[7] * y + h[8]
    return ((h[0] * x + h[1] * y + h[2]) / z,
            (h[3] * x + h[4] * y + h[5]) / z)


def feature_group(feature: dict) -> int:
    pts = feature["geometry"]["coordinates"][0]
    box = (min(p[0] for p in pts), min(p[1] for p in pts),
           max(p[0] for p in pts), max(p[1] for p in pts))
    for i, (cx, cy) in enumerate(CENTERS):
        if box[0] >= cx - 11 and box[2] <= cx + 65 and box[1] >= cy - 60 and box[3] <= cy + 11:
            return i
    return -1


def is_pad(feature: dict) -> bool:
    pts = feature["geometry"]["coordinates"][0]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return abs(max(xs) - min(xs) - 20) < 0.01 and abs(max(ys) - min(ys) - 20) < 0.01


def draw_flake(draw: ImageDraw.ImageDraw, rng: np.random.Generator, avoid: list[tuple[float, float, float, float]], irregular: bool) -> bool:
    for _ in range(12):
        x, y = rng.uniform(8, SIZE - 8, 2)
        r = rng.uniform(5, 32)
        if any(x0 - r < x < x1 + r and y0 - r < y < y1 + r for x0, y0, x1, y1 in avoid):
            continue
        n = int(rng.integers(5, 10)) if irregular else 4
        angles = np.sort(rng.uniform(0, 2 * math.pi, n))
        radii = r * rng.uniform(0.55, 1.2, n)
        if not irregular:
            angles = np.linspace(0, 2 * math.pi, n, endpoint=False)
            radii = np.full(n, r)
        pts = [(x + math.cos(a) * q, y + math.sin(a) * q) for a, q in zip(angles, radii)]
        col = tuple(int(v) for v in rng.integers(20, 235, 3)) + (int(rng.integers(70, 180)),)
        draw.polygon(pts, fill=col)
        return True
    return False


def make_case(rng: np.random.Generator, severity: str, index: int, features: list[dict]) -> tuple[Image.Image, dict]:
    angle = float(rng.uniform(-12, 12))
    perspective = bool(severity == "mild" and rng.random() < 0.25)
    h = truth(angle, perspective)
    inv = inverse(h)
    bg = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    yy, xx = np.mgrid[:SIZE, :SIZE]
    illumination = rng.uniform(0.75, 1.2) + (xx / SIZE - 0.5) * rng.uniform(-0.18, 0.18) + (yy / SIZE - 0.5) * rng.uniform(-0.18, 0.18)
    base = np.array([128.0, 128.0, 128.0])
    bg[:, :, :3] = np.clip(illumination[:, :, None] * base, 0, 255).astype(np.uint8)
    bg[:, :, 3] = 255
    image = Image.fromarray(bg, "RGBA")
    d = ImageDraw.Draw(image, "RGBA")
    selected = [f for f in features if feature_group(f) >= 0]
    group_boxes = {}
    for f in selected:
        group = feature_group(f)
        pts = f["geometry"]["coordinates"][0]
        q = [project(inv, *p) for p in pts]
        xs, ys = zip(*q)
        if severity == "unidentifiable" and not is_pad(f):
            continue
        # Keep markers yellow; only the flakes vary in color.
        d.polygon(q, fill=(231, 238, 48, 235))
        if severity == "mild":
            box = group_boxes.setdefault(group, [float("inf"), float("inf"), float("-inf"), float("-inf")])
            box[0], box[1], box[2], box[3] = min(box[0], min(xs)), min(box[1], min(ys)), max(box[2], max(xs)), max(box[3], max(ys))
    flake_avoid = [(b[0] - 12, b[1] - 12, b[2] + 12, b[3] + 12) for b in group_boxes.values()] if severity == "mild" else []
    flake_target = 18 if severity == "mild" else 34
    flake_count = sum(bool(draw_flake(d, rng, flake_avoid, irregular=bool(rng.integers(0, 2)))) for _ in range(flake_target))
    blur = float(rng.uniform(*{"mild": (0.1, 0.35), "moderate": (0.45, 0.9), "hard": (0.9, 1.7), "severe": (1.5, 2.8), "unidentifiable": (1.7, 3.0)}[severity]))
    if blur:
        image = image.filter(ImageFilter.GaussianBlur(blur))
    arr = np.asarray(image.convert("RGB"), dtype=np.float32)
    shot_scale = int(rng.integers(*{"mild": (1000, 3001), "moderate": (250, 501), "hard": (60, 101), "severe": (12, 31), "unidentifiable": (10, 31)}[severity]))
    arr = rng.poisson(np.clip(arr, 0, 255) / 255.0 * shot_scale) / shot_scale * 255.0
    arr = np.clip(arr, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr, "RGB")
    params = {"angleDeg": angle, "perspective": perspective, "blurSigma": blur,
              "shotNoiseScale": shot_scale, "flakeCount": flake_count,
              "flakeMode": "regular+irregular", "illumination": "random-gradient"}
    return img, {"id": f"random-{index:03d}", "severity": severity,
                 "expected": "align" if severity == "mild" else ("reject" if severity == "unidentifiable" else "challenge"),
                 "transform": h, "markerCenters": CENTERS, "labels": ["0,0", "0,-1", "1,0", "1,-1"],
                 "noise": params}


def sheet(paths: list[Path], out: Path, cols: int, cell: int = 160) -> None:
    canvas = Image.new("RGB", (cols * cell, math.ceil(len(paths) / cols) * cell), "white")
    d = ImageDraw.Draw(canvas)
    for i, p in enumerate(paths):
        im = Image.open(p).convert("RGB"); im.thumbnail((cell - 4, cell - 22))
        x, y = (i % cols) * cell, (i // cols) * cell
        canvas.paste(im, (x + (cell - im.width) // 2, y + 2)); d.text((x + 4, y + cell - 18), p.stem, fill="black")
    canvas.save(out)


def main() -> None:
    fixture_bytes = FIXTURE.read_bytes()
    fixture = json.loads(fixture_bytes)
    features = [f for f in fixture["features"] if int(f["properties"].get("layer", -1)) in (1, 8, 9) and feature_group(f) >= 0]
    OUT.mkdir(parents=True, exist_ok=True); IMG_DIR.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(SEED); cases = []; paths = []
    for i, severity in enumerate(SEVERITIES):
        for _ in range(20):
            n = len(cases) + 1
            case_seed = int(rng.integers(0, 2**63))
            img, case = make_case(np.random.default_rng(case_seed), severity, n, features)
            case["caseSeed"] = case_seed
            path = IMG_DIR / f"{case['id']}.png"; img.save(path); paths.append(path)
            case["image"] = str(path.resolve()); cases.append(case)
    manifest = {"seed": SEED, "inputs": {"fixture": str(FIXTURE.resolve()), "fixtureSha256": hashlib.sha256(fixture_bytes).hexdigest(), "truthSource": "test/alignment/numbered-markers.test.js"}, "cases": cases}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    sheet(paths, OUT / "contact-sheet-100.png", 10)
    sample = [paths[i] for i in (0, 1, 20, 21, 40, 41, 60, 61, 80, 81, 10, 90)]
    sheet(sample, OUT / "sample-sheet-12.png", 4)
    print(json.dumps({"status": "generated", "images": len(paths), "out": str(OUT.resolve())}))


if __name__ == "__main__":
    main()
