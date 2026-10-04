"""Assemble the static site for GitHub Pages.

Copies web/ to _site/, plus the numpy-only Python modules the page runs in
Pyodide, so the browser runs the same code as the CLI.

    uv run python tools/build_site.py          # writes _site/
    python -m http.server -d _site 8000        # then open http://localhost:8000/
"""

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY_MODULES = ["__init__.py", "series.py", "signals.py", "session.py"]


def build(out: Path) -> None:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "web", out)
    py_dir = out / "py" / "fourier"
    py_dir.mkdir(parents=True)
    for name in PY_MODULES:
        shutil.copy(ROOT / "src" / "fourier" / name, py_dir / name)
    # Stop GitHub Pages running the site through Jekyll.
    (out / ".nojekyll").touch()


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "_site"
    build(out)
    print(f"Site written to {out}")
