#!/usr/bin/env python3
"""Build pipeline: content/ + templates/ + assets/ → site/"""

import json
import shutil
from pathlib import Path
from jinja2 import Environment, FileSystemLoader, StrictUndefined

ROOT = Path(__file__).parent.parent
CONTENT = ROOT / "content"
TEMPLATES = ROOT / "templates"
ASSETS = ROOT / "assets"
SITE = ROOT / "site"


def clean():
    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir()


def copy_assets():
    if ASSETS.exists():
        shutil.copytree(ASSETS, SITE / "assets")


def make_env():
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES)),
        undefined=StrictUndefined,
        autoescape=False,
    )
    env.filters["tojson"] = json.dumps
    return env


def build_slides(env):
    for slide_path in sorted((CONTENT / "slides").glob("*.json")):
        slide = json.loads(slide_path.read_text())
        slug = slide_path.stem

        if "data" in slide:
            data_path = ROOT / slide["data"]
            slide["_data"] = json.loads(data_path.read_text())

        template = env.get_template(f"slides/{slide['template']}.html")
        html = template.render(slide=slide, slug=slug)

        out_dir = SITE / "slide" / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(html)
        print(f"  slide/{slug}")


def build_slideshows(env):
    for show_path in sorted((CONTENT / "slideshows").glob("*.json")):
        show = json.loads(show_path.read_text())
        slug = show_path.stem

        template = env.get_template("slideshow/player.html")
        html = template.render(show=show, slug=slug)

        out_dir = SITE / "slideshow" / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(html)
        print(f"  slideshow/{slug}")


if __name__ == "__main__":
    print("Cleaning site/...")
    clean()

    print("Copying assets...")
    copy_assets()

    env = make_env()

    print("Building slides...")
    build_slides(env)

    print("Building slideshows...")
    build_slideshows(env)

    (SITE / ".nojekyll").write_text("")
    print("\nDone. To preview locally:")
    print("  cd site && python -m http.server 8000")
    print("  open http://localhost:8000/slideshow/pavilion-1/")
