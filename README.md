# slides.wendovercc.org

Digital signage and statistics platform for Wendover Cricket Club.

## Overview

This repository powers two things from a single build pipeline:

1. **A static website** at `slides.wendovercc.org` — browseable stats pages for the club
2. **A slideshow system** for TV displays in club pavilions, driven by Chromium in kiosk mode on Raspberry Pi

Both are served as static files hosted on GitHub Pages, with Cloudflare managing DNS and CDN.

> **Note:** This repo will be renamed `slides` to match the domain.

---

## How it works

### Data pipeline

Stats data is fetched from the Play-Cricket API and processed locally by Python scripts into a standardised JSON schema. Historic stats from other sources are processed by one-off parser scripts into the same schema. Once a week, the build is run locally and output is pushed to GitHub, redeploying the static site.

```
Play-Cricket API / historic sources
        ↓
  Python pipeline (run locally, once/week)
        ├── fetches and normalises data → data JSON files
        └── renders slides and slideshows via Jinja2 templates
        ↓
  git push → GitHub Pages rebuild
        ↓
  slides.wendovercc.org (static files, served via Cloudflare CDN)
        ↓
  Raspberry Pi (Chromium kiosk) → polls slideshow config → displays slides
```

---

## The slide model

Every slide is:

- An **authored JSON file** (`content/slides/[slug].json`) — always hand-crafted and committed to the repo
- Rendered against a **Jinja2 template** at build time into `site/slide/[slug]/index.html`
- Some fields in the JSON may reference generated data artifacts (e.g. stats results); the build resolves and inlines these at render time

Every slide is independently viewable as a static page. Data is baked in at build time — no runtime fetching needed.

### Authored slide JSON

```json
{
  "template": "stats_results",
  "title": "1st XI Recent Results",
  "data": "data/results-1xi.json",
  "valid_from": "2025-04-01",
  "valid_until": "2025-09-30"
}
```

```json
{
  "template": "announcement",
  "title": "Summer Social — 14th June",
  "body": "All members and families welcome. Bring a dish to share.",
  "image": "events/summer-social-2025.jpg"
}
```

The `data` field, when present, points to a generated data artifact that the build resolves before rendering. All other fields are passed directly to the template.

---

## Slideshow config

Each physical display has a JSON config file (`content/slideshows/[slug].json`) listing slides by slug with display durations. The slideshow player (`/slideshow/[slug]`) reads this config and cycles through slides in an iframe, refreshing the config at a set interval.

```json
{
  "title": "Pavilion 1",
  "refresh_interval_seconds": 300,
  "slides": [
    { "slug": "results-1xi",  "duration": 15 },
    { "slug": "league-table", "duration": 15 },
    { "slug": "sponsor-main", "duration": 10 }
  ]
}
```

Slides with `valid_from` / `valid_until` dates in their JSON are automatically included or excluded by the build.

---

## URL structure

| URL | Description |
|-----|-------------|
| `slides.wendovercc.org/slideshow/[slug]` | Slideshow player for a named display |
| `slides.wendovercc.org/slide/[slug]` | Individual slide as a standalone page |
| `slides.wendovercc.org/data/[file].json` | Generated data files (raw stats etc.) |

---

## Slide types

| Template | Description |
|----------|-------------|
| `stats_results` | Recent match results for a team |
| `stats_table` | League table |
| `stats_averages` | Batting or bowling averages |
| `announcement` | Hand-authored text/image announcement |
| `sponsor` | Sponsor placement slide |
| `image` | Full-screen image or photograph |

---

## Repository structure

```
/
├── content/
│   ├── slides/          # authored slide JSON files (one per slide, slug = filename)
│   └── slideshows/      # slideshow config JSON files (one per display)
├── scripts/
│   ├── build.py         # main build orchestrator
│   ├── fetch_playcricket.py
│   └── parsers/         # one-off historic data parsers
├── schema/              # canonical JSON schemas for match data etc.
├── templates/
│   ├── slides/          # one Jinja2 template per slide type
│   └── slideshow/       # slideshow player template
└── site/                # generated output → served by GitHub Pages
    ├── data/            # generated data JSON files
    ├── slide/
    │   └── [slug]/
    │       └── index.html
    └── slideshow/
        └── [slug]/
            └── index.html
```

`site/` is committed to the repo. Everything inside it is generated — edit source files in `content/`, `templates/`, or `scripts/`, not in `site/` directly.

---

## Raspberry Pi setup

Each pavilion TV runs a Raspberry Pi booting into Chromium kiosk mode, pointed at the relevant slideshow URL. The slideshow player:

- Fetches the slideshow config on load
- Cycles through slides in an `<iframe>` (each slide is self-contained)
- Re-fetches the config at `refresh_interval_seconds` to pick up weekly updates
- Caches the last-fetched config locally for offline resilience

Multiple pavilions are supported by creating a slideshow config per display. Displays can show different content (e.g. different team results).

---

## Data sources

- **Current season**: Play-Cricket API, fetched by `scripts/fetch_playcricket.py`
- **Historic stats**: one-off parser scripts in `scripts/parsers/`, all normalising to the canonical schema in `schema/`

---

## Deployment

Pushing to `main` triggers a GitHub Actions workflow that runs the build and deploys `site/` to GitHub Pages automatically. The `site/` directory is **not committed** to the repo.

To enable this on a new repo:
1. Go to **Settings → Pages → Source** and set source to **GitHub Actions**
2. Push to `main` — the workflow in `.github/workflows/deploy.yml` handles the rest

For a custom domain, add a `CNAME` file to `assets/` containing the domain (e.g. `slides.wendovercc.org`), then configure DNS in Cloudflare.

## Local development

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python scripts/build.py
cd site && python -m http.server 8000
# open http://localhost:8000/slideshow/pavilion-1/
```

Slides are served with absolute paths (`/slide/...`), so you must use a local web server — opening `site/` files directly in the browser will not work.

---

## Tech stack

| Concern | Choice | Reason |
|---------|--------|--------|
| Build | Python + Jinja2 | Pipeline is already Python; more flexible than a framework |
| Hosting | GitHub Pages | Free, zero-maintenance, git-push deploys |
| CDN / DNS | Cloudflare (free tier) | Custom domain, caching, DDoS protection |
| Display | Chromium kiosk on Raspberry Pi | Standard, updatable without Pi access |
| Stats source | Play-Cricket API | Standard UK club cricket platform |
