"""Small everyday layout for selection, source navigation and AI handoff demos.

Run with your gdsfactory fork:
  python test/examples/ai-handoff/layout.py --out logs/ai-demo/layout.gds
"""
import argparse
import os
from pathlib import Path

os.environ.setdefault("GDS_PROVENANCE", "1")
import gdsfactory as gf


def make_layout():
    gf.gpdk.PDK.activate()
    layout = gf.Component("agent_handoff_demo")
    for row in range(2):
        for column in range(3):
            pad = layout << gf.components.rectangle(size=(10, 6), layer=(4, 0))
            pad.move((column * 30, row * 24))
            pad.name = f"pad_r{row}_c{column}"
    disk = layout << gf.components.circle(radius=4, layer=(8, 0))
    disk.move((105, 0))
    disk.name = "alignment_disk"
    layout.add_polygon([(0, 50), (25, 50), (25, 55), (5, 55), (5, 70), (0, 70)], layer=(9, 0))
    return layout


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=Path("logs/ai-demo/layout.gds"), type=Path)
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    make_layout().write_gds(args.out)
    print(args.out.resolve())
