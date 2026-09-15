"""
Re-export every activity's ExperienceReplay JSON.

  cd fly_console && python3 activities/export_all.py
"""
from __future__ import annotations

import runpy
import sys
from pathlib import Path

ACTIVITIES_DIR = Path(__file__).resolve().parent


def main():
    exporters = sorted(ACTIVITIES_DIR.glob("*/export_experience.py"))
    if not exporters:
        print("No activities/*/export_experience.py found", file=sys.stderr)
        sys.exit(1)
    for path in exporters:
        print(f"--- {path.parent.name} ---")
        runpy.run_path(str(path), run_name="__main__")


if __name__ == "__main__":
    main()
