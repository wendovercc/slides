#!/usr/bin/env python3
"""Build pipeline: content/ + templates/ + assets/ → site/"""

import base64
import hashlib
import io
import json
import os
import random
import re
import shutil
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import qrcode
from jinja2 import Environment, FileSystemLoader, StrictUndefined

import ball_events
import clip_ids

ROOT = Path(__file__).parent.parent
CONTENT = ROOT / "content"
FETCHED = CONTENT / "data" / "fetched"
VIDEOS_CACHE    = CONTENT / "data" / "fetched" / "videos"
VIDEO_MANIFEST  = CONTENT / "data" / "video_manifest.json"
FETCHED_MATCHES = CONTENT / "data" / "fetched" / "matches"   # raw ball events (rebuilt each build)
CURATION_DIR    = CONTENT / "data" / "matches"               # committed {id}.curation.json overlays
PINNED_MATCHES  = CONTENT / "pinned-matches.json"            # committed manifest of pinned match sets
TEMPLATES = ROOT / "templates"
ASSETS = ROOT / "assets"
SITE = ROOT / "site"

LEAGUE_TABLE_EXCLUDED = {"ave+", "batp", "bowlp", "offbp", "pen", "t"}
LEADERBOARD_TEMPLATES = {"leaderboard"}
HONOURS_TEMPLATES = {"honours"}
# Empty fallback for the fantasy-league panels when a feed is missing this build.
FANTASY_EMPTY = {"headers": [], "rows": [], "tabs": {}, "page_title": None, "fetched_at": None}

# Carousel templates with a fixed panel set: the tab strip these templates render,
# in order. The `team` template is data-driven instead — it publishes a
# `slide["_panels"]` list of panel *keys*, named by TEAM_PANEL_LABELS below.
#
# These labels used to be hard-coded `<span class="panel-tab">` literals in each
# template, which meant nothing outside the rendered page knew a panel's name: the
# tooling could say a slide had four atoms but not that the third was "Top
# Managers". They are declared here and rendered from data (see the `panel_nav`
# macro) for the same reason `_heading`/`_subheading` are — one literal, one place,
# and the editor tools can name what they are addressing.
#
# Doubles as the panel *count* for these templates, so the two can never disagree:
# a slide's duration is panel_duration × panel count.
FIXED_PANEL_LABELS = {
    "honours": ["Top Scores", "Recent 100s", "Best Figures", "Recent 6+ Wickets"],
    "leaderboard": ["Most Runs", "Batting Average", "Most Wickets", "Bowling Average"],
    "fantasy-league": ["Team of the Week", "Top Players", "Top Managers", "Teams"],
}

# Panel key → tab label for the `team` template, whose panels are whichever ones
# had data this build (see build_team's `slide["_panels"]`).
TEAM_PANEL_LABELS = {
    "league": "League",
    "results": "Form",
    "schedule": "Schedule",
    "top_batting": "Batting",
    "top_bowling": "Bowling",
    "highlights": "Records",
}

# Senior teams that get a published-XI card on the fantasy slide's "Teams"
# panel, in display order (left-to-right).
FANTASY_TEAM_ORDER = ["1st-xi", "2nd-xi", "friendly-xi"]


def _today():
    """Today's date, or an override for local testing of day-gated features
    (live-match slides, the `today` board). Set WCC_TODAY=YYYY-MM-DD to make the
    whole build behave as if it were that day — e.g. replaying a past match day's
    live feed on a non-match day. Unset in normal/CI builds → real date."""
    override = os.environ.get("WCC_TODAY")
    return date.fromisoformat(override) if override else date.today()


def load_config():
    path = CONTENT / "config.json"
    config = json.loads(path.read_text()) if path.exists() else {}
    # Local-testing override for the live-match feature switch, so live can be
    # exercised without editing (and risking committing) content/config.json.
    # WCC_LIVE_ENABLED=1/true/on forces it on; 0/false/off forces it off.
    env_live = os.environ.get("WCC_LIVE_ENABLED")
    if env_live is not None:
        config["live_enabled"] = env_live.strip().lower() in ("1", "true", "on", "yes")
    return config


def load_pinned_matches():
    """Pinned matches: completed games kept as their own dedicated slide set
    regardless of whether they're still a team's latest game.

    fetch_fixtures.py only retains the most recent games per team, so an older
    match's scorecard drops out of fixtures.json over time. A pin therefore reads
    its scorecard from a committed snapshot at
    ``content/data/matches/{match_id}.package.json`` (a completed match is
    immutable, so the snapshot never goes stale). Ball-event reels still resolve
    live: their curation overlay is committed and fetch_ball_events.py re-pulls any
    match that has one.

    Manifest (``content/pinned-matches.json``) is a list of:
        {"slug", "match_id", "team_id", "title"}
    - ``slug``     set slug referenced from a slideshow (e.g. "match-denham-cc")
    - ``team_id``  the team whose match this was, for crest/stats/league lookups
    - ``title``    the small per-slide heading (e.g. "Match Highlights")
    Returns each manifest entry with the loaded snapshot under ``_package`` (None
    when the snapshot file is missing).
    """
    if not PINNED_MATCHES.exists():
        return []
    pins = json.loads(PINNED_MATCHES.read_text())
    out = []
    for pin in pins:
        pkg_path = CURATION_DIR / f"{pin['match_id']}.package.json"
        out.append({**pin, "_package": json.loads(pkg_path.read_text()) if pkg_path.exists() else None})
    return out


def balls_to_overs(balls):
    return f"{balls // 6}.{balls % 6}"


def fmt_hs(batting):
    if batting["high_score"] is None:
        return "-"
    suffix = "*" if batting["high_score_not_out"] else ""
    return f"{batting['high_score']}{suffix}"


def fmt_best(bowling):
    if not bowling.get("best"):
        return "-"
    return f"{bowling['best']['wickets']}-{bowling['best']['runs']}"


def merge_blocks(blocks):
    """Merge a list of stats blocks into one, recalculating derived stats."""
    result = {
        "matches": 0,
        "batting": {
            "innings": 0, "not_outs": 0, "runs": 0, "balls": 0,
            "high_score": None, "high_score_not_out": None,
            "fours": 0, "sixes": 0, "fifties": 0, "hundreds": 0,
        },
        "bowling": {"balls": 0, "maidens": 0, "runs": 0, "wickets": 0, "best": None},
    }
    for block in blocks:
        result["matches"] += block["matches"]
        b, rb = block["batting"], result["batting"]
        for key in ("innings", "not_outs", "runs", "balls", "fours", "sixes", "fifties", "hundreds"):
            rb[key] += b[key]
        if b["high_score"] is not None:
            if rb["high_score"] is None or b["high_score"] > rb["high_score"]:
                rb["high_score"] = b["high_score"]
                rb["high_score_not_out"] = b["high_score_not_out"]
        bl, rbl = block["bowling"], result["bowling"]
        for key in ("balls", "maidens", "runs", "wickets"):
            rbl[key] += bl[key]
        if bl.get("best"):
            cur = rbl["best"]
            new = bl["best"]
            if cur is None or new["wickets"] > cur["wickets"] or (
                new["wickets"] == cur["wickets"] and new["runs"] < cur["runs"]
            ):
                rbl["best"] = new
    rb = result["batting"]
    outs = rb["innings"] - rb["not_outs"]
    rb["average"] = round(rb["runs"] / outs, 2) if outs > 0 else None
    rb["strike_rate"] = round(rb["runs"] / rb["balls"] * 100, 2) if rb["balls"] > 0 else None
    rbl = result["bowling"]
    rbl["average"] = round(rbl["runs"] / rbl["wickets"], 2) if rbl["wickets"] > 0 else None
    rbl["economy"] = round(rbl["runs"] / rbl["balls"] * 6, 2) if rbl["balls"] > 0 else None
    return result


def get_leaderboard_block(player, team_filter, comp_filter):
    if isinstance(team_filter, list):
        blocks = []
        for tid in team_filter:
            team_entry = player["stats"]["by_team"].get(tid, {})
            block = team_entry.get("by_competition", {}).get(comp_filter) if comp_filter else team_entry.get("all")
            if block and block["matches"] > 0:
                blocks.append(block)
        return merge_blocks(blocks) if blocks else None
    if team_filter and comp_filter:
        return (
            player["stats"]["by_team"]
            .get(team_filter, {})
            .get("by_competition", {})
            .get(comp_filter)
        )
    if team_filter:
        return player["stats"]["by_team"].get(team_filter, {}).get("all")
    return player["stats"]["all"]


def _strictest_filling(values, target_rows, floor, ceiling):
    """Highest threshold in [floor, ceiling] that still leaves `target_rows` qualifiers.

    Qualifier counts fall monotonically as the threshold rises, so walking up
    and keeping the last threshold that fills the table finds it. If even the
    floor can't fill the table, the floor is what we get — a short board beats
    an empty one.
    """
    best = floor
    for t in range(floor, ceiling + 1):
        if sum(1 for v in values if v >= t) >= target_rows:
            best = t
    return best


def qualification_thresholds(entries, lb_config, rows):
    """Qualification bars for the "best average" tables.

    A flat `min 2 innings / 2 overs` was far too soft by August — club-wide
    bowling averages became a list of juniors with four overs apiece. The bar
    is the configured one (5 innings / 10 overs), which holds all season and
    needs no explaining; it only relaxes back towards the floor when it would
    leave the table short of rows, which is early season, thin squads and the
    smaller junior scopes.

    Batting counts innings, not-outs included: someone who bats regularly and
    finishes innings is exactly who these boards are for. A player yet to be
    dismissed has no average at all and drops out downstream.

    Returns (min_innings, min_overs).
    """
    cfg = lb_config or {}
    floor_innings = cfg.get("floor_innings", 2)
    floor_overs = cfg.get("floor_overs", 2)
    bat_bar = max(floor_innings, cfg.get("min_innings", 5))
    bowl_bar = max(floor_overs, cfg.get("min_overs", 10))

    # Only players who'd actually appear count towards filling the table: an
    # average of None (no dismissals / no wickets) is excluded downstream, so
    # counting them here would relax the bar for rows that never render.
    innings = [
        e["block"]["batting"]["innings"]
        for e in entries
        if e["block"]["batting"].get("average") is not None
    ]
    overs = [
        e["block"]["bowling"]["balls"] / 6
        for e in entries
        if e["block"]["bowling"].get("average") is not None
    ]
    return (
        _strictest_filling(innings, rows, floor_innings, bat_bar),
        _strictest_filling(overs, rows, floor_overs, bowl_bar),
    )


def build_batting_leaderboard(slide, stats_data, lb_config):
    team_filter = slide.get("teams") or slide.get("team")
    comp_filter = slide.get("competition")
    rows = lb_config.get("rows", 8)

    entries = []
    for p in stats_data["players"].values():
        block = get_leaderboard_block(p, team_filter, comp_filter)
        if block and block["matches"] > 0:
            entries.append({"name": p["name"], "block": block})

    min_innings, _ = qualification_thresholds(entries, lb_config, rows)

    def fmt(e):
        b = e["block"]["batting"]
        avg = b.get("average")
        return {
            "name": e["name"],
            "matches": e["block"]["matches"],
            "innings": b["innings"],
            "not_outs": b["not_outs"],
            "runs": b["runs"],
            "high_score_num": str(b["high_score"]) if b["high_score"] is not None else "-",
            "high_score_not_out": bool(b.get("high_score_not_out")),
            "average": f"{avg:.1f}" if avg is not None else "-",
        }

    runs_rows = sorted(
        [e for e in entries if e["block"]["batting"]["innings"] > 0],
        key=lambda e: e["block"]["batting"]["runs"],
        reverse=True,
    )[:rows]

    avg_rows = sorted(
        [
            e for e in entries
            if e["block"]["batting"]["innings"] >= min_innings
            and e["block"]["batting"].get("average") is not None
        ],
        key=lambda e: e["block"]["batting"]["average"],
        reverse=True,
    )[:rows]

    slide["_runs_rows"] = [fmt(e) for e in runs_rows]
    slide["_avg_rows"] = [fmt(e) for e in avg_rows]
    slide["_min_innings"] = min_innings


def build_bowling_leaderboard(slide, stats_data, lb_config):
    team_filter = slide.get("teams") or slide.get("team")
    comp_filter = slide.get("competition")
    rows = lb_config.get("rows", 8)

    entries = []
    for p in stats_data["players"].values():
        block = get_leaderboard_block(p, team_filter, comp_filter)
        if block and block["matches"] > 0:
            entries.append({"name": p["name"], "block": block})

    _, min_overs = qualification_thresholds(entries, lb_config, rows)
    min_balls = min_overs * 6

    def fmt(e):
        b = e["block"]["bowling"]
        avg = b.get("average")
        return {
            "name": e["name"],
            "matches": e["block"]["matches"],
            "overs": balls_to_overs(b["balls"]),
            "wickets": b["wickets"],
            "best": fmt_best(b),
            "average": f"{avg:.1f}" if avg is not None else "-",
        }

    wkts_rows = sorted(
        [e for e in entries if e["block"]["bowling"]["wickets"] > 0],
        key=lambda e: e["block"]["bowling"]["wickets"],
        reverse=True,
    )[:rows]

    avg_rows = sorted(
        [
            e for e in entries
            if e["block"]["bowling"]["balls"] >= min_balls
            and e["block"]["bowling"].get("average") is not None
        ],
        key=lambda e: e["block"]["bowling"]["average"],
    )[:rows]

    slide["_wkts_rows"] = [fmt(e) for e in wkts_rows]
    slide["_avg_rows"] = [fmt(e) for e in avg_rows]
    slide["_min_overs"] = min_overs


def build_leaderboard(slide, stats_data, lb_config):
    """Combined batting + bowling leaderboard: four panels in one carousel.

    Reuses the single-discipline builders on throwaway copies, then lifts their
    outputs onto the slide under distinct keys (both set `_avg_rows`, which would
    otherwise collide). Panels: runs · batting average · wickets · bowling average.
    """
    bat = dict(slide)
    build_batting_leaderboard(bat, stats_data, lb_config)
    bowl = dict(slide)
    build_bowling_leaderboard(bowl, stats_data, lb_config)

    slide["_runs_rows"] = bat["_runs_rows"]
    slide["_bat_avg_rows"] = bat["_avg_rows"]
    slide["_min_innings"] = bat["_min_innings"]
    slide["_wkts_rows"] = bowl["_wkts_rows"]
    slide["_bowl_avg_rows"] = bowl["_avg_rows"]
    slide["_min_overs"] = bowl["_min_overs"]


def _abbrev_xi(designation):
    """Abbreviate a team designation: '1st XI' → '1s', '4th XI' → '4s', 'A XI' → 'A'."""
    if not designation:
        return ""
    import re as _re
    m = _re.match(r'^(\d+)(?:st|nd|rd|th)\s+XI$', designation, _re.I)
    if m:
        return f"{m.group(1)}s"
    if _re.match(r'^A\s+(?:XI|Team)$', designation, _re.I):
        return "A"
    # "Sunday 1st XI" etc.
    m = _re.match(r'^(.+?)\s+(\d+)(?:st|nd|rd|th)\s+XI$', designation, _re.I)
    if m:
        return f"{m.group(1)} {m.group(2)}s"
    # Strip trailing "XI" for anything else
    return _re.sub(r'\s+XI$', '', designation, flags=_re.I).strip()


def _abbrev_our_team(team):
    """Abbreviate our team to short form: '1st XI'→'1s', '2nd-xi'→'2s', 'A XI'→'A'."""
    if not team:
        return ""
    import re as _re
    # Display labels: "1st XI", "2nd XI", "A XI"
    m = _re.match(r'^(\d+)(?:st|nd|rd|th)\s+XI$', team, _re.I)
    if m:
        return f"{m.group(1)}s"
    if _re.match(r'^A\s+(?:XI|Team)$', team, _re.I):
        return "A"
    # Internal IDs: "1st-xi", "2nd-xi", "3rd-xi"
    m = _re.match(r'^(\d+)(?:st|nd|rd|th)-xi$', team, _re.I)
    if m:
        return f"{m.group(1)}s"
    if _re.match(r'^a-(?:xi|team)$', team, _re.I):
        return "A"
    return ""


def _fmt_match(team, opponents, home_away):
    """Format a match string: '1s vs Ballinger Waggoners Away'."""
    import re as _re
    opp = (opponents or "").strip()
    if " - " in opp:
        opp = opp.split(" - ")[0].strip()
    opp = _re.sub(r'\s+Cricket Club$', '', opp, flags=_re.I).strip()
    opp = _re.sub(r'\s+CC$', '', opp).strip()
    our_abbrev = _abbrev_our_team(team or "")
    ha = {"H": "Home", "A": "Away"}.get(home_away or "", "")
    parts = []
    if our_abbrev:
        parts.append(f"{our_abbrev} vs")
    parts.append(opp or "Unknown")
    if ha:
        parts.append(ha)
    return " ".join(parts)


def _fmt_opponents(club, opponents_team=None):
    """Format opponents display: strip CC suffix, append abbreviated team designation."""
    import re as _re
    name = (club or "").strip()
    # Strip ' - Nth XI' if present (Play Cricket full names)
    if " - " in name:
        name = name.split(" - ")[0].strip()
    # Strip common club suffixes
    name = _re.sub(r'\s+Cricket Club$', '', name, flags=_re.I).strip()
    name = _re.sub(r'\s+CC$', '', name).strip()
    desig = _abbrev_xi(opponents_team or "")
    return f"{name} {desig}".strip() if desig else name


def build_batting_honours(slide, historic_data, season_data):
    rows = slide.get("rows", 10)
    season_year = (season_data or {}).get("season")

    combined = []
    for r in (historic_data or {}).get("records", []):
        combined.append({**r, "is_season": False})
    for r in (season_data or {}).get("records", []):
        combined.append({**r, "is_season": True})

    def fmt(r):
        return {
            "batsman": r.get("batsman") or "",
            "score": r["score"],
            "not_out": bool(r.get("not_out")),
            "match": _fmt_match(r.get("team"), r.get("opponents"), r.get("home_away")),
            "year": str(r["year"]) if r.get("year") else "",
            "date": r.get("date"),
            "is_season": r.get("is_season", False),
        }

    formatted = [fmt(r) for r in combined if r.get("score") is not None]

    slide["_top_scores"] = sorted(
        formatted, key=lambda r: (-r["score"], r.get("date") or "")
    )[:rows]

    slide["_recent"] = sorted(
        [r for r in formatted if r.get("date")],
        key=lambda r: r["date"],
        reverse=True,
    )[:rows]

    from_year = slide.get("from_year") or min(
        (r["year"] for r in combined if r.get("year")), default=None
    )
    to_year = season_year or max(
        (r["year"] for r in combined if r.get("year")), default=None
    )
    if from_year:
        slide["_subtitle"] = f"Senior weekend cricket {from_year}–{to_year}"
    slide["_season_year"] = season_year


def build_bowling_honours(slide, historic_data, season_data):
    rows = slide.get("rows", 10)
    season_year = (season_data or {}).get("season")

    combined = []
    for r in (historic_data or {}).get("records", []):
        combined.append({**r, "is_season": False})
    for r in (season_data or {}).get("records", []):
        combined.append({**r, "is_season": True})

    def fmt(r):
        return {
            "bowler": r.get("bowler") or "",
            "wickets": r["wickets"],
            "runs": r["runs"],
            "match": _fmt_match(r.get("team"), r.get("opponents"), r.get("home_away")),
            "year": str(r["year"]) if r.get("year") else "",
            "date": r.get("date"),
            "is_season": r.get("is_season", False),
        }

    formatted = [fmt(r) for r in combined if r.get("wickets") is not None]

    slide["_best_figures"] = sorted(
        formatted, key=lambda r: (-r["wickets"], r["runs"], r.get("date") or "")
    )[:rows]

    slide["_recent"] = sorted(
        [r for r in formatted if r.get("date")],
        key=lambda r: r["date"],
        reverse=True,
    )[:rows]

    from_year = slide.get("from_year") or min(
        (r["year"] for r in combined if r.get("year")), default=None
    )
    to_year = season_year or max(
        (r["year"] for r in combined if r.get("year")), default=None
    )
    if from_year:
        slide["_subtitle"] = f"Senior weekend cricket {from_year}–{to_year}"
    slide["_season_year"] = season_year


def build_honours(slide, bat_historic, bat_season, bowl_historic, bowl_season):
    """Combined batting + bowling honours: four panels in one carousel.

    Reuses the single-discipline builders on throwaway copies, then lifts their
    outputs onto the slide under distinct keys (the two `_recent` lists would
    otherwise collide). The shared `from_year`/`rows`/subtitle logic is identical
    across disciplines, so the batting subtitle stands in for both.
    """
    bat = dict(slide)
    build_batting_honours(bat, bat_historic, bat_season)
    bowl = dict(slide)
    build_bowling_honours(bowl, bowl_historic, bowl_season)

    slide["_top_scores"] = bat["_top_scores"]
    slide["_recent_hundreds"] = bat["_recent"]
    slide["_best_figures"] = bowl["_best_figures"]
    slide["_recent_wickets"] = bowl["_recent"]
    if bat.get("_subtitle") or bowl.get("_subtitle"):
        slide["_subtitle"] = bat.get("_subtitle") or bowl.get("_subtitle")
    slide["_season_year"] = bat.get("_season_year")


def generate_qr_data_url(url: str) -> str:
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/png;base64,{data}"


def _compose_icon(logo, size, pad_ratio, bg=(15, 35, 70)):
    """Centre the club logo on a navy square. pad_ratio is the fraction of the
    canvas left as margin on the tighter axis (maskable icons need more)."""
    from PIL import Image

    canvas = Image.new("RGBA", (size, size), bg + (255,))
    inner = int(size * (1 - 2 * pad_ratio))
    lw, lh = logo.size
    scale = min(inner / lw, inner / lh)
    new = logo.resize((max(1, round(lw * scale)), max(1, round(lh * scale))), Image.LANCZOS)
    canvas.alpha_composite(new, ((size - new.width) // 2, (size - new.height) // 2))
    return canvas


def build_pwa(env):
    """Generate home-screen icons and render the web manifest."""
    from PIL import Image

    config = load_config()
    preview_cfg = config.get("preview", {})

    logo = Image.open(ASSETS / "images" / "wcc-logo.png").convert("RGBA")
    icons_dir = SITE / "assets" / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)

    # (filename, size, pad_ratio) — maskable gets a wider safe margin so the
    # logo survives the platform's circle/squircle crop.
    for name, size, pad in [
        ("apple-touch-icon.png", 180, 0.14),
        ("icon-192.png", 192, 0.14),
        ("icon-512.png", 512, 0.14),
        ("icon-512-maskable.png", 512, 0.22),
    ]:
        _compose_icon(logo, size, pad).save(icons_dir / name)
    print("  assets/icons/*")

    manifest = env.get_template("manifest.webmanifest").render(preview=preview_cfg)
    (SITE / "manifest.webmanifest").write_text(manifest)
    print("  manifest.webmanifest")


def clean():
    """Empty site/ without removing site/ itself.

    Deleting the directory races Finder on macOS: with the folder open, a
    .DS_Store is recreated inside it mid-walk and `shutil.rmtree(SITE)` dies with
    "Directory not empty". Clearing the *contents* leaves nothing to race — a
    file that reappears afterwards just sits in an otherwise empty tree, which is
    exactly what a fresh build wants.
    """
    SITE.mkdir(parents=True, exist_ok=True)
    for child in SITE.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)


def video_fingerprint(url: str, start, end) -> str:
    """Manifest key for a clip — see scripts/clip_ids.py (shared with the sync)."""
    return clip_ids.fingerprint(url, start, end)


def _load_manifest() -> dict:
    if VIDEO_MANIFEST.exists():
        try:
            return json.loads(VIDEO_MANIFEST.read_text())
        except Exception:
            pass
    return {}


def _resolve_video(v: dict) -> tuple:
    """Return (src_url_or_None, duration_float) for a video config dict.

    Accepts either:
      {"src": "https://...", "duration": 180}  — direct R2/CDN URL
      {"url": "https://youtube...", "start": N, "end": N}  — manifest lookup
    """
    # Direct URL (manually uploaded to R2 or elsewhere)
    if "src" in v:
        dur = float(v.get("duration", 30.0))
        return v["src"], dur

    url = v.get("url", "")
    start = v.get("start")
    end = v.get("end")
    fallback_dur = float((end or 0) - (start or 0)) or 30.0
    if not url:
        return None, fallback_dur

    fp = video_fingerprint(url, start, end)
    manifest = _load_manifest()
    entry = manifest.get(fp)
    if entry:
        return entry["src"], float(entry.get("duration", fallback_dur))
    return None, fallback_dur


def slide_video_srcs(slide):
    """Ordered, resolved clip URLs for a slide (empty for non-video slides).

    These are the absolute R2 URLs the offline player precaches — see
    docs/player-offline-architecture.md. Kept in slide order so the precache
    denominator is deterministic.
    """
    return [v["_video_src"] for v in slide.get("videos", []) if v.get("_video_src")]


def build_video_slide(slide):
    """Resolve video clip paths and durations for template == 'video' slides."""
    videos = slide.get("videos", [])
    total_dur = 0.0
    for v in videos:
        src, dur = _resolve_video(v)
        v["_video_src"] = src
        v["_video_duration"] = dur
        total_dur += dur
    if not total_dur:
        total_dur = 30.0
    slide["duration"] = total_dur
    slide["panel_duration"] = total_dur + 30.0  # safety net; wcc-done fires first
    slide["_override_duration"] = True


def _named_atom(atom, phase, label):
    """Attach an atom's `phase`/`label`, omitting either when there is nothing to say.

    Absent rather than null so the published `_atoms` stay as small as they were —
    a 30-clip reel writes this 30 times — and so a consumer's `atom.get("phase")`
    reads the same either way.
    """
    if phase:
        atom["phase"] = phase
    if label and label != phase:
        atom["label"] = label
    return atom


def slide_atoms(slide, slug, panel_count, panel_duration):
    """The slide's atom list: every point a narrator or the compositor can stop on.

    An atom is `(slide, panel)` plus an optional card qualifier — see
    docs/narrated-decks.md. Published into slide_meta (and so into data.json) so
    that the derived timeline, the compositor and record mode all read counts and
    durations from the build, rather than inferring a panel count by dividing
    `duration` by `panel_duration` or waiting on the runtime `wcc-slide` handshake.

    A static slide gives one atom per panel, each holding `panel_duration`.

    A video slide gives one atom per clip, split at its card windows: the pad a
    card overlays becomes an atom of its own, so `next()` has somewhere to stop and
    the compositor has a segment to hold the last frame of. Clip atoms carry their
    media range (`src` plus `in`/`out` seconds within the R2 file); their durations
    come from the trim and never from `panel_duration`, which `build_video_slide`
    sets to `total + 30` as a safety net.

    A card atom's duration is the length of its window, i.e. the pad footage it
    overlays — which is what the wall plays, so a silent render of a reel is
    frame-for-frame what the screens show. That equals the card type's configured
    `dwell` unless the curation overlay overrode the pad for this clip.

    **Every atom is named**, because the editor tools address atoms and an atom the
    editor cannot name is one they cannot manage — "retake Fantasy League · Top
    Managers" has to be sayable. Two fields, both optional:

      * `phase` — the tab strip entry this atom sits under. One phase can span
        several atoms (Highlights, Batting and Bowling are all "1st Innings"), and
        a slide with no strip has none.
      * `label` — what this atom is *within* the phase, and the one the editor
        leads with. A carousel panel's own tab label; a set member's leaf level; a
        clip's ball narrative.

    Both come from `slide_title_parts` wherever the slide already has a header
    hierarchy, so an atom's name and the wall's header cannot drift apart.
    """
    parts = slide_title_parts(slide, slug)
    phase = parts[2] if len(parts) > 2 else None
    leaf = parts[3] if len(parts) > 3 else None

    if slide.get("template") != "video":
        # A carousel names its atoms from its own tab strip; anything else has one
        # atom, named by the finest header level it has (a set member's "Batting",
        # else its phase, else the slide's own title).
        labels = slide_panel_labels(slide)
        if not labels:
            labels = [leaf or phase or (parts[-1] if parts else slug)] * panel_count
        return [_named_atom({"panel": i, "duration": panel_duration},
                            phase, labels[i] if i < len(labels) else None)
                for i in range(panel_count)]

    atoms = []
    for i, v in enumerate(slide.get("videos") or []):
        src = v.get("_video_src")
        dur = round(float(v.get("_video_duration") or 0.0), 3)
        cards = {c.get("at"): c for c in (v.get("cards") or []) if c.get("window")}

        def _clamp(x):
            return round(min(max(float(x), 0.0), dur), 3)

        pre_end = _clamp(cards["pre"]["window"][1]) if "pre" in cards else 0.0
        post_start = _clamp(cards["post"]["window"][0]) if "post" in cards else dur
        post_start = max(post_start, pre_end)

        segments = [("pre", 0.0, pre_end), (None, pre_end, post_start),
                    ("post", post_start, dur)]
        segments = [seg for seg in segments if seg[2] - seg[1] > 0.001]
        # A clip whose pads swallow it whole (or that has no resolved duration)
        # still has to contribute exactly one atom, or the panel count is wrong.
        if not segments:
            segments = [(None, 0.0, dur)]

        # A clip's own name is its ball narrative ("Eashan Patel b Smith"), which is
        # what an editor scanning a reel's atoms recognises; the ordinal is the
        # fallback, and rides along regardless so two similar balls stay distinct.
        body = (v.get("body") or "").strip()
        clip_label = f"{i + 1}. {body}" if body else f"Clip {i + 1}"
        for card, a, b in segments:
            atom = {"panel": i, "duration": round(b - a, 3)}
            if card:
                atom["card"] = card
            if src:
                atom["media"] = {"src": src, "in": round(a, 3), "out": round(b, 3)}
            atoms.append(_named_atom(atom, phase or leaf, clip_label))
    return atoms


def slide_panel_labels(slide):
    """This slide's tab strip, as a list of panel labels — or None if it has no tabs.

    One panel per label, in render order, so the list *is* the panel count for every
    carousel template. `team` names its data-driven `_panels` keys through
    TEAM_PANEL_LABELS; the fixed carousels read straight off FIXED_PANEL_LABELS.

    Returns None for the two kinds of slide that have no such strip:
      * plain single-panel slides, and set members (whose strip is the *set's*
        phase list, rendered by `_set_header.html` and named by `_set_phases`);
      * video reels, whose atoms are clips rather than panels.
    """
    if slide.get("template") == "team":
        return [TEAM_PANEL_LABELS.get(k, k) for k in slide.get("_panels") or []]
    return FIXED_PANEL_LABELS.get(slide.get("template"))


def slide_title_parts(slide, slug):
    """The slide's header hierarchy, **as a list of levels**.

        ["Last Match", "1st XI", "1st Innings", "Batting"]
        ["Team Focus", "U13 Spitfires"]

    `slide_title` joins these with " · " for display. They are returned separately
    because levels 3 and 4 are the **phase** and the **leaf**, which is what the
    editor tools name atoms from — see `slide_atoms` and docs/narrated-decks.md.
    Deriving the wall's header, the deck row and the atom labels from this one
    function is what stops the three wordings drifting apart.

    Short lists are normal: a slide with no phase returns two levels. Reading the
    slide's own heading levels is what separates slides a bare ``title`` cannot,
    because that is exactly what those headings are there to do.

    Four levels, each skipped when the slide has no such thing:

    1. **Heading** and 2. **subheading** — whatever the slide puts in its header.
       Set members, next-match, the standalone result and the live slide all carry
       an explicit ``_set_title``/``_set_subtitle`` pair; ``team`` and ``schedule``
       carry ``_heading``/``_subheading`` (set alongside the template that renders
       them, so the literal lives in one place); the rest use ``title`` plus
       whichever subtitle field their template shows.
    3. **Phase** — the sequence strip's own entry (``_set_phases[_set_phase]``),
       or a reel's innings label, which is the phase it sits in. One phase can span
       several slides: Highlights, Batting and Bowling are all "1st Innings".
    4. **Leaf** — what this slide is *within* the phase: a scorecard's ``_mode``, or
       a reel's Highlights. Without it a batting and a bowling card read identically.
    """
    parts = []

    if slide.get("_set_title"):
        parts += [slide["_set_title"], slide.get("_set_subtitle")]
    elif slide.get("_heading"):
        parts += [slide["_heading"], slide.get("_subheading")]
    else:
        parts.append(slide.get("title") or slug)
        # Whichever field this template renders under the title. league-table shows
        # the division, which is the half that separates the 1st and 2nd XI tables
        # (both titled with the league).
        sub = slide.get("subtitle") or slide.get("_subtitle")
        if not sub and slide.get("template") == "league-table":
            tables = (slide.get("_data") or {}).get("league_table") or []
            sub = tables[0].get("name") if tables else None
        # Some authored subtitles are prose, not a heading level ("Interested in
        # joining the club? We have options for everyone."). A label identifies;
        # a sentence just fills the row. The title alone already separates these,
        # since they are hand-written one-offs.
        if sub and (len(sub) > 48 or "." in sub):
            sub = None
        parts.append(sub)

    phases = slide.get("_set_phases")
    idx = slide.get("_set_phase")
    if phases and idx is not None and 0 <= idx < len(phases):
        parts.append(phases[idx])
    elif slide.get("_innings_label"):
        parts.append(slide["_innings_label"])

    # `_mode` is scorecard-only here: build_schedule uses the same key for a
    # display mode ("team" / "location"), which is not a heading level.
    if slide.get("template") == "scorecard" and slide.get("_mode"):
        parts.append(slide["_mode"].capitalize())
    elif slide.get("reel"):
        parts.append("Highlights")

    return [str(p).strip() for p in parts if p and str(p).strip()]


def slide_title(slide, slug):
    """The slide's header hierarchy, dot-joined — its label everywhere off-wall.

        Last Match · 1st XI · 1st Innings · Batting
        Leaderboards · 1st XI League · 2026

    The deck builder shows this instead of a template name, so it has to *identify*
    a slide, not merely describe it — and a bare ``title`` does not: the club runs
    five per-team slides (team, schedule, next-match, league-table, latest result)
    all titled e.g. "U13 Spitfires", and thirteen titled "Leaderboards".
    """
    return " · ".join(slide_title_parts(slide, slug)) or slug


def _curation_scorecards():
    """Index the recent scorecards in fixtures.json by match_id (as a string).

    Draws from both ``last_match`` (one per team) and ``recent_matches`` (a list
    per team), so a just-played match can be looked up while it's still in the
    retention window. Older matches roll off — callers fall back to the roster.

    Each entry is ``(scorecard, team_id)``: the team is what a card's season-form
    figures are resolved against (``get_leaderboard_block(p, team_id, None)``), so
    the catalogue needs it alongside the scorecard, and only these two indexes know
    which team's match this was.
    """
    path = FETCHED / "fixtures.json"
    if not path.exists():
        return {}
    try:
        fx = json.loads(path.read_text())
    except Exception:
        return {}
    by_id = {}
    for team_id, last in (fx.get("last_match") or {}).items():
        mid = last.get("match_id")
        if mid is not None:
            by_id[str(mid)] = (last, team_id)
    for team_id, recents in (fx.get("recent_matches") or {}).items():
        for sc in recents or []:
            mid = sc.get("match_id")
            if mid is not None:
                by_id.setdefault(str(mid), (sc, team_id))
    return by_id


def _match_squad(scorecard):
    """Wendover players who appeared in a match, for the role-tag picker.

    ``our_batting`` + ``our_bowling`` are always Wendover; for an intra-club game
    the opposition is also Wendover, so ``their_*`` count too. Returns names in a
    stable, de-duplicated order, or ``[]`` when no scorecard is available.
    """
    if not scorecard:
        return []
    blocks = ["our_batting", "our_bowling"]
    if "wendover" in (scorecard.get("opposition_club_name") or "").lower():
        blocks += ["their_batting", "their_bowling"]
    seen, squad = set(), []
    for key in blocks:
        for row in scorecard.get(key) or []:
            name = (row.get("name") or "").strip()
            if name and name not in seen:
                seen.add(name)
                squad.append(name)
    squad.sort()
    return squad


def _card_catalogue(pc_id, scorecard, team_id, stats, roster, card_types):
    """Pre-resolve every (card type, player) pair this match could produce.

    The ``/curate`` picker only records *intent* — a type and a subject — while the
    figures are resolved at build time by ``ball_events``. That gap is the problem:
    an editor can pick (and narrate over) a card whose subject won't resolve, and only
    find out when the render drops it. The subject space is small and knowable
    (two card types x the players in the two XIs), so the build walks it and publishes
    the answers; see docs/narrated-decks.md.

    Keyed by ``ball_events.catalogue_key`` rather than by the picked name, because the
    same person reaches a card as a roster name ("Solomon Methari") or an abbreviated
    scorecard one ("S Methari"). The entry is exactly what the reel will render, so the
    picker shows the real figures and the resolved *name* — which is also how a
    (surname, initial) mismatch becomes visible at pick time.
    """
    # Candidates: everyone the picker can offer (the whole club roster, plus any
    # off-roster subject a scorecard names — an opposition batter is a legitimate
    # dismissal-card subject).
    names_by_source = [[r["name"] for r in roster]]
    for key in ("our_batting", "their_batting", "our_bowling", "their_bowling"):
        names_by_source.append([(row.get("name") or "").strip()
                                for row in (scorecard or {}).get(key) or []])
    names = [n for src in names_by_source for n in src]

    subjects = {}
    for name in names:
        key = ball_events.catalogue_key(name)
        if key:
            subjects.setdefault(key, name)

    cards = {}
    for ct in card_types:
        key_ = ct.get("key")
        if not key_:
            continue
        resolved = {}
        for subject_key, name in subjects.items():
            content = ball_events.resolve_card(key_, name, scorecard=scorecard,
                                               player_stats=stats, team_id=team_id)
            if content:
                resolved[subject_key] = content
        cards[key_] = resolved

    return {"pc_match_id": str(pc_id), "team": team_id, "cards": cards,
            # With no scorecard (the match has rolled out of fixtures.json) nothing
            # resolves, and an empty catalogue must not read as "every card is
            # unresolvable" — the picker falls back to offering everything.
            "available": bool(scorecard and team_id),
            "ambiguous": _ambiguous_keys(names_by_source)}


def _ambiguous_keys(sources):
    """Keys carrying two different people *within one* candidate source.

    The card resolvers match on (surname, first initial) and take the first row that
    matches, so two players sharing a key is a silent wrong-person risk. Compared
    within a source, never across them: the roster's "Solomon Methari" and the
    scorecard's "S Methari" share a key precisely because they are the same person,
    which is the whole point of the key.
    """
    out = set()
    for names in sources:
        by_key = {}
        for name in names:
            key = ball_events.catalogue_key(name)
            if key:
                by_key.setdefault(key, set()).add(name)
        out |= {k for k, v in by_key.items() if len(v) > 1}
    return sorted(out)


def build_deck_builder(env):
    """Publish the deck builder at /deck/ (unlisted, noindex).

    Phase 6b of docs/narrated-decks.md. Nothing is baked in: the page reads
    ``/slides.json`` for the catalogue and ``/slideshow/<slug>/data.json`` for the
    slide entries it inserts, so this step is one template render. That is the
    point of the catalogue — a slide entry keeps exactly one definition, written by
    the build and never reconstructed in JS.
    """
    out_dir = SITE / "deck"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(env.get_template("deck/index.html").render())
    print("  deck builder → /deck/")


def build_narrate(env):
    """Publish the narration review workbench at /narrate/ (unlisted, noindex).

    Phase 7 of docs/narrated-decks.md. Like the deck builder, nothing is baked in:
    the page reads the take out of the browser (``take-store.js``) and the deck it
    was recorded over out of the deck store, so this step is one template render.

    Narration is two surfaces and conflating them is the trap the design warns
    about: *recording* is the deck with a HUD over it and lives in the player
    (``?record``); *review* is a table over a waveform and lives here.
    """
    out_dir = SITE / "narrate"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(env.get_template("narrate/index.html").render())
    print("  narration review → /narrate/")


def build_curation(env):
    """Publish the ball-events curation tool at /curate/ (unlisted, noindex).

    Exposes each fetched match's raw events plus any committed curation overlay
    as JSON the page loads, then renders the page. With no fetched match data the
    step is a no-op (the tool only matters once fetch_ball_events.py has run).
    """
    raw_files = sorted(FETCHED_MATCHES.glob("*.json")) if FETCHED_MATCHES.exists() else []
    if not raw_files:
        return
    out_dir = SITE / "curate"
    data_dir = out_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    # Scorecards + the team they belong to, keyed by match_id, so each match's
    # role-tag player list is the actual playing XI (from Play Cricket) rather than
    # the whole club roster, and its cards resolve against the right team.
    scorecards = _curation_scorecards()

    # Season stats: the club roster for the "add player" picker, and the source the
    # new-batsman card's form line is resolved from.
    stats_path = FETCHED / "player_stats_this_season.json"
    stats = None
    roster = []
    if stats_path.exists():
        try:
            stats = json.loads(stats_path.read_text())
            players = stats.get("players", {})
            seen = set()
            for p in (players.values() if isinstance(players, dict) else players):
                name = (p.get("name") or "").strip()
                if name and name not in seen:
                    seen.add(name)
                    roster.append({"name": name, "teams": p.get("teams") or []})
            roster.sort(key=lambda r: r["name"])
        except Exception:
            stats, roster = None, []

    card_types = load_config().get("card_types") or []
    cards_dir = out_dir / "cards"
    cards_dir.mkdir(parents=True, exist_ok=True)

    index, n_cards = [], 0
    for f in raw_files:
        try:
            data = json.loads(f.read_text())
        except Exception:
            continue
        pc_id = data.get("pc_match_id") or f.stem
        overlay_path = CURATION_DIR / f"{pc_id}.curation.json"
        overlay = {}
        if overlay_path.exists():
            try:
                overlay = json.loads(overlay_path.read_text())
            except Exception:
                overlay = {}
        data["curation"] = overlay
        scorecard, team_id = scorecards.get(str(pc_id)) or (None, None)
        data["squad"] = _match_squad(scorecard)
        (data_dir / f"{pc_id}.json").write_text(json.dumps(data))
        catalogue = _card_catalogue(pc_id, scorecard, team_id, stats, roster, card_types)
        (cards_dir / f"{pc_id}.json").write_text(json.dumps(catalogue))
        n_cards += sum(len(v) for v in catalogue["cards"].values())
        index.append({
            "pc_match_id": pc_id,
            "team": data.get("team"),
            "date": data.get("date"),
            "competition": data.get("competition"),
            "home_name": data.get("home_name"),
            "away_name": data.get("away_name"),
            # Hand-added clips live only in the overlay, so count them too — the
            # picker's tally should match what the page actually lists.
            "n_events": len(data.get("events", [])) + sum(
                1 for v in overlay.values() if isinstance(v, dict) and v.get("manual")),
        })
    index.sort(key=lambda m: (m.get("date") or ""), reverse=True)
    (out_dir / "matches.json").write_text(json.dumps(index))

    (out_dir / "roster.json").write_text(json.dumps(roster))

    # Card registry (types + default pad seconds) — the single source of truth the
    # page's card pickers read, so the JS never hard-codes the defaults that
    # ball_events.py also relies on.
    (out_dir / "card_types.json").write_text(json.dumps(card_types))

    (out_dir / "index.html").write_text(env.get_template("curate/index.html").render())
    print(f"  curation: {len(index)} match(es), {n_cards} pre-resolved card(s) → /curate/")


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
    env.filters["drop_cc"] = drop_cc
    sponsor_dir = ASSETS / "images" / "sponsors"
    env.globals["sponsors"] = [
        {"name": p.stem.replace("-", " ").title(), "src": f"/assets/images/sponsors/{p.name}"}
        for p in sorted(sponsor_dir.glob("*.*"))
        if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".svg"}
    ]
    # Sidebar sponsor rail: one random order per build, so no sponsor is
    # permanently stuck at the bottom of the strip. Shuffled once (not per
    # slide) so the rail stays put as the show advances.
    sidebar_sponsors = list(env.globals["sponsors"])
    random.shuffle(sidebar_sponsors)
    env.globals["sidebar_sponsors"] = sidebar_sponsors
    # Display form of the site URL (no scheme/trailing slash), shown under the
    # club name in slide footers/sidebars and on the home page.
    site_url = load_config().get("preview", {}).get("site_url", "")
    env.globals["site_url"] = site_url.split("//")[-1].rstrip("/")
    # Master switch for the live-match feature set. Templates gate the endpoint-
    # touching bits (poller wiring, ticker/flash overlays, standalone self-poll)
    # on this; the build gates the live-* emitters on the Python-side value below.
    env.globals["live_enabled"] = load_config().get("live_enabled", False)
    # Cache-busting stamp on every /assets/js URL. GitHub Pages serves HTML with
    # max-age=600 but assets with max-age=14400, so without this a client can pair
    # fresh HTML against four-hour-stale JS — and the moment a template depends on a
    # new function in a shared script, that pairing throws and takes the whole page
    # down (it did: the windowing deploy blanked the iOS PWA). One stamp per build,
    # so a deploy invalidates the scripts in lockstep with the pages that use them.
    env.globals["asset_version"] = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return env


def load_teams():
    teams_path = CONTENT / "teams.json"
    if not teams_path.exists():
        return {}
    teams = json.loads(teams_path.read_text())["teams"]
    return {t["id"]: t for t in teams}


def build_league_positions(slide, teams_by_id, stats_data):
    form = stats_data.get("form", {}) if stats_data else {}
    rows = []
    for team_id in slide.get("teams", []):
        team = teams_by_id.get(team_id)
        if not team or "play_cricket_league_id" not in team:
            continue
        data_path = FETCHED / f"league_table_{team['play_cricket_league_id']}.json"
        if not data_path.exists():
            continue
        data = json.loads(data_path.read_text())
        table = data.get("league_table", [{}])[0]
        values = table.get("values", [])
        headings = table.get("headings", {})
        pts_col = next((k for k, v in headings.items() if v.lower() == "pts"), None)

        leader_pts = 0
        if pts_col and values:
            leader_pts = max(int(r.get(pts_col) or 0) for r in values)

        team_row = next((r for r in values if str(r.get("team_id")) == str(team["play_cricket_team_id"])), None)
        if not team_row:
            continue

        team_pts = int(team_row.get(pts_col) or 0) if pts_col else 0
        pts_gap = leader_pts - team_pts
        pts_pct = round(team_pts / leader_pts * 100) if leader_pts > 0 else 0

        rows.append({
            "name": team["name"],
            "league_name": table.get("name", ""),
            "played": team_row.get("column_2", "0"),
            "won": team_row.get("column_3", "0"),
            "lost": team_row.get("column_4", "0"),
            "cancelled": team_row.get("column_5", "0"),
            "abandoned": team_row.get("column_6", "0"),
            "is_top": pts_gap == 0 and leader_pts > 0,
            "form": (form.get(team_id) or {}).get(str(team["play_cricket_league_id"]), (form.get(team_id) or {}).get("all", []))[-5:],
            "pts_gap": pts_gap,
            "pts_pct": pts_pct,
            "leader_pts": leader_pts,
        })
    slide["_rows"] = rows


def fmt_match_date(date_str):
    """Format 'DD/MM/YYYY' as 'Saturday 17 May 2026'."""
    try:
        dt = datetime.strptime(date_str, "%d/%m/%Y")
        return dt.strftime(f"%A {dt.day} %B %Y")
    except (ValueError, TypeError):
        return date_str


def build_schedule(slide, teams_by_id, training_sessions, all_fixtures, location_lookup, location_names):
    # The slide's two header levels, as data. The template used to hard-code the
    # subtitle; it lives here so slide_title can name the slide the way the slide
    # names itself, with no second copy of the string (see slide_title).
    slide["_heading"] = slide.get("title")
    slide["_subheading"] = "Fixtures & Training"
    today_iso = _today().isoformat()

    def fmt_date(iso_date):
        try:
            d = datetime.strptime(iso_date, "%Y-%m-%d")
            return d.strftime(f"%a {d.day} %b")
        except (ValueError, TypeError):
            return iso_date or ""

    def week_key(iso_date):
        if not iso_date:
            return ""
        try:
            d = datetime.strptime(iso_date, "%Y-%m-%d").date()
            cal = d.isocalendar()
            return f"{cal[0]}-W{cal[1]:02d}"
        except (ValueError, TypeError):
            return ""

    def match_iso_date(match_date_str):
        try:
            return datetime.strptime(match_date_str, "%d/%m/%Y").date().isoformat()
        except (ValueError, TypeError):
            return None

    def make_match_event(match, team_id):
        iso_date = match_iso_date(match.get("match_date", ""))
        is_home = match.get("is_home", True)
        club = match.get("opposition_club_name", "")
        team_desig = match.get("opposition_team_name", "")
        opp_display = club or team_desig
        ground = match.get("ground_name") or ""
        loc_id = location_lookup.get(ground.lower())
        team = teams_by_id.get(team_id, {})
        return {
            "date": iso_date,
            "date_display": fmt_date(iso_date),
            "week": week_key(iso_date),
            "time": match.get("match_time") or None,
            "type": "match",
            "title": f"vs {opp_display}",
            "team_ids": [team_id],
            "team_names": [team.get("name", team_id)],
            "location": location_names.get(loc_id, ground),
            "location_id": loc_id,
            "is_home": is_home,
            "competition": match.get("competition_name", ""),
        }

    def make_training_event(session):
        loc_id = session.get("location_id")
        return {
            "date": session.get("date"),
            "date_display": fmt_date(session.get("date")),
            "week": week_key(session.get("date")),
            "time": session.get("time_start"),
            "type": "training",
            "title": session.get("title", "Training"),
            "team_ids": session.get("team_ids", []),
            "team_names": [
                teams_by_id[tid]["name"] for tid in session.get("team_ids", [])
                if tid in teams_by_id
            ],
            "location": location_names.get(loc_id, session.get("location", "")),
            "location_id": loc_id,
            "is_home": None,
            "competition": "",
        }

    def build_events(raw, limit=12, max_rows=15):
        future = [e for e in raw if e.get("date") and e["date"] >= today_iso]
        future.sort(key=lambda e: (e["date"], e.get("time") or ""))
        shown = future[:limit]
        if shown and len(future) > limit:
            last_date = shown[-1]["date"]
            for e in future[limit:max_rows]:
                if e["date"] == last_date:
                    shown.append(e)
                else:
                    break
        return shown, max(0, len(future) - len(shown))

    teams_raw = slide.get("teams") or slide.get("team")
    if isinstance(teams_raw, str):
        team_ids_list = [teams_raw]
    elif isinstance(teams_raw, list):
        team_ids_list = teams_raw
    else:
        team_ids_list = []
    loc_id = slide.get("location")

    slide["_multi_team"] = len(team_ids_list) > 1

    if team_ids_list:
        slide["_mode"] = "team"
        raw = []
        seen_sessions = set()
        for s in training_sessions:
            if any(tid in s.get("team_ids", []) for tid in team_ids_list):
                sid = s.get("session_id")
                if sid in seen_sessions:
                    continue
                seen_sessions.add(sid)
                raw.append(make_training_event(s))
        for team_id in team_ids_list:
            for m in all_fixtures.get(team_id, []):
                raw.append(make_match_event(m, team_id))
    elif loc_id:
        slide["_mode"] = "location"
        slide["_multi_team"] = False
        raw = []
        for s in training_sessions:
            if s.get("location_id") == loc_id:
                raw.append(make_training_event(s))
        for tid, matches in all_fixtures.items():
            for m in matches:
                if not m.get("is_home"):
                    continue
                if location_lookup.get((m.get("ground_name") or "").lower()) != loc_id:
                    continue
                raw.append(make_match_event(m, tid))
    else:
        slide["_mode"] = "team"
        slide["_multi_team"] = False
        raw = []

    events, more_count = build_events(raw)
    slide["_events"] = events
    slide["_more_count"] = more_count


def build_next_match(slide, teams_by_id, fixtures_data, stats_data):
    """Populate the Next Match preview: the spoiler-free pre-match tale of the
    tape, mirroring the last-match intro (crest, pre-match form and season top
    performers each side) but rendered standalone — no sequence strip and no
    league table (the league lives on its own slides). Renders through the shared
    _tape partial via next-match.html.

    The opposition crest is only scraped for completed matches (from the match
    page), so previews carry our crest and leave the opposition side crest-less.
    """
    team_id = slide.get("team")
    team = teams_by_id.get(team_id, {})
    fixture = (fixtures_data or {}).get("fixtures", {}).get(team_id)

    # Header levels first, so they survive the no-fixture early return: that branch
    # renders its own header (there is no tape to hang the shared one off), and the
    # slide still needs naming in the catalogue.
    slide["_set_title"] = "Next Match"
    slide["_set_subtitle"] = slide.get("title", "")

    if not fixture:
        slide["_no_fixture"] = True
        return
    slide["_no_fixture"] = False

    title = slide.get("title", "")
    opp_club, opp_team = _split_opp_name(
        fixture.get("opposition_name", ""), fixture.get("opposition_club_name", "")
    )

    # Right-hand meta date: short weekday + day + month, with the start time
    # appended (a preview wants the throw-up time, unlike the last-match header).
    iso = _iso_from_dmy(fixture.get("match_date", ""))
    if iso:
        _dt = datetime.strptime(iso, "%Y-%m-%d")
        date_short = _dt.strftime(f"%a {_dt.day} %b")
    else:
        date_short = ""
    if fixture.get("match_time"):
        date_short = f"{date_short} · {fixture['match_time']}".lstrip(" ·")

    # Footer division line: league name, plus the competition when it differs.
    league_name = team.get("league_name", "")
    comp_name = fixture.get("competition_name", "") or ""
    if league_name and comp_name and comp_name != league_name:
        competition_display = f"{league_name} · {comp_name}"
    else:
        competition_display = league_name or comp_name

    # `all` holds 6 for the last-match drop-this-match preview; a next match has
    # nothing to drop, so show the most recent 5 as they stand.
    our_form = ((stats_data or {}).get("form", {}).get(team_id, {}).get("all", []))[-5:]

    slide.update({
        "_set_title": "Next Match",
        "_set_subtitle": title,
        "_set_date": date_short,
        "_set_is_home": fixture.get("is_home", True),
        "_set_opp_club": opp_club,
        "_set_opp_team": opp_team,
        "_set_ground": fixture.get("ground_name") or "",
        # Tale of the tape. Home team on the left, as the last-match intro.
        "_our_left": fixture.get("is_home", True),
        "_our_crest": "/assets/images/wcc-logo.png",
        "_our_form": our_form,
        "_our_performers": team_current_performers(stats_data, team_id),
        "_opp_crest": None,
        "_opp_club_name": opp_club,
        "_opp_form": fixture.get("opposition_form") or [],
        "_opp_performers": opp_preview_performers(fixture.get("opposition_players")),
        "_division": competition_display,
        "_toss": "",   # no toss before the match
        "_h2h": "",
    })


def format_dismissal(how_out, fielder_name="", bowler_name=""):
    s = (how_out or "").strip()
    sl = s.lower()
    fielder = (fielder_name or "").strip()
    bowler = (bowler_name or "").strip()

    if not sl or sl in ("not out", "no"):
        return "not out"
    if sl in ("did not bat", "dnb"):
        return "dnb"
    if sl.startswith("retired"):
        return s

    if sl == "ct":
        base = f"c {fielder}" if fielder else "caught"
        return f"{base} b {bowler}" if bowler else base
    if sl in ("c&b", "caught and bowled"):
        return f"c&b {bowler}" if bowler else "c&b"
    if sl == "b":
        return f"b {bowler}" if bowler else "bowled"
    if sl == "lbw":
        return f"lbw b {bowler}" if bowler else "lbw"
    if sl == "st":
        base = f"st {fielder}" if fielder else "stumped"
        return f"{base} b {bowler}" if bowler else base
    if "run out" in sl:
        return f"run out ({fielder})" if fielder else "run out"
    if sl in ("hit wicket", "hw"):
        return f"hit wkt b {bowler}" if bowler else "hit wicket"
    return s


def fmt_innings_total(total):
    if not total:
        return ""
    runs = total.get("runs", 0)
    wickets = total.get("wickets") or None
    overs = total.get("overs") or ""
    if wickets is None:
        score = str(runs)
    elif int(wickets) >= 10:
        score = f"{runs} ao"
    else:
        score = f"{runs}/{int(wickets)}"
    if overs:
        return f"{score} ({overs} ovs)"
    return score


def fmt_innings_readable(total):
    """Human-readable innings score, e.g. '280 for 7 off 45.0 overs',
    '141 all out off 32.1 overs', '164 off 20.0 overs' (no wickets given)."""
    if not total:
        return ""
    runs = total.get("runs", 0)
    wickets = total.get("wickets")
    overs = total.get("overs") or ""
    if wickets is None or wickets == "":
        score = f"{runs}"
    elif int(wickets) >= 10:
        score = f"{runs} all out"
    else:
        score = f"{runs} for {int(wickets)}"
    return f"{score} off {overs} overs" if overs else score


def innings_extras(total, batting_rows):
    """Extras total for the innings. Prefers the fetched breakdown's `total`;
    falls back to (innings total − runs off the bat) for older data without a
    breakdown. None if not derivable."""
    if not total:
        return None
    ex = total.get("extras") or {}
    if ex.get("total") is not None:
        return int(ex["total"])
    if not batting_rows:
        return None
    try:
        return max(0, int(total.get("runs") or 0) - sum(int(b.get("runs") or 0) for b in batting_rows))
    except (ValueError, TypeError):
        return None


# Scorecard extras notation, in the conventional order, omitting zero components.
_EXTRAS_LABELS = [("byes", "b"), ("leg_byes", "lb"), ("wides", "w"),
                  ("no_balls", "nb"), ("penalty", "p")]


def extras_breakdown_str(total):
    """"b 13, lb 1, w 10, nb 1" from a fetched innings total's breakdown. Empty
    string when no breakdown is present or every component is zero."""
    ex = (total or {}).get("extras") or {}
    parts = [f"{abbr} {ex[key]}" for key, abbr in _EXTRAS_LABELS if ex.get(key)]
    return ", ".join(parts)


def team_performers(batting, bowling, opp_batting, max_extra=2):
    """A team's headline performers from its own card: best batting + best bowling
    always, then up to `max_extra` other notable ones (50+, 3+ wkt hauls, multi-
    dismissal fielders). `opp_batting` is the batting card of the side this team
    fielded against, used to credit fielders. Each is a highlight dict as built by
    `_bat_highlight`/`_bowl_highlight`."""
    bats = [b for b in (batting or []) if (b.get("runs") or 0) > 0 or (b.get("balls") or 0) > 0]
    bowls = [b for b in (bowling or []) if (b.get("wickets") or 0) > 0 or (b.get("balls") or 0) > 0]

    # Best batting + best bowling always shown (an all-rounder can appear as both).
    out = []
    if bats:
        out.append(_bat_highlight("best_bat", max(bats, key=lambda b: (b.get("runs") or 0, -(b.get("balls") or 0)))))
    if bowls:
        out.append(_bowl_highlight("best_bowl", min(bowls, key=lambda b: (-(b.get("wickets") or 0), b.get("runs") or 0))))
    seen = {(h.get("name") or "").strip() for h in out}

    def add(hl):
        name = (hl.get("name") or "").strip()
        if name and name not in seen:
            out.append(hl)
            seen.add(name)

    notable = []
    for b in sorted(bats, key=lambda x: x.get("runs") or 0, reverse=True):
        if (b.get("runs") or 0) >= 50:
            notable.append(_bat_highlight("fifty", b))
    for b in sorted(bowls, key=lambda x: (x.get("wickets") or 0, -(x.get("runs") or 0)), reverse=True):
        if (b.get("wickets") or 0) >= 3:
            notable.append(_bowl_highlight("haul", b))
    # Fielders with 2+ dismissals, formatted like the fantasy 'Top players' cell
    # (e.g. '3c 1ro' — catches / run-outs / stumpings, zeros omitted).
    fielders = {}
    for bat in (opp_batting or []):
        ho = (bat.get("how_out") or "").strip().lower()
        fielder = (bat.get("fielder_name") or "").strip()
        if not fielder:
            continue
        key = "c" if ho == "ct" else "st" if ho == "st" else "ro" if "run out" in ho else None
        if not key:
            continue
        f = fielders.setdefault(fielder, {"c": 0, "ro": 0, "st": 0, "n": 0})
        f[key] += 1
        f["n"] += 1
    for name, f in sorted(fielders.items(), key=lambda x: x[1]["n"], reverse=True):
        if f["n"] >= 2:
            figure = " ".join(f"{f[k]}{k}" for k in ("c", "ro", "st") if f[k])
            notable.append({"kind": "fielding", "category": "field", "name": name, "primary": figure, "secondary": ""})

    for hl in notable:
        if len(out) >= 2 + max_extra:
            break
        add(hl)
    # Batters above bowlers above fielders (stable sort keeps best-first per group).
    out.sort(key=lambda h: {"bat": 0, "bowl": 1, "field": 2}.get(h.get("category"), 3))
    return out


_RESULT_LABELS = {
    "W": "Won", "L": "Lost", "D": "Drew", "T": "Tied",
    "A": "Abandoned", "C": "Cancelled", "NR": "No Result",
}


def _fmt_batting_rows(rows):
    out = []
    for b in rows:
        balls = b.get("balls") or 0
        runs = b.get("runs") or 0
        out.append({**b,
            "how_out_abbr": format_dismissal(
                b.get("how_out", ""), b.get("fielder_name", ""), b.get("bowler_name", ""),
            ),
            "fours": b.get("fours", 0),
            "sixes": b.get("sixes", 0),
            "strike_rate": f"{runs / balls * 100:.0f}" if balls else None,
        })
    return out


def _fmt_bowling_rows(rows):
    return [
        {**b, "overs_str": balls_to_overs(b["balls"]), "maidens": b.get("maidens", 0)}
        for b in rows
    ]


def _iso_from_dmy(s):
    try:
        return datetime.strptime(s, "%d/%m/%Y").date().isoformat()
    except (ValueError, TypeError):
        return None


def _plus_days(iso_date, days):
    """ISO date `days` later — the last day an expiring slide still shows."""
    if not iso_date:
        return None
    return (date.fromisoformat(iso_date) + timedelta(days=days)).isoformat()


def _fmt_date_past(iso_date):
    try:
        d = datetime.strptime(iso_date, "%Y-%m-%d")
        return d.strftime(f"%a {d.day} %b").upper()
    except (ValueError, TypeError):
        return (iso_date or "").upper()


def _fmt_date_future(iso_date, today):
    try:
        d = datetime.strptime(iso_date, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return (iso_date or "").upper()
    delta = (d - today).days
    if delta == 0:
        return "TODAY"
    if delta == 1:
        return "TOMORROW"
    return datetime.combine(d, datetime.min.time()).strftime(f"%a {d.day} %b").upper()


def _split_innings_total(total):
    """(score, overs) — e.g. ("184/7", "45.0"). Split because the two want
    different type where they're shown together: the score is the headline, the
    overs are supporting detail in the smaller muted style. Either may be "".
    """
    if not total:
        return "", ""
    runs = total.get("runs", 0)
    wickets = total.get("wickets") or None
    if wickets is None:
        score = str(runs)
    elif int(wickets) >= 10:
        score = f"{runs} ao"
    else:
        score = f"{runs}/{int(wickets)}"
    return score, str(total.get("overs") or "")


def _short_innings_total(total):
    """The two joined into one string, for places that render a plain score."""
    score, overs = _split_innings_total(total)
    return f"{score} ({overs})" if overs else score


def result_summary(result, our_total, their_total, we_bat_first, our_club, opp_club):
    """Human-readable match outcome, e.g. "Denham CC won by 139 runs" or
    "Wendover CC won by 4 wickets". The margin type depends on which side the
    winner batted: defending a total reads in runs, chasing reads in wickets.
    Non-decision results get a plain phrase; "" when not derivable."""
    plain = {"T": "Match tied", "D": "Match drawn", "A": "Match abandoned",
             "C": "No result", "NR": "No result"}
    if result in plain:
        return plain[result]
    if result not in ("W", "L") or not our_total or not their_total:
        return ""
    we_won = result == "W"
    winner_club = our_club if we_won else opp_club
    winner_total = our_total if we_won else their_total
    loser_total = their_total if we_won else our_total
    winner_bat_first = we_bat_first if we_won else not we_bat_first
    try:
        if winner_bat_first:
            margin = int(winner_total.get("runs") or 0) - int(loser_total.get("runs") or 0)
            unit = "run" if margin == 1 else "runs"
        else:
            margin = 10 - int(winner_total.get("wickets") or 0)
            unit = "wicket" if margin == 1 else "wickets"
    except (ValueError, TypeError):
        return ""
    if margin <= 0:
        return ""
    return f"{winner_club} won by {margin} {unit}"


def _bat_highlight(kind, b):
    parts = []
    if b.get("balls"):
        parts.append(f"{b['balls']} balls")
    if b.get("fours"):
        parts.append(f"{b['fours']} fours")
    if b.get("sixes"):
        parts.append(f"{b['sixes']} sixes")
    return {
        "kind": kind,
        "category": "bat",
        "name": b.get("name", ""),
        "primary": f"{b.get('runs', 0)}{'*' if b.get('not_out') else ''}",
        "secondary": " · ".join(parts),
    }


def _bowl_highlight(kind, b):
    parts = [f"{balls_to_overs(b.get('balls', 0) or 0)} overs"]
    maidens = b.get("maidens") or 0
    if maidens:
        parts.append(f"{maidens} maiden{'s' if maidens != 1 else ''}")
    return {
        "kind": kind,
        "category": "bowl",
        "name": b.get("name", ""),
        "primary": f"{b.get('wickets', 0)}–{b.get('runs', 0)}",
        "secondary": " · ".join(parts),
    }


def _select_match_highlights(scorecard, max_hl=2):
    """Return up to max_hl highlight dicts for Wendover's performance in a match.

    Each Wendover player appears at most once, even when they qualify under
    multiple priority rules (e.g. a 5fer also clears the tight-spell threshold).
    """
    our_bat = scorecard.get("our_batting", []) or []
    our_bowl = scorecard.get("our_bowling", []) or []
    their_bat = scorecard.get("their_batting", []) or []

    out = []
    seen = set()

    def add(highlight):
        name = (highlight.get("name") or "").strip()
        if not name or name in seen:
            return False
        out.append(highlight)
        seen.add(name)
        return True

    five_fers = sorted(
        [b for b in our_bowl if b.get("wickets", 0) >= 5],
        key=lambda x: (x["wickets"], -x["runs"]),
        reverse=True,
    )
    for b in five_fers:
        if len(out) >= max_hl:
            break
        add(_bowl_highlight("5fer", b))

    centuries = sorted(
        [b for b in our_bat if b.get("runs", 0) >= 100],
        key=lambda x: x["runs"],
        reverse=True,
    )
    for b in centuries:
        if len(out) >= max_hl:
            break
        add(_bat_highlight("century", b))

    if len(out) < max_hl:
        four_fers = sorted(
            [b for b in our_bowl if b.get("wickets", 0) == 4],
            key=lambda x: x.get("runs", 0),
        )
        for b in four_fers:
            if len(out) >= max_hl:
                break
            add(_bowl_highlight("4fer", b))

    if len(out) < max_hl:
        fifties = sorted(
            [b for b in our_bat if 50 <= b.get("runs", 0) < 100],
            key=lambda x: x["runs"],
            reverse=True,
        )
        for b in fifties:
            if len(out) >= max_hl:
                break
            add(_bat_highlight("fifty", b))

    if len(out) < max_hl:
        for b in our_bat:
            balls = b.get("balls", 0) or 0
            runs = b.get("runs", 0) or 0
            if runs >= 30 and balls >= 10 and runs / balls * 100 >= 150:
                if len(out) >= max_hl:
                    break
                add(_bat_highlight("cameo", b))

    if len(out) < max_hl:
        for b in our_bowl:
            balls = b.get("balls", 0) or 0
            if balls == 0:
                continue
            overs = balls / 6
            if b.get("wickets", 0) >= 2 and overs >= 4 and b.get("runs", 0) / balls * 6 <= 3.5:
                if len(out) >= max_hl:
                    break
                add(_bowl_highlight("tight_spell", b))

    if len(out) < max_hl:
        counts = {}
        for bat in their_bat:
            ho = (bat.get("how_out") or "").strip().lower()
            fielder = (bat.get("fielder_name") or "").strip()
            if not fielder:
                continue
            if ho == "ct" or ho == "st" or "run out" in ho:
                counts[fielder] = counts.get(fielder, 0) + 1
        for name, count in sorted(counts.items(), key=lambda x: x[1], reverse=True):
            if count < 2:
                break
            if len(out) >= max_hl:
                break
            add({"kind": "fielding", "category": "field", "name": name, "primary": "", "secondary": f"{count} dismissals"})

    if not out:
        if our_bat:
            top = max(our_bat, key=lambda x: x.get("runs", 0) or 0)
            if (top.get("runs", 0) or 0) > 0 or (top.get("balls", 0) or 0) > 0:
                add(_bat_highlight("top_scorer", top))
        if len(out) < max_hl and our_bowl:
            top_w = max(our_bowl, key=lambda x: x.get("wickets", 0) or 0)
            if (top_w.get("wickets", 0) or 0) > 0:
                add(_bowl_highlight("top_wicket_taker", top_w))

    return out


# Our club as it reads on the match package — see drop_cc.
OUR_CLUB = "Wendover"


def drop_cc(name):
    """Club name without its trailing "CC" — "Tring Park CC" → "Tring Park".

    Used across the match package, where every name on screen is a cricket club
    and the suffix is pure repetition. NOT used on the location badge: there the
    name is a *ground*, and "Wendover CC" is what a visitor is looking for on a
    signpost. Also a Jinja filter (`| drop_cc`) for names that only exist in the
    template, e.g. league-table rows.
    """
    if not name:
        return name
    out = re.sub(r"\s+(CC|C\.C\.?|Cricket Club)$", "", str(name).strip(), flags=re.I)
    return out or name


def _split_opp_name(opp_full, opp_club):
    if opp_club:
        return opp_club, (
            opp_full[len(opp_club) + 3:]
            if opp_full.startswith(opp_club + " - ")
            else opp_full
        )
    if " - " in (opp_full or ""):
        club, _, desig = opp_full.rpartition(" - ")
        return club, desig
    return opp_full or "", ""


def _norm_name(s):
    """Lowercase, strip punctuation, collapse whitespace — for name matching."""
    s = re.sub(r"[.\-']", " ", (s or "").lower())
    s = re.sub(r"[^a-z0-9 ]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _name_key(s):
    """(first token, surname token) from a name, for initial+surname matching."""
    parts = _norm_name(s).split()
    if not parts:
        return ("", "")
    if len(parts) == 1:
        return ("", parts[0])
    return (parts[0], parts[-1])


def _fantasy_points_index(player_standings):
    """Index fantasy player standings for fuzzy name → {points, value} lookup."""
    headers = (player_standings or {}).get("headers", []) or []
    rows = (player_standings or {}).get("rows", []) or []
    total_i = next(
        (i for i, h in enumerate(headers) if "total" in h.lower()),
        len(headers) - 1 if headers else 8,
    )
    value_i = next((i for i, h in enumerate(headers) if "value" in h.lower()), 1)
    index = []
    for r in rows:
        if not r:
            continue
        name = r[0] if len(r) > 0 else ""
        if not name:
            continue
        try:
            pts = int(str(r[total_i]).replace(",", "").strip()) if len(r) > total_i else None
        except ValueError:
            pts = None
        value = str(r[value_i]).strip() if len(r) > value_i else ""
        first, surname = _name_key(name)
        index.append({
            "norm": _norm_name(name), "first": first, "surname": surname,
            "points": pts, "value": value,
        })
    return index


def _fmt_fantasy_value(raw):
    """Fantasy value string (e.g. "£6.2m", "£8m") → bare one-decimal "6.2"/"8.0",
    or None if it carries no number. The "£m" lives in the column header."""
    m = re.search(r"[-+]?\d*\.?\d+", raw or "")
    return f"{float(m.group()):.1f}" if m else None


def _match_fantasy_entry(pc_name, index):
    """Best-effort fantasy standings entry for a Play Cricket name, or None.

    Exact normalised name first; then a unique surname match (rejected if both
    sides carry a first name whose initial disagrees); then, for a shared
    surname, disambiguation by first initial. Anything still ambiguous → None,
    so a wrong player is never shown."""
    norm = _norm_name(pc_name)
    for e in index:
        if e["norm"] == norm:
            return e
    first, surname = _name_key(pc_name)
    if not surname:
        return None
    cands = [e for e in index if e["surname"] == surname]
    if not cands:
        return None
    if len(cands) == 1:
        e = cands[0]
        if first and e["first"] and first[0] != e["first"][0]:
            return None
        return e
    if first:
        by_initial = [e for e in cands if e["first"] and e["first"][0] == first[0]]
        if len(by_initial) == 1:
            return by_initial[0]
    return None


def load_fantasy_aliases():
    """Manual Play Cricket → Fantasy name overrides for the "Teams" panel.

    Returns {normalised PC name: fantasy name}. Covers cases the automatic match
    can't (abbreviated/nickname forms); see content/fantasy_name_aliases.json."""
    path = CONTENT / "fantasy_name_aliases.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    return {_norm_name(k): v for k, v in (data.get("aliases") or {}).items()}


def build_fantasy_teams(slide, teams_by_id, fixtures_data, player_standings):
    """Build the "Teams" panel cards: each senior team's next fixture with its
    published XI (or a not-yet-published placeholder).

    One card per team in FANTASY_TEAM_ORDER that has an upcoming fixture. The
    imminent fixture is always shown — we never skip ahead to a later published
    game — so an unpublished side renders the opponent/date with an empty roster
    and `published: False`. Teams with no upcoming fixture are dropped.

    Each player is fuzzy-matched against the fantasy player standings to attach
    current Total Points (`points`) and a histogram `bar` percentage, scaled to
    the top scorer across all cards so bars are comparable panel-wide.
    """
    fixtures = (fixtures_data or {}).get("fixtures", {})
    index = _fantasy_points_index(player_standings)
    aliases = load_fantasy_aliases()
    cards = []
    for team_id in FANTASY_TEAM_ORDER:
        fixture = fixtures.get(team_id)
        if not fixture:
            continue
        team = teams_by_id.get(team_id, {})
        opp_club, _ = _split_opp_name(
            fixture.get("opposition_name", ""), fixture.get("opposition_club_name", "")
        )
        iso = _iso_from_dmy(fixture.get("match_date", ""))
        date_short = ""
        if iso:
            d = datetime.strptime(iso, "%Y-%m-%d")
            date_short = d.strftime(f"%a {d.day} %b")
        players = []
        for p in fixture.get("published_xi") or []:
            player = dict(p)
            lookup = aliases.get(_norm_name(p.get("name", "")), p.get("name", ""))
            entry = _match_fantasy_entry(lookup, index)
            # points drive the (form) bar; value is the displayed £m price
            player["points"] = entry["points"] if entry else None
            player["value"] = _fmt_fantasy_value(entry["value"]) if entry else None
            players.append(player)
        cards.append({
            "team_name": team.get("name", team_id),
            "opponent": opp_club or fixture.get("opposition_name", ""),
            "is_home": bool(fixture.get("is_home")),
            "date": date_short,
            "players": players,
            "published": bool(players),
        })

    # Scale bars to the top scorer across every card so lengths are comparable.
    max_pts = max(
        (p["points"] for c in cards for p in c["players"]
         if isinstance(p.get("points"), int) and p["points"] > 0),
        default=0,
    )
    for c in cards:
        for p in c["players"]:
            pts = p.get("points")
            p["bar"] = round(pts / max_pts * 100, 1) if (isinstance(pts, int) and pts > 0 and max_pts) else 0
    slide["_teams"] = cards


def _short_opponent(name):
    """Trim a club name to what fits a narrow 'Opponent' column.

    'Maidenhead & Bray CC' → 'Maidenhead & Bray'. The suffix is noise when
    every row in the column is a cricket club; dropping it buys three or four
    characters of the name that actually distinguishes one row from the next.
    """
    s = (name or "").strip()
    for suffix in (" Cricket Club", " CC"):
        if s.endswith(suffix):
            return s[: -len(suffix)].strip()
    return s


def _short_date(iso_date):
    """'2026-08-01' → '1 Aug'. The weekday _fmt_date_past adds is shouty in a
    card's sub-line, and these were nearly all Saturdays anyway."""
    try:
        d = datetime.strptime(iso_date, "%Y-%m-%d")
        return d.strftime(f"{d.day} %b")
    except (ValueError, TypeError):
        return ""


def _ordinal(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return ""
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _versus(record):
    """'v Tring Park · 20 Jun' from any record carrying opponents + date."""
    opp = _short_opponent(record.get("opponents"))
    return " · ".join(x for x in (f"v {opp}" if opp else "", _short_date(record.get("date"))) if x)


# Bars for the two cards where a tiny sample would otherwise win: a 6-ball 12
# is not the season's fastest scoring, and a single tidy over is not its most
# economical spell.
FAST_SCORING_MIN_RUNS = 30
ECONOMY_MIN_BALLS = 24

# Fewer cards than this and the Records tab is mostly empty grid — the younger
# junior sides, whose scorecards carry neither fielders nor fall-of-wickets.
MIN_RECORD_CARDS = 4


def _card(label, category, record, value, name, detail="", sub=""):
    """One record card, or None when the club has nothing in that category yet.

    Cards carry their own discipline icon rather than sitting under a column
    heading, so a missing one simply drops out and the rest close up. `name`
    may be a list — a partnership gets a line per batter rather than one
    truncated line for the pair.
    """
    if not record:
        return None
    return {
        "label": label, "category": category, "value": value,
        "names": name if isinstance(name, list) else [name],
        "detail": detail, "sub": sub,
    }


def _players_of(record):
    """Everyone a record credits — both batters, in a partnership's case."""
    if record.get("batsmen"):
        return [n for n in record["batsmen"] if n]
    for key in ("batsman", "bowler", "fielder", "name"):
        if record.get(key):
            return [record[key]]
    return []


def _resolve_ties(specs):
    """Choose one record per card, favouring players not already on a card.

    Ties are not a rare edge here: a quarter of the club's cards are decided by
    one, and small-integer records tie enormously (22 bowlers with a single
    maiden apiece). The fallback this replaces was `max()` returning the first
    maximal record, i.e. the earliest match of the season — arbitrary, and
    invisible to anyone watching. Given the choice is free, spend it on showing
    a different name.

    Cards with one candidate settle first, then the tied ones most-constrained
    first, each taking the candidate whose players are least used so far. Feed
    order breaks a tie between equally-fresh candidates, so a build is
    reproducible. This only ever picks *between equal records* — it never
    demotes an outright winner for the sake of variety.
    """
    used = {}
    picks = {}
    for i in sorted(range(len(specs)), key=lambda i: len(specs[i]["pool"])):
        pool = specs[i]["pool"]
        if not pool:
            continue
        pick = min(
            pool,
            key=lambda r: (sum(used.get(n, 0) for n in _players_of(r)), pool.index(r)),
        )
        picks[i] = pick
        for name in _players_of(pick):
            used[name] = used.get(name, 0) + 1
    return picks


def build_highlights(records, team_filter):
    """The season's bests for one team, as a flat list of record cards.

    Each card asks a genuinely different question rather than re-ranking the
    same list the Batting and Bowling tabs already show, and each carries its
    own discipline icon — so the grid is nine cards, not three columns, and a
    category with no data drops out instead of leaving a hole. Every feed is
    optional: u9 to u12 scorecards carry no fall-of-wickets or fielder names.
    """
    teams = team_filter if isinstance(team_filter, list) else [team_filter]

    def mine(feed):
        rows = ((records or {}).get(feed) or {}).get("records") or []
        return [r for r in rows if r.get("team") in teams]

    knocks, stands = mine("knocks"), mine("partnerships")
    spells, fielding = mine("spells"), mine("fielding")

    def ties(rows, key, where=None):
        """Every record sharing the best value — the tie pool, not a winner."""
        pool = [r for r in rows if where(r)] if where else rows
        if not pool:
            return []
        top = max(key(r) for r in pool)
        return [r for r in pool if key(r) == top]

    def shape(knock):
        parts = []
        for field, word in (("balls", "balls"), ("fours", "four"), ("sixes", "six")):
            n = knock.get(field) or 0
            if not n:
                continue
            if field == "balls":
                parts.append(f"{n} balls")
            else:
                plural = "s" if word == "four" else "es"
                parts.append(f"{n} {word}{plural if n != 1 else ''}")
        return " · ".join(parts)

    def figures(spell):
        return f"{spell.get('overs')}-{spell.get('maidens')}-{spell.get('runs')}-{spell.get('wickets')}"

    def breakdown(record, fields=("catches", "stumpings", "run_outs")):
        words = {"catches": "ct", "stumpings": "st", "run_outs": "ro"}
        return " · ".join(f"{record[f]} {words[f]}" for f in fields if record.get(f))

    def totals(rows, fields):
        """Season aggregates per player, as a tie pool of the joint leaders."""
        agg = {}
        for r in rows:
            entry = agg.setdefault(r.get("fielder", ""), dict.fromkeys(fields, 0))
            for f in fields:
                entry[f] += r.get(f, 0)
        if not agg:
            return []
        top = max(sum(v.values()) for v in agg.values())
        if not top:
            return []
        return [
            {"name": n, "total": sum(v.values()), **v}
            for n, v in agg.items() if sum(v.values()) == top
        ]

    # Junior formats cap a spell at three overs, so a fixed four-over bar would
    # empty the economy card for every side below u15. Fall back to the longest
    # spell the scope actually bowls.
    longest = max((r.get("balls", 0) for r in spells), default=0)
    economy_bar = ECONOMY_MIN_BALLS if longest >= ECONOMY_MIN_BALLS else longest

    # Keeping and fielding are different jobs. A keeper takes standing chances
    # all afternoon and would win any combined table on volume alone, so their
    # dismissals are counted separately and kept out of the outfield cards.
    keeper_rows = [r for r in fielding if r.get("as_keeper")]
    # Anything not the keeper's is outfield, and a stumping can only be the
    # keeper's — so a stray one means the sheet named no keeper that day.
    outfield_rows = [r for r in fielding if not r.get("as_keeper") and not r.get("stumpings")]

    def outfield_count(r):
        return r.get("catches", 0) + r.get("run_outs", 0)

    # Discipline order is the reading order, so a full side gets a row of
    # batting, a row of bowling and a row of fielding without needing headings
    # to say so.
    specs = [
        {
            "label": "Highest score", "category": "bat",
            "pool": ties(knocks, lambda r: (r.get("score", 0), bool(r.get("not_out")))),
            "render": lambda r: (
                f"{r['score']}{'*' if r.get('not_out') else ''}",
                r.get("batsman", ""), _versus(r), shape(r),
            ),
        },
        {
            "label": "Biggest partnership", "category": "bat",
            "pool": ties(stands, lambda r: r.get("runs", 0)),
            "render": lambda r: (
                f"{r['runs']}{'*' if r.get('unbroken') else ''}",
                r.get("batsmen") or [], _versus(r), f"{_ordinal(r.get('wicket'))} wicket",
            ),
        },
        {
            "label": "Best strike rate", "category": "bat",
            "pool": ties(
                knocks, lambda r: r["score"] / r["balls"],
                lambda r: r.get("balls") and r.get("score", 0) >= FAST_SCORING_MIN_RUNS,
            ),
            "render": lambda r: (
                f"{r['score'] / r['balls'] * 100:.0f}",
                r.get("batsman", ""), _versus(r), f"{r['score']} off {r['balls']} balls",
            ),
        },
        {
            "label": "Best figures", "category": "bowl",
            "pool": ties(spells, lambda r: (r.get("wickets", 0), -r.get("runs", 0))),
            "render": lambda r: (
                f"{r['wickets']}–{r['runs']}",
                r.get("bowler", ""), _versus(r), f"{r.get('overs')} overs",
            ),
        },
        {
            "label": "Best economy", "category": "bowl",
            "pool": ties(
                spells, lambda r: -(r["runs"] / r["balls"] * 6),
                lambda r: r.get("balls", 0) >= economy_bar,
            ),
            "render": lambda r: (
                f"{r['runs'] / r['balls'] * 6:.2f}",
                r.get("bowler", ""), _versus(r), figures(r),
            ),
        },
        {
            "label": "Most maidens", "category": "bowl",
            "pool": ties(spells, lambda r: r.get("maidens", 0),
                         lambda r: r.get("maidens", 0) > 0),
            "render": lambda r: (
                str(r.get("maidens", 0)), r.get("bowler", ""), _versus(r), figures(r),
            ),
        },
        {
            "label": "Most dismissals in a match", "category": "field",
            # One catch is not a performance.
            "pool": ties(outfield_rows, outfield_count, lambda r: outfield_count(r) >= 2),
            "render": lambda r: (
                str(outfield_count(r)), r.get("fielder", ""), _versus(r),
                breakdown(r, ("catches", "run_outs")),
            ),
        },
        {
            "label": "Keeper dismissals", "category": "field",
            "pool": totals(keeper_rows, ("catches", "stumpings", "run_outs")),
            "render": lambda r: (str(r["total"]), r["name"], "This season", breakdown(r)),
        },
        {
            "label": "Outfield dismissals", "category": "field",
            "pool": totals(outfield_rows, ("catches", "run_outs")),
            "render": lambda r: (
                str(r["total"]), r["name"], "This season",
                breakdown(r, ("catches", "run_outs")),
            ),
        },
    ]

    picks = _resolve_ties(specs)
    cards = []
    for i, spec in enumerate(specs):
        record = picks.get(i)
        if not record:
            continue
        value, name, detail, sub = spec["render"](record)
        cards.append(_card(spec["label"], spec["category"], record, value, name, detail, sub))
    # Below four cards the tab is mostly empty grid — the younger junior sides,
    # whose scorecards carry neither fielders nor fall-of-wickets.
    return cards if len(cards) >= MIN_RECORD_CARDS else []


def build_team(slide, teams_by_id, fixtures_data, stats_data, lb_config, records=None):
    """Assemble the multi-panel team slide object.

    Panels (any with no data are omitted from slide._panels):
      league · results · schedule · top_batting · top_bowling
    """
    # Header levels as data — see build_schedule and slide_title. The team slide
    # inverts the usual order: the fixed word is the title and the team is the
    # subtitle, which is why this can't be derived from `title` alone.
    slide["_heading"] = "Team Focus"
    slide["_subheading"] = slide.get("title")
    team_id = slide.get("team")
    team = teams_by_id.get(team_id, {})
    fixtures_data = fixtures_data or {}
    today = _today()
    today_iso = today.isoformat()

    panels = []

    # ── Tab 1: League table ────────────────────────────────────────────────
    league_id = team.get("play_cricket_league_id")
    slide["_has_league"] = False
    slide["_league_data"] = None
    if league_id:
        path = FETCHED / f"league_table_{league_id}.json"
        if path.exists():
            league_data = json.loads(path.read_text())
            for table in league_data.get("league_table", []):
                ordered = sorted(
                    table["headings"].items(),
                    key=lambda x: int(x[0].split("_")[1]),
                )
                ordered = [
                    (k, v) for k, v in ordered
                    if k == "column_1" or v.lower() not in LEAGUE_TABLE_EXCLUDED
                ]
                team_col = [(k, v) for k, v in ordered if k == "column_1"]
                pts_cols = [(k, v) for k, v in ordered if k != "column_1" and v.lower() == "pts"]
                rest_cols = [(k, v) for k, v in ordered if k != "column_1" and v.lower() != "pts"]
                table["headings_list"] = team_col + rest_cols + pts_cols
                table["rows"] = table["values"]
            slide["_league_data"] = league_data
            slide["_league_team_id"] = str(team.get("play_cricket_team_id", ""))
            slide["_league_name"] = team.get("league_name", "")
            slide["_has_league"] = True
            panels.append("league")

    # ── Tab 2: Results (most recent N) ─────────────────────────────────────
    form_data = (stats_data or {}).get("form", {}).get(team_id, {})
    slide["_our_form"] = (form_data.get("all", []) or [])[-5:]  # `all` holds 6 for the preview; team form shows 5

    recent = (fixtures_data.get("recent_matches") or {}).get(team_id) or []
    if not recent:
        # Fallback for fixtures.json predating the recent_matches field.
        legacy = (fixtures_data.get("last_match") or {}).get(team_id)
        if legacy:
            recent = [legacy]
    slide["_has_results"] = False
    slide["_results"] = []
    if recent:
        results = []
        for sc in recent:
            iso = _iso_from_dmy(sc.get("match_date", ""))
            opp_club, opp_team_desig = _split_opp_name(
                sc.get("opposition_name", ""), sc.get("opposition_club_name", "")
            )
            our_short = _short_innings_total(sc.get("our_total"))
            their_short = _short_innings_total(sc.get("their_total"))
            our_inn = {"team": "Wendover", "score": our_short}
            their_inn = {"team": opp_club, "score": their_short}
            innings = [our_inn, their_inn] if sc.get("we_bat_first", True) else [their_inn, our_inn]
            results.append({
                "date_iso": iso,
                "date_label": _fmt_date_past(iso) if iso else "",
                "is_home": sc.get("is_home", True),
                "opp_club_name": opp_club,
                "opp_team_name": opp_team_desig,
                "result": sc.get("result"),
                "result_description": sc.get("result_description", ""),
                "our_points": sc.get("our_points"),
                "their_points": sc.get("their_points"),
                "innings": innings,
                "highlights": _select_match_highlights(sc, max_hl=2),
            })
        slide["_results"] = results
        slide["_has_results"] = True
        panels.append("results")

    # ── Tab 3: Schedule (next N fixtures) ──────────────────────────────────
    all_fixtures = (fixtures_data.get("all_fixtures") or {}).get(team_id) or []
    upcoming = []
    for m in all_fixtures:
        iso = _iso_from_dmy(m.get("match_date", ""))
        if not iso or iso < today_iso:
            continue
        upcoming.append((iso, m))
    upcoming.sort(key=lambda x: (x[0], x[1].get("match_time") or ""))
    upcoming = upcoming[:3]

    slide["_has_schedule"] = False
    slide["_fixtures"] = []
    if upcoming:
        fixtures_out = []
        for iso, m in upcoming:
            # Schedule entries store the team designation separately as
            # opposition_team_name; recent-match scorecards bundle it into
            # opposition_name. Use whichever is present.
            opp_club = m.get("opposition_club_name") or ""
            if m.get("opposition_team_name"):
                opp_team_desig = m["opposition_team_name"]
            else:
                opp_club, opp_team_desig = _split_opp_name(
                    m.get("opposition_name") or "", opp_club
                )
            entry = {
                "date_iso": iso,
                "date_label": _fmt_date_future(iso, today),
                "match_time": m.get("match_time") or None,
                "is_home": m.get("is_home", True),
                "opp_club_name": opp_club,
                "opp_team_name": opp_team_desig,
                "ground_name": m.get("ground_name") or "",
                "opp_form": m.get("opposition_form"),
                "top_bat": None,
                "top_bowl": None,
            }
            opp_players = m.get("opposition_players") or {}
            bat_list = opp_players.get("batting") or []
            bowl_list = opp_players.get("bowling") or []
            if bat_list:
                p = bat_list[0]
                entry["top_bat"] = {
                    "name": p.get("name", ""),
                    "runs": p.get("runs", 0),
                    "average": p.get("average"),
                }
            if bowl_list:
                p = bowl_list[0]
                entry["top_bowl"] = {
                    "name": p.get("name", ""),
                    "wickets": p.get("wickets", 0),
                    "average": p.get("average"),
                }
            fixtures_out.append(entry)
        slide["_fixtures"] = fixtures_out
        slide["_has_schedule"] = True
        panels.append("schedule")

    # ── Tabs 4 & 5: Top batting / Top bowling ──────────────────────────────
    # Batting is two columns: the two tables stack down the left, the season's
    # biggest innings run as performance lines on the right. Bowling is still
    # two stacked halves.
    TOP_ROWS = 5
    RUNS_ROWS = 7

    slide["_top_runs"] = []
    slide["_top_avg_bat"] = []
    slide["_top_wkts"] = []
    slide["_top_avg_bowl"] = []
    slide["_has_top_batting"] = False
    slide["_has_top_bowling"] = False
    # Floors stand in until the stats give us a scope to size the bar against.
    min_innings = (lb_config or {}).get("floor_innings", 2)
    min_overs = (lb_config or {}).get("floor_overs", 2)
    slide["_min_innings"] = min_innings
    slide["_min_overs"] = min_overs

    if stats_data:
        entries = []
        for p in stats_data["players"].values():
            block = get_leaderboard_block(p, team_id, None)
            if block and block["matches"] > 0:
                entries.append({"name": p["name"], "block": block})

        min_innings, min_overs = qualification_thresholds(entries, lb_config, TOP_ROWS)
        min_balls = min_overs * 6
        slide["_min_innings"] = min_innings
        slide["_min_overs"] = min_overs

        def fmt_bat(e):
            b = e["block"]["batting"]
            avg = b.get("average")
            sr = b.get("strike_rate")
            return {
                "name": e["name"],
                "matches": e["block"]["matches"],
                "innings": b["innings"],
                "not_outs": b["not_outs"],
                "runs": b["runs"],
                "strike_rate": f"{sr:.0f}" if sr is not None else "-",
                "high_score_num": str(b["high_score"]) if b["high_score"] is not None else "-",
                "high_score_not_out": bool(b.get("high_score_not_out")),
                "average": f"{avg:.1f}" if avg is not None else "-",
            }

        runs_rows = sorted(
            [e for e in entries if e["block"]["batting"]["innings"] > 0],
            key=lambda e: e["block"]["batting"]["runs"],
            reverse=True,
        )[:RUNS_ROWS]

        avg_bat_rows = sorted(
            [
                e for e in entries
                if e["block"]["batting"]["innings"] >= min_innings
                and e["block"]["batting"].get("average") is not None
            ],
            key=lambda e: e["block"]["batting"]["average"],
            reverse=True,
        )[:TOP_ROWS]

        slide["_top_runs"] = [fmt_bat(e) for e in runs_rows]
        slide["_top_avg_bat"] = [fmt_bat(e) for e in avg_bat_rows]
        if slide["_top_runs"] or slide["_top_avg_bat"]:
            slide["_has_top_batting"] = True
            panels.append("top_batting")

        def fmt_bowl(e):
            b = e["block"]["bowling"]
            avg = b.get("average")
            return {
                "name": e["name"],
                "matches": e["block"]["matches"],
                "overs": balls_to_overs(b["balls"]),
                "wickets": b["wickets"],
                "best": fmt_best(b),
                "average": f"{avg:.1f}" if avg is not None else "-",
            }

        wkts_rows = sorted(
            [e for e in entries if e["block"]["bowling"]["wickets"] > 0],
            key=lambda e: e["block"]["bowling"]["wickets"],
            reverse=True,
        )[:TOP_ROWS]

        avg_bowl_rows = sorted(
            [
                e for e in entries
                if e["block"]["bowling"]["balls"] >= min_balls
                and e["block"]["bowling"].get("average") is not None
            ],
            key=lambda e: e["block"]["bowling"]["average"],
        )[:TOP_ROWS]

        slide["_top_wkts"] = [fmt_bowl(e) for e in wkts_rows]
        slide["_top_avg_bowl"] = [fmt_bowl(e) for e in avg_bowl_rows]
        if slide["_top_wkts"] or slide["_top_avg_bowl"]:
            slide["_has_top_bowling"] = True
            panels.append("top_bowling")

    # ── Tab 6: Highlights — the season's bests, three by three ─────────────
    slide["_records"] = build_highlights(records, team_id)
    if slide["_records"]:
        panels.append("highlights")

    slide["_panels"] = panels


ACTIVITY_PRIORITY = {"club_event": 0, "section_event": 1, "match": 2, "training": 3,
                     "hire": 4, "bar": 5}

# Weekday names as written in config.recurring_events → Python's Monday-zero index.
WEEKDAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}

# How far ahead recurring events are written into the context calendar. The build
# is nightly, so this only has to outrun a few missed builds — and the debug
# "next contexts" panel looks a week ahead.
RECURRING_HORIZON_DAYS = 90

_DEFAULT_PHASES = {
    "match":    {"warm_up_mins": 120, "main_duration_mins": 210, "wind_down_mins": 180},
    "training": {"warm_up_mins": 15,  "wind_down_mins": 30},
    "hire":     {"warm_up_mins": 60,  "wind_down_mins": 60},
}


def add_minutes(time_str, minutes):
    h, m = map(int, time_str.split(":"))
    total = max(0, h * 60 + m + minutes)
    if total >= 1440:
        return "24:00"
    return f"{total // 60:02d}:{total % 60:02d}"


def recurring_events_on(d):
    """config.recurring_events falling on date `d` — the club's standing weekly
    fixtures of the non-cricket kind (the Members Bar). Hardcoded until CS365 can
    be asked for opening times. Feeds both the context calendar (which decides the
    audience) and the today board (which tells people it's on)."""
    out = []
    for ev in load_config().get("recurring_events", []):
        if ev.get("from") and d < date.fromisoformat(ev["from"]):
            continue
        if d.weekday() in {WEEKDAYS[x] for x in ev.get("weekdays", []) if x in WEEKDAYS}:
            out.append(ev)
    return out


def infer_section(team_ids):
    if not team_ids:
        return "all"
    sections = {"junior" if tid.startswith("u") else "senior" for tid in team_ids}
    return sections.pop() if len(sections) == 1 else "all"


def _load_yt_broadcasts():
    """Our channel's scheduled/live YouTube broadcasts (the same source the
    homepage uses). Lets us mark a fixture streamed *in advance* when WE host
    the Frogbox stream; away streams only surface at runtime via the feed."""
    p = FETCHED / "youtube_live.json"
    if not p.exists():
        return []
    y = json.loads(p.read_text())
    return (y.get("live") or []) + (y.get("upcoming") or [])


def _load_live_seed():
    """Optional manual overrides: content/live-seed.json = list of match dicts
    ({pc_id, ...}) to add to or annotate today's list. Covers ids fixtures.json
    doesn't carry yet, or forcing `streamed` on an away game we know is streamed."""
    p = CONTENT / "live-seed.json"
    return json.loads(p.read_text()) if p.exists() else []


def todays_events(teams_by_id, training_sessions, all_fixtures, loc_lookup,
                  loc_names, yt_broadcasts, seed):
    """The whole day's club activity — every team's matches + training — as
    time-ordered event dicts for the `today` board. Match events carry the
    pollable `pc_id` + best-effort `streamed` for live enrichment; training
    events are static. Shared by build_slides (baked into the slide so it renders
    offline) and build_live_config (its match subset = the Worker's poll list)."""
    today_iso = _today().isoformat()

    def opp_crest(club_name):
        """Public path of an already-committed opposition crest (by club-name
        slug), or None. Reuses the localised badges fetch_fixtures caches; no
        scrape here — an away friendly with no cached crest just renders name-only."""
        slug = re.sub(r"[^a-z0-9]+", "-", (club_name or "").lower()).strip("-")
        if not slug:
            return None
        for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"):
            if (ASSETS / "images" / "crests" / f"{slug}{ext}").exists():
                return f"/assets/images/crests/{slug}{ext}"
        return None

    def to_iso(s):
        try:
            return datetime.strptime(s, "%d/%m/%Y").date().isoformat()
        except (ValueError, TypeError):
            return None

    def streamed_today():
        for b in yt_broadcasts:
            st = str(b.get("scheduled_start") or b.get("actual_start") or "")
            if st[:10] == today_iso:
                return {"video_id": b.get("video_id"), "url": b.get("url")}
        return None

    # Our club's short name for live scorelines/results. Prefer the team's PC
    # league-table name ("Wendover CC"); friendly/junior teams that carry none
    # fall back to the configured club name shortened to the same "CC" form. Kept
    # authoritative here so live surfaces never have to string-munge the feed's
    # batting-side designation (which lacks "CC" on some sides, e.g. friendlies).
    club_fallback = re.sub(r"\bCricket Club\b", "CC",
                           (load_config().get("preview", {}) or {}).get("club_name", "")).strip()

    events, by_id = [], {}
    for team_id, fixtures in (all_fixtures or {}).items():
        team = teams_by_id.get(team_id, {})
        for f in fixtures or []:
            if to_iso(f.get("match_date", "")) != today_iso:
                continue
            ground = f.get("ground_name") or ""
            loc_id = loc_lookup.get(ground.lower())
            pc_id = f.get("match_id")
            m = {
                "type": "match",
                "pc_id": pc_id,
                "team": team_id,
                "team_name": team.get("name", team_id),
                "our_club": team.get("league_table_name") or club_fallback,
                "opposition": f.get("opposition_club_name") or f.get("opposition_team_name") or "",
                "opposition_team": f.get("opposition_team_name") or "",
                "opposition_team_id": str(f.get("opposition_team_id") or ""),
                "time": f.get("match_time") or None,
                "ground": loc_names.get(loc_id, ground),
                "is_home": bool(f.get("is_home", True)),
                "competition": f.get("competition_name") or "",
                "competition_id": str(f.get("competition_id") or ""),
                "league_name": f.get("league_name") or "",
                # Crests for the live innings scoreline — batting side picks ours
                # or the opposition's by name at render time.
                "our_crest": "/assets/images/wcc-logo.png",
                "opp_crest": opp_crest(f.get("opposition_club_name") or f.get("opposition_team_name")),
            }
            st = streamed_today()
            if st:
                m["streamed"] = True
                m["video_id"] = st.get("video_id")
            events.append(m)
            if pc_id:
                by_id[str(pc_id)] = m

    for s in training_sessions or []:
        if s.get("date") != today_iso:
            continue
        loc_id = s.get("location_id")
        names = [teams_by_id[t]["name"] for t in s.get("team_ids", []) if t in teams_by_id]
        events.append({
            "type": "training",
            "time": s.get("time_start") or None,
            "title": s.get("title") or "Training",
            "team_names": names,
            "ground": loc_names.get(loc_id, s.get("location", "")),
        })

    # Manual seed: add/annotate today's MATCH events (id, streamed) — prefer
    # annotating an existing fixture by id, else by team (a today fixture with no
    # id yet), so seeding today's game enriches its row rather than duplicating it.
    for s in seed or []:
        if s.get("date") and s["date"] != today_iso:
            continue  # a dated seed only applies on its date (no future-day leak)
        pid = str(s.get("pc_id")) if s.get("pc_id") is not None else None
        target = by_id.get(pid) if pid else None
        if target is None and s.get("team"):
            target = next((e for e in events if e.get("type") == "match"
                           and e.get("team") == s["team"] and not e.get("pc_id")), None)
        if target is not None:
            target.update({k: v for k, v in s.items() if v is not None})
            if pid:
                by_id[pid] = target
        else:
            s.setdefault("type", "match")
            events.append(s)
            if pid:
                by_id[pid] = s

    # Standing weekly openings (the Members Bar). Board-only: no pc_id, no team, so
    # every live surface downstream filters them straight out — they're here to say
    # the clubhouse is open, which on a quiet evening is the whole of what's on.
    for ev in recurring_events_on(_today()):
        for loc_id in ev.get("locations", []):
            events.append({
                "type": ev.get("type", "club_event"),
                "time": ev.get("start"),
                "title": ev.get("title"),
                "ground": loc_names.get(loc_id, loc_id),
            })

    events.sort(key=lambda e: (e.get("time") or "99:99",
                               e.get("team_name") or e.get("title") or ""))
    return events


def _todays_events():
    """Today's events assembled from the committed data files — the shared source
    for every live surface built outside the today slide (live-config, live-strip),
    so they can't disagree about what's on today."""
    teams_by_id = load_teams()
    locs = json.loads((CONTENT / "locations.json").read_text()).get("locations", [])
    loc_names = {l["id"]: l["name"] for l in locs}
    loc_lookup = {}
    for l in locs:
        for a in l.get("aliases", []):
            loc_lookup[a.lower()] = l["id"]
    fx = FETCHED / "fixtures.json"
    all_fixtures = json.loads(fx.read_text()).get("all_fixtures", {}) if fx.exists() else {}
    tr = FETCHED / "cs365_training.json"
    training = json.loads(tr.read_text()).get("sessions", []) if tr.exists() else []
    return todays_events(teams_by_id, training, all_fixtures, loc_lookup, loc_names,
                         _load_yt_broadcasts(), _load_live_seed()), teams_by_id


def live_poll_window(matches):
    """(poll_from, poll_until) for today's matches — the only span in which a client
    should touch the live feed at all. Both are NAIVE LOCAL ISO strings ("…T11:30"),
    deliberately: the client parses them with `new Date(str)`, which reads an
    offset-less date-time as *local* time, so a UTC CI runner baking the window and
    a BST wall reading it agree without either knowing the other's zone.

      from  = earliest start today, minus a lead (scorers open a match and settle
              the toss before the first ball), clamped to the start of the day
      until = midnight tonight, ALWAYS — the Pi switches off then, and it caps the
              damage if the nightly build fails and this config goes stale: a
              yesterday window is already closed, so polling stops on its own
              instead of running until the next successful build.

    No matches today → (None, None) = never poll.

    WCC_TODAY replay builds are the exception: the replayed day's window closed long
    ago, so a local test would gate itself shut before you could look at it. When the
    build date isn't the real date we bake the REAL day instead — open from this
    morning, shut at tonight's midnight — so the feed is pollable for the rest of the
    day you're actually testing on. The matches are still the replayed day's (Results
    Vault keeps completed matches, so they poll fine). Never reachable in CI/prod,
    where WCC_TODAY is unset and day == real_today."""
    if not matches:
        return None, None
    day = _today()
    real_today = date.today()
    if day != real_today:
        real_start = datetime.combine(real_today, datetime.min.time())
        return (real_start.isoformat(timespec="minutes"),
                (real_start + timedelta(days=1)).isoformat(timespec="minutes"))
    lead = int(load_config().get("live_poll_lead_minutes", 30))
    day_start = datetime.combine(day, datetime.min.time())
    times = sorted(m["time"] for m in matches if m.get("time"))
    if times:
        first = datetime.combine(day, datetime.strptime(times[0], "%H:%M").time())
        start = max(first - timedelta(minutes=lead), day_start)
    else:
        # Unknown start time — don't guess; open the window at the start of the day.
        start = day_start
    return start.isoformat(timespec="minutes"), (day_start + timedelta(days=1)).isoformat(timespec="minutes")


def _competition_short(ev):
    """The competition as the live chrome's gold flag says it — "TVCL Div 6C".

    That flag is one live band wide (~138px at wall scale), so neither the league
    name nor "Division" fits: the league comes from the authored `league_abbr` map
    (content/config.json) and "Division" is clipped to "Div". Degrades a step at a
    time — an unmapped league drops to the division alone, a match with no division
    to the league's short form, and one with neither to "" (the flag then shows the
    XI only) — so a new competition is untidy, never broken."""
    div = re.sub(r"\bDivision\b", "Div", (ev.get("competition") or "").strip())
    lg = load_config().get("league_abbr", {}).get((ev.get("league_name") or "").strip(), "")
    return " ".join(p for p in (lg, div) if p)


def build_live_config():
    """Write site/live-config.json — today's pollable matches (the day's events
    that have a pc_id) = the live-proxy Worker's poll list (LIVE_CONFIG_URL), plus
    the poll window clients gate themselves on (see live_poll_window). The `today`
    slide bakes the full schedule itself; this is only what the Worker needs to
    know which matches to poll."""
    events, _ = _todays_events()
    matches = [dict(e, competition_short=_competition_short(e))
               for e in events if e.get("type") == "match" and e.get("pc_id")]
    poll_from, poll_until = live_poll_window(matches)
    out = {"generated_at": int(datetime.now().timestamp()),
           "date": _today().isoformat(),
           "poll_from": poll_from, "poll_until": poll_until, "matches": matches}
    (SITE / "live-config.json").write_text(json.dumps(out, indent=2) + "\n")
    window = f"{poll_from} → {poll_until}" if poll_from else "closed (nothing on)"
    replay = " [replay build: window is the REAL day]" if _today() != date.today() else ""
    print(f"  live-config.json — {len(matches)} pollable match(es) today, poll window {window}{replay}")


def _load_league_today():
    """Today's OTHER league matches (scripts/fetch_league_fixtures.py), grouped by
    competition_id. Stale (wrong date) or missing → empty, so the board degrades to
    schedule-only rather than surfacing yesterday's fixtures."""
    p = FETCHED / "league_today.json"
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text())
    except (ValueError, OSError):
        return {}
    if data.get("date") != _today().isoformat():
        return {}
    by_comp = {}
    for m in data.get("matches", []):
        by_comp.setdefault(str(m.get("competition_id") or ""), []).append(m)
    return by_comp


def _league_standings(comp_id):
    """(standings_by_team_id, win_points) for a division from its committed
    league_table_<comp_id>.json. Columns are league-specific, so Pts/Played are
    resolved via `headings` (never a fixed index). win_points is parsed from the
    table `key` legend ("w - Won (22)"); None when absent."""
    p = FETCHED / f"league_table_{comp_id}.json"
    if not comp_id or not p.exists():
        return {}, None
    try:
        lt = json.loads(p.read_text())["league_table"][0]
    except (ValueError, OSError, KeyError, IndexError):
        return {}, None
    headings = lt.get("headings", {})
    col = lambda label: next((k for k, v in headings.items() if str(v).lower() == label), None)
    pts_col, p_col = col("pts"), col("p")

    def num(row, key):
        v = row.get(key) if key else None
        try:
            return int(v) if v not in (None, "") else None
        except (ValueError, TypeError):
            return None

    standings = {}
    for row in lt.get("values", []):
        tid = str(row.get("team_id") or "")
        if tid:
            standings[tid] = {"position": num(row, "position"),
                              "points": num(row, pts_col), "played": num(row, p_col)}
    m = re.search(r"w\s*-\s*Won\s*\((\d+)\)", lt.get("key", ""))
    return standings, (int(m.group(1)) if m else None)


def attach_league_context(events, teams_by_id):
    """Enrich each WCC match event on the today board with its league context: the
    parent league name, the day's OTHER matches in that division, and — when the
    committed league table is available — each side's standing, a point-difference
    to Wendover, and a swing-game flag. Purely additive: a missing table or
    league-today file just leaves the league name + division with no standings.
    Called only on the today slide (NOT inside todays_events) so live-config.json —
    the Worker's poll list — stays lean."""
    by_comp = _load_league_today()
    for ev in events:
        if ev.get("type") != "match":
            continue
        comp = ev.get("competition_id")
        if not comp or not (ev.get("league_name") or by_comp.get(comp)):
            continue
        standings, win_points = _league_standings(comp)
        team = teams_by_id.get(ev.get("team"), {})
        wcc_row = standings.get(str(team.get("play_cricket_team_id") or ""))
        wcc_pts = wcc_row["points"] if wcc_row else None

        def side(club, tname, tid):
            st = standings.get(str(tid or "")) or {}
            pts = st.get("points")
            return {"club": club, "team": tname, "position": st.get("position"),
                    "points": pts,
                    "diff": (pts - wcc_pts) if (pts is not None and wcc_pts is not None) else None}

        others = []
        for om in by_comp.get(comp, []):
            h = side(om.get("home_club_name"), om.get("home_team_name"), om.get("home_team_id"))
            a = side(om.get("away_club_name"), om.get("away_team_name"), om.get("away_team_id"))
            # Swing (first-pass, to iterate): a game between sides close enough to
            # Wendover on points that its result could reshuffle our standing —
            # within one win either way. Needs win_points + our own points.
            swing = bool(win_points and wcc_pts is not None and any(
                s["points"] is not None and abs(s["points"] - wcc_pts) <= win_points
                for s in (h, a)))
            others.append({"match_id": om.get("match_id"), "time": om.get("match_time"),
                           "home": h, "away": a, "swing": swing})
        others.sort(key=lambda o: (o.get("time") or "99:99"))

        # Our own opponent's points relative to Wendover, for the match header —
        # same basis as the other games' diffs. None for a friendly / unranked side.
        opp = side(ev.get("opposition"), ev.get("opposition_team"), ev.get("opposition_team_id"))
        ev["league"] = {
            "name": ev.get("league_name") or "",
            "division": ev.get("competition") or "",
            "win_points": win_points,
            "opp_diff": opp["diff"],
            "wcc": ({"position": wcc_row.get("position"), "points": wcc_pts,
                     "played": wcc_row.get("played"), "team_name": ev.get("team_name")}
                    if wcc_row else None),
            "others": others,
        }


def build_league_config():
    """Publish site/live-league.json — today's OTHER league matches (their pc ids),
    the poll list for the live-proxy Worker's future slow /league.json endpoint.
    Mirrors build_live_config for WCC; sourced from the build-time league_today.json
    (scripts/fetch_league_fixtures.py). Empty/absent → an empty list, so the Worker
    just has nothing to poll."""
    matches = [m for ms in _load_league_today().values() for m in ms]
    out = {"generated_at": int(datetime.now().timestamp()),
           "date": _today().isoformat(), "matches": matches}
    (SITE / "live-league.json").write_text(json.dumps(out, indent=2) + "\n")
    print(f"  live-league.json — {len(matches)} other-league match(es) today")


def build_live_flash(env):
    """Render the live-highlight news-flash overlay page (/live-flash/). It's not
    a slide in any rotation — the player owns one hidden iframe pointing here and
    drives it by postMessage when a highlight clip lands. Static; no per-build
    data (all content arrives at runtime from the live engine)."""
    out_dir = SITE / "live-flash"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(env.get_template("live-flash.html").render())
    print("  live-flash overlay → /live-flash/")


def build_live_ticker(env):
    """Render the live ticker overlay page (/live-ticker/). Like the flash, a
    player-owned overlay iframe (not a slide). It listens for the engine's wcc-live
    broadcast and paints a segment-cycling score bar in the bottom safe strip of
    the main content column (clear of the sidebar). Static; data arrives at runtime."""
    out_dir = SITE / "live-ticker"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(env.get_template("live-ticker.html").render())
    print("  live-ticker overlay → /live-ticker/")


def _team_tla(club_name):
    """Short 2–4 char tag for a club (Frogbox-style), the ladder's crest fallback.
    Initials of the significant words; a single-word club takes its first 3 letters.
    A manual override map can refine collisions later."""
    words = [w for w in re.split(r"[^A-Za-z0-9]+", club_name or "")
             if w and w.lower() not in ("cc", "cricket", "club", "the", "and", "xi")]
    if not words:
        return (club_name or "?")[:3].upper()
    if len(words) == 1:
        return words[0][:3].upper()
    return "".join(w[0] for w in words).upper()[:4]


def _club_of(team_name):
    """Club portion of a league-table team name ('Maidenhead & Bray CC - 3rd XI'
    -> 'Maidenhead & Bray CC')."""
    return re.sub(r"\s*-\s*.*$", "", team_name or "").strip()


def _table_counts_today(raw, ev):
    """Could this league-table snapshot already include today's results?

    The ladder overlays today's points onto the table, so it has to know whether
    the table is a BEFORE picture. `fetched_at` (written by fetch_play_cricket)
    settles it: fetched on an earlier day, or early enough today that no match had
    finished, means the table is clean. A file with no `fetched_at` predates that
    field entirely, so it also predates today. Unparseable → assume the worst and
    let the ladder stand still rather than double-count."""
    stamp = raw.get("fetched_at")
    if not stamp:
        return False
    try:
        when = datetime.fromisoformat(stamp)
    except (ValueError, TypeError):
        return True
    if when.date() < _today():
        return False
    # Fetched today: safe only if it predates the day's cricket. Compare against
    # today's earliest start (a result can't be in the table before the game).
    start = (ev.get("time") or "11:00")[:5]
    try:
        hh, mm = (int(x) for x in start.split(":"))
    except ValueError:
        hh, mm = 11, 0
    return (when.hour, when.minute) >= (hh, mm)


def _strip_league_view(ev, our_team_id, by_comp):
    """A league VIEW for one of our matches today: the division as an ordered list
    of teams (current league position), plus the day's fixtures in that division so
    the strip can bind each tile to a match in the live feeds.

    Only the context is baked — no live state. Every tile channel (bat/bowl role,
    win/loss fill, certainty, ghost move) is derived at runtime from the feeds.
    None when the division has no committed table (nothing to ladder)."""
    comp_id = ev.get("competition_id")
    p = FETCHED / f"league_table_{comp_id}.json"
    if not comp_id or not p.exists():
        return None
    standings, win_points = _league_standings(comp_id)
    try:
        raw = json.loads(p.read_text())
        lt = raw["league_table"][0]
    except (ValueError, OSError, KeyError, IndexError):
        return None
    teams = []
    for r in lt.get("values", []):
        club = _club_of(r.get("column_1"))
        tid = str(r.get("team_id") or "")
        st = standings.get(tid) or {}
        teams.append({
            "tla": _team_tla(club),
            # The club name is what the live feeds name a batting side by, so it's
            # the join key for "is this tile's team batting?" (team ids don't appear
            # in a scorecard). Kept alongside the id, which joins tile → fixture.
            "club": club,
            "team_id": tid,
            "ours": tid == our_team_id,
            "points": st.get("points"),
        })
    if not teams:
        return None
    # Today's matches in this division. Ours is polled through the rich WCC feed
    # (`wcc-live`, keyed by pc_id); everyone else's through the slow league feed
    # (`wcc-league`, keyed by match_id) — hence the `ours` flag per fixture.
    # `home_team_id` is what turns the RV feed's per-innings `is_home` into a team
    # id, so a tile binds to a side without matching any name.
    opp_id = str(ev.get("opposition_team_id") or "")
    fixtures = [{"match_id": ev["pc_id"], "ours": True,
                 "team_ids": [our_team_id, opp_id],
                 "home_team_id": our_team_id if ev.get("is_home", True) else opp_id}]
    for om in by_comp.get(str(comp_id), []):
        if str(om.get("match_id")) == str(ev["pc_id"]):
            continue   # our own game, already added as the rich one
        fixtures.append({"match_id": om.get("match_id"), "ours": False,
                         "team_ids": [str(om.get("home_team_id") or ""),
                                      str(om.get("away_team_id") or "")],
                         "home_team_id": str(om.get("home_team_id") or "")})
    return {
        "mode": "league",
        "pc_id": ev["pc_id"],
        # The featured XI + division, echoing the ticker's gold flag so the two
        # chrome surfaces read as one.
        "team_label": ev.get("team_name") or "",
        "name": ev.get("competition") or "",
        "win_points": win_points,
        # Whether TVCL Win/Lose scoring applies — the only points system we know
        # (Match Rules §9). Off for any other league, which just means the ladder
        # can't price a result and so never reorders for it.
        "tvcl": "thames valley" in (ev.get("league_name") or "").lower(),
        # True when the table snapshot may ALREADY include today's results, in
        # which case adding today's points again would double-count and jump a
        # tile twice. See _table_counts_today.
        "table_counts_today": _table_counts_today(raw, ev),
        "teams": teams,
        "fixtures": fixtures,
    }


def _strip_friendly_view(ev, our_team_id):
    """A two-tile VIEW for a match with no league ladder behind it (friendlies,
    cups, junior formats): just the two sides, same tile look. Order here is
    provisional — the runtime puts the side that batted first on top once the feed
    says who did — and the chase panel fills the space below."""
    opp_id = str(ev.get("opposition_team_id") or "")
    ours = {"tla": _team_tla(ev.get("our_club") or "Wendover CC"),
            "club": ev.get("our_club") or "Wendover CC",
            "team_id": our_team_id, "ours": True}
    opp_club = ev.get("opposition") or ev.get("opposition_team") or ""
    opp = {"tla": _team_tla(opp_club), "club": opp_club, "team_id": opp_id, "ours": False}
    return {
        "mode": "friendly",
        "pc_id": ev["pc_id"],
        "team_label": ev.get("team_name") or "Friendly",
        "name": ev.get("competition") or "",
        "teams": [ours, opp],
        "fixtures": [{"match_id": ev["pc_id"], "ours": True,
                      "team_ids": [our_team_id, opp_id],
                      "home_team_id": our_team_id if ev.get("is_home", True) else opp_id}],
    }


def _strip_views(events, teams_by_id):
    """One view per WCC match today (league ladder or two-tile friendly), in the
    day's order. The strip shows one at a time — the ticker's featured match picks
    which, so the two chrome surfaces stay in step."""
    by_comp = _load_league_today()
    views = []
    for ev in events:
        if ev.get("type") != "match" or not ev.get("pc_id"):
            continue
        team = teams_by_id.get(ev.get("team"), {})
        our_team_id = str(team.get("play_cricket_team_id") or "")
        view = _strip_league_view(ev, our_team_id, by_comp) if ev.get("competition_id") else None
        views.append(view or _strip_friendly_view(ev, our_team_id))
    return views


def build_live_strip(env):
    """Render the live vertical-strip page (/live-strip/). Player-owned chrome
    iframe on the left band (like the ticker): one equal-height tile per team in
    the division, ordered by league position.

    What's baked is CONTEXT only — today's matches, their divisions and the day's
    fixtures in them. Live state arrives at runtime from the player's `wcc-live`
    (our matches, ball-by-ball) and `wcc-league` (everyone else's, coarse) feeds.
    No match today → no views → the strip stays hidden.

    Off-day testing: build with WCC_TODAY set to a fixture date, then open
    /live-strip/?sim=league (or ?sim=friendly) to drive the real render path from a
    simulated match — see assets/js/live-strip-sim.js."""
    out_dir = SITE / "live-strip"
    out_dir.mkdir(parents=True, exist_ok=True)
    events, teams_by_id = _todays_events()
    views = _strip_views(events, teams_by_id)
    data = {"date": _today().isoformat(), "views": views}
    html = env.get_template("live-strip.html").render(strip_json=json.dumps(data))
    (out_dir / "index.html").write_text(html)
    modes = ", ".join(f"{v['team_label']}:{v['mode']}" for v in views) or "none"
    print(f"  live-strip → /live-strip/ ({len(views)} view(s): {modes})")


def build_live_matches(env, slide_meta):
    """Emit a `live-match-{team}` slide per team with a fixture today — the live
    counterpart of the last-match-{team} set, bound to that team's pc_id. It renders
    the team's live match from the wcc-live feed and self-skips (posts wcc-done)
    until the first ball is scored — feed phase 'no-feed'/'pre' means no panels, so
    the slide only joins the deck once the match is actually under way and then
    stays through the result. Before then the wall's build-up is the team slide;
    pavilion-auto's section filtering decides which screens show it. Registered in slide_meta so slideshows resolve
    the slug (hence emitted before build_slideshows)."""
    config = load_config()
    default_pd = config.get("default_panel_duration", 20)
    teams_by_id = load_teams()
    locs = json.loads((CONTENT / "locations.json").read_text()).get("locations", [])
    loc_names = {l["id"]: l["name"] for l in locs}
    loc_lookup = {}
    for l in locs:
        for a in l.get("aliases", []):
            loc_lookup[a.lower()] = l["id"]
    fx = FETCHED / "fixtures.json"
    fx_data = json.loads(fx.read_text()) if fx.exists() else {}
    all_fixtures = fx_data.get("all_fixtures", {})
    # Per-team next-match fixtures carry the published XI (fetched pre-match); on
    # match morning a team's next match IS today's, so it's the source for the
    # Pre-match "OUT" tags below.
    next_fixtures = fx_data.get("fixtures", {})
    stats_path = FETCHED / "player_stats_this_season.json"
    stats = json.loads(stats_path.read_text()) if stats_path.exists() else None
    tr = FETCHED / "cs365_training.json"
    training = json.loads(tr.read_text()).get("sessions", []) if tr.exists() else []
    events = todays_events(teams_by_id, training, all_fixtures, loc_lookup, loc_names,
                           _load_yt_broadcasts(), _load_live_seed())
    tmpl = env.get_template("slides/live-match.html")
    n = 0
    for ev in events:
        if ev.get("type") != "match" or not ev.get("pc_id"):
            continue
        opp_club = ev.get("opposition") or ""
        opp_team = ev.get("opposition_team") or ""
        slug = f"live-match-{ev['team']}"
        slide = {
            "template": "live-match", "title": "Today's Match",
            "_set_title": "Today's Match",
            "_set_subtitle": ev.get("team_name") or ev["team"],
            "_set_our_club": ev.get("our_club") or "",
            "_set_opp_club": opp_club,
            "_set_opp_team": opp_team if opp_team and opp_team != opp_club else "",
            "_set_date": ev.get("time") or "Today",
            "_set_is_home": ev.get("is_home", True),
            "_set_ground": ev.get("ground") or "",
            "_pc_id": ev["pc_id"],
            "_our_crest": ev.get("our_crest") or "/assets/images/wcc-logo.png",
            "_opp_crest": ev.get("opp_crest"),
            # Display-time trim applied to each frogbox HLS clip in the post-match
            # innings reels (skip run-up dead time, stop before the tail, cap length).
            "_clip_trim": config.get("clip_trim") or {"pre": 0, "post": 0, "max_len": 30},
            "panel_duration": default_pd,
            # Big backstop: the slide always self-advances via wcc-done, but a full
            # innings reel can run minutes, so don't let the player force-cut it.
            "duration": 900,
        }

        # Pre-match tale of the tape — the same spoiler-safe preview the last-match
        # set opens with, but baked statically here: it's all pre-match data known at
        # overnight build time, so the live slide can show a "Pre-match" panel before
        # any feed arrives (mirrors last-match parity). Rendered via the shared _tape
        # partial into a hidden <template> the slide's JS clones as its first panel.
        fixture = next((f for f in (all_fixtures.get(ev["team"]) or [])
                        if str(f.get("match_id")) == str(ev["pc_id"])), {})
        league_name = ev.get("league_name") or ""
        comp_name = ev.get("competition") or ""
        if league_name and comp_name and comp_name != league_name:
            competition_display = f"{league_name} · {comp_name}"
        else:
            competition_display = league_name or comp_name
        our_form = ((stats or {}).get("form", {}).get(ev["team"], {}).get("all", []))[-5:]
        # Published-XI names for today's match, to tag season leaders who didn't make
        # the team as OUT (mirrors the last-match intro). Only when the team's next
        # fixture is in fact today's game (match its date + opposition); otherwise the
        # XI is unknown and no one is tagged.
        today_dmy = _today().strftime("%d/%m/%Y")
        nf = next_fixtures.get(ev["team"]) or {}
        nf_is_today = (nf.get("match_date") == today_dmy and
                       str(nf.get("opposition_team_id") or "") == str(ev.get("opposition_team_id") or ""))
        published_names = {_norm_name(p["name"]) for p in (nf.get("published_xi") or [])
                           if nf_is_today and p.get("name")}
        slide.update({
            "_our_form": our_form,
            "_our_performers": team_current_performers(stats, ev["team"],
                                                       published_names=published_names or None),
            "_opp_club_name": opp_club,
            "_opp_form": fixture.get("opposition_form") or [],
            "_opp_performers": opp_preview_performers(fixture.get("opposition_players")),
            "_division": competition_display,
            "_toss": "",   # no toss before the match; the live feed carries it later
            "_h2h": "",
            # Pre-match lists the home team on the left (as the last-match intro).
            "_our_left": ev.get("is_home", True),
        })
        out_dir = SITE / "slide" / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(tmpl.render(slide=slide, slug=slug))
        slide_meta[slug] = {"slide_active": True, "slide_expires": None,
                            "_title": slide_title(slide, slug),
                            "_template": slide["template"],
                            "duration": slide["duration"],
                            # No `_atoms`: this slide's panels are whatever the live
                            # feed has produced by the time it renders, so the build
                            # can't enumerate them. Live decks aren't narrated or
                            # composited (docs/narrated-decks.md), so nothing needs
                            # them — a consumer treats a missing list as "unknown".
                            # Marks this as part of the live feature set, so a device
                            # with no access key can drop it at runtime and present
                            # exactly as if live_enabled were false (the flag is
                            # build-time; provisioning isn't). Flows into data.json
                            # via the slide_meta spread in build_slideshows.
                            "_live": True,
                            # _is_video: the player treats this like the last-match
                            # video reel — auto-play on forward arrival + a per-clip
                            # countdown. The reel's clips are runtime HLS (not in
                            # _videos / precache), so this flag carries the video-ness.
                            "_is_video": True,
                            # The slide self-advances its own clips/scorecards (posting
                            # wcc-panel per panel and wcc-done at the end), so the
                            # player's per-panel timer is only a long backstop — never
                            # let it force-cut a panel before the slide moves on.
                            "panel_duration": slide["duration"]}
        print(f"  slide/{slug}")
        n += 1
    if not n:
        print("  live-match: no matches with a pc_id today")


def build_context_calendar():
    config = load_config()
    phase_cfg = config.get("activity_phases", _DEFAULT_PHASES)
    match_p    = phase_cfg.get("match",    _DEFAULT_PHASES["match"])
    training_p = phase_cfg.get("training", _DEFAULT_PHASES["training"])

    locs_data = json.loads((CONTENT / "locations.json").read_text())
    screen_loc_ids = {l["id"] for l in locs_data["locations"] if l.get("screen")}

    loc_lookup = {}
    for loc in locs_data["locations"]:
        for alias in loc.get("aliases", []):
            loc_lookup[alias.lower()] = loc["id"]

    fixtures_path = FETCHED / "fixtures.json"
    training_path = FETCHED / "cs365_training.json"

    all_fixtures = {}
    if fixtures_path.exists():
        all_fixtures = json.loads(fixtures_path.read_text()).get("all_fixtures", {})

    training_sessions = []
    if training_path.exists():
        training_sessions = json.loads(training_path.read_text()).get("sessions", [])

    # Initialise per-screen-location structure
    entries = {
        lid: {
            "default": {
                "type": "idle",
                "audience": {"section": "all", "teams": [], "label": None},
                "detail": {},
            },
            "dates": {},
        }
        for lid in screen_loc_ids
    }

    # --- Home matches ---
    for team_id, matches in all_fixtures.items():
        for m in matches:
            if not m.get("is_home"):
                continue
            loc_id = loc_lookup.get((m.get("ground_name") or "").lower())
            if not loc_id or loc_id not in screen_loc_ids:
                continue
            match_time = m.get("match_time")
            if not match_time:
                continue
            try:
                iso_date = datetime.strptime(m["match_date"], "%d/%m/%Y").date().isoformat()
            except (ValueError, KeyError):
                continue

            main_end = add_minutes(match_time, match_p["main_duration_mins"])
            entry = {
                "type": "match",
                "audience": {
                    "section": infer_section([team_id]),
                    "teams": [team_id],
                    "label": None,
                },
                "phases": {
                    "warm_up":   {"start": add_minutes(match_time, -match_p["warm_up_mins"]), "end": match_time},
                    "main":      {"start": match_time, "end": main_end},
                    "wind_down": {"start": main_end, "end": add_minutes(main_end, match_p["wind_down_mins"])},
                },
                "detail": {
                    "competition": m.get("competition_name", ""),
                    "opposition": m.get("opposition_club_name") or m.get("opposition_name", ""),
                    "is_home": True,
                },
            }
            entries[loc_id]["dates"].setdefault(iso_date, []).append(entry)

    # --- Training sessions ---
    # Merge concurrent sessions at the same location/date/slot into one entry
    training_groups: dict = {}
    for s in training_sessions:
        loc_id = s.get("location_id")
        if not loc_id or loc_id not in screen_loc_ids:
            continue
        key = (loc_id, s.get("date"), s.get("time_start"), s.get("time_end"))
        if None in key:
            continue
        if key not in training_groups:
            training_groups[key] = set()
        training_groups[key].update(s.get("team_ids", []))

    for (loc_id, iso_date, time_start, time_end), team_ids in training_groups.items():
        team_ids_list = sorted(team_ids)
        entry = {
            "type": "training",
            "audience": {
                "section": infer_section(team_ids_list),
                "teams": team_ids_list,
                "label": None,
            },
            "phases": {
                "warm_up":   {"start": add_minutes(time_start, -training_p["warm_up_mins"]), "end": time_start},
                "main":      {"start": time_start, "end": time_end},
                "wind_down": {"start": time_end, "end": add_minutes(time_end, training_p["wind_down_mins"])},
            },
            "detail": {},
        }
        entries[loc_id]["dates"].setdefault(iso_date, []).append(entry)

    # Stretch each match's wind-down to the end of the day. The fixed
    # wind_down_mins expires mid-evening and drops the screen back to `idle`,
    # which on a match day is wrong twice over: the bar is at its fullest, and
    # `idle` is the context in which the last-match archive and the team boards
    # are visible — so last week's game would walk back into the loop alongside
    # today's result. Instead a match owns its ground until midnight, or until
    # the next activity there, whichever comes first. Clamping to the next
    # ACTIVITY (not just the next match) matters because match outranks training
    # in ACTIVITY_PRIORITY, so an unclamped wind-down would swallow an evening
    # junior session at the same ground.
    for loc_id in entries:
        for iso_date, date_entries in entries[loc_id]["dates"].items():
            for entry in date_entries:
                if entry["type"] != "match":
                    continue
                wind = entry["phases"]["wind_down"]
                starts = [o["phases"]["warm_up"]["start"] for o in date_entries
                          if o is not entry and o["phases"]["warm_up"]["start"] > wind["start"]]
                wind["end"] = min(starts) if starts else "24:00"

    # Standing weekly entries (recurring_events_on) — currently the Members Bar.
    # Added AFTER the stretch above so they're not candidates to clamp a match's
    # wind-down: a home match keeps its ground for the whole evening, and the bar
    # only ever fills a window nothing else covers. `main` is the only phase — a
    # bar has no warm-up.
    today = _today()
    horizon = today + timedelta(days=RECURRING_HORIZON_DAYS)
    counts = {}
    d = today
    while d <= horizon:
        for ev in recurring_events_on(d):
            for loc_id in ev.get("locations", []):
                if loc_id not in screen_loc_ids:
                    continue
                entries[loc_id]["dates"].setdefault(d.isoformat(), []).append({
                    "type": ev.get("type", "club_event"),
                    "audience": {"section": ev.get("section", "all"), "teams": [],
                                 "label": ev.get("title")},
                    "phases": {"main": {"start": ev["start"], "end": ev.get("end", "24:00")}},
                    "detail": {"title": ev.get("title")},
                })
                counts[ev.get("title")] = counts.get(ev.get("title"), 0) + 1
        d += timedelta(days=1)
    for title, n in counts.items():
        print(f"  recurring: {title} — {n} occurrence(s) to {horizon.isoformat()}")

    # Sort entries within each date by activity priority
    for loc_id in entries:
        for iso_date in entries[loc_id]["dates"]:
            entries[loc_id]["dates"][iso_date].sort(
                key=lambda e: ACTIVITY_PRIORITY.get(e["type"], 99)
            )

    calendar = {"generated_at": _today().isoformat(), "entries": entries}
    out_path = SITE / "context_calendar.json"
    out_path.write_text(json.dumps(calendar, indent=2))
    print("  context_calendar.json")


def build_slides(env):
    teams_by_id = load_teams()
    config = load_config()
    lb_config = config.get("leaderboards", {})
    default_panel_duration = config.get("default_panel_duration", 20)

    # Per-slug timing/visibility, consumed by build_slideshows. Each slide's total
    # on-screen duration is derived: panel_duration × panel count. A slide with no
    # panels (no data this build) is marked _skip and never emitted.
    slide_meta = {}

    _stats_cache = {}

    def load_stats(label):
        if label not in _stats_cache:
            path = FETCHED / f"player_stats_{label}.json"
            _stats_cache[label] = json.loads(path.read_text()) if path.exists() else None
        return _stats_cache[label]

    _honours_cache = {}

    def load_honours(name):
        if name not in _honours_cache:
            base = CONTENT / "data" if name.startswith("historic_") else FETCHED
            path = base / f"{name}.json"
            _honours_cache[name] = json.loads(path.read_text()) if path.exists() else None
        return _honours_cache[name]

    def load_records():
        """The four per-innings record feeds behind the team Highlights tab.
        Each is independently optional — a missing file empties its cards, not
        the tab."""
        return {
            "knocks": load_honours("season_top_knocks_this_season"),
            "partnerships": load_honours("season_partnerships_this_season"),
            "spells": load_honours("season_bowling_spells_this_season"),
            "fielding": load_honours("season_fielding_this_season"),
        }

    _fixtures_cache = {}

    def load_fixtures():
        if "data" not in _fixtures_cache:
            path = FETCHED / "fixtures.json"
            _fixtures_cache["data"] = json.loads(path.read_text()) if path.exists() else None
        return _fixtures_cache["data"]

    _schedule_cache = {}

    def load_schedule_data():
        if "data" not in _schedule_cache:
            locs_path = CONTENT / "locations.json"
            locs = json.loads(locs_path.read_text())["locations"] if locs_path.exists() else []
            loc_names = {loc["id"]: loc["name"] for loc in locs}
            loc_lookup = {}
            for loc in locs:
                for alias in loc["aliases"]:
                    loc_lookup[alias.lower()] = loc["id"]
            training_path = FETCHED / "cs365_training.json"
            training = json.loads(training_path.read_text())["sessions"] if training_path.exists() else []
            fixtures_data = load_fixtures()
            all_fixtures = (fixtures_data or {}).get("all_fixtures", {})
            _schedule_cache["data"] = (training, all_fixtures, loc_lookup, loc_names)
        return _schedule_cache["data"]

    for slide_path in sorted((CONTENT / "slides").glob("*.json")):
        slide = json.loads(slide_path.read_text())
        slug = slide_path.stem

        if slide.get("template") == "league-table" and "team" in slide:
            team = teams_by_id[slide["team"]]
            data_path = FETCHED / f"league_table_{team['play_cricket_league_id']}.json"
            slide["_data"] = json.loads(data_path.read_text())
            slide["_highlight_team_id"] = str(team["play_cricket_team_id"])
            slide["_team"] = team
        elif "data" in slide:
            data_path = ROOT / slide["data"]
            slide["_data"] = json.loads(data_path.read_text())

        if slide.get("template") == "fantasy-league":
            for tab_key, file_key in [
                ("_player_standings", "fantasy_player_standings"),
                ("_team_standings",   "fantasy_team_standings"),
                ("_team_of_week",     "fantasy_team_of_week"),
            ]:
                data_path = FETCHED / f"{file_key}.json"
                slide[tab_key] = json.loads(data_path.read_text()) if data_path.exists() else FANTASY_EMPTY
            build_fantasy_teams(
                slide, teams_by_id, load_fixtures(), slide["_player_standings"]
            )

        if slide.get("template") == "cta" and "qr_url" in slide:
            slide["_qr_data_url"] = generate_qr_data_url(slide["qr_url"])

        if slide.get("template") == "sponsors":
            sponsorship_url = config.get("preview", {}).get("sponsorship_url", "")
            if sponsorship_url:
                slide["_qr_data_url"] = generate_qr_data_url(sponsorship_url)

        if slide.get("template") == "league-positions":
            build_league_positions(slide, teams_by_id, load_stats("this_season"))

        if slide.get("template") == "next-match":
            build_next_match(slide, teams_by_id, load_fixtures(), load_stats("this_season"))

        if slide.get("template") == "schedule":
            training, all_fixtures, loc_lookup, loc_names = load_schedule_data()
            build_schedule(slide, teams_by_id, training, all_fixtures, loc_lookup, loc_names)

        if slide.get("template") == "team":
            build_team(
                slide, teams_by_id, load_fixtures(),
                load_stats("this_season"), lb_config, load_records(),
            )

        if slide.get("template") == "honours":
            build_honours(
                slide,
                load_honours("historic_batting_hundreds"),
                load_honours("season_batting_hundreds_this_season"),
                load_honours("historic_bowling_sixplus"),
                load_honours("season_bowling_sixplus_this_season"),
            )

        if slide.get("template") in LEADERBOARD_TEMPLATES:
            if slide.get("competition") == "league" and slide.get("team"):
                team = teams_by_id.get(slide["team"])
                if team and "play_cricket_league_id" in team:
                    slide["competition"] = str(team["play_cricket_league_id"])
            stats = load_stats("this_season")
            if stats:
                build_leaderboard(slide, stats, lb_config)

        if slide.get("template") == "video":
            build_video_slide(slide)

        # Today board: bake the whole day's club activity (all teams' matches +
        # training) into the slide so it renders statically (offline / no-feed) —
        # the live feed only enriches the match rows.
        if slide.get("template") == "today":
            training, all_fx, loc_lookup, loc_names = load_schedule_data()
            slide["_events"] = todays_events(
                teams_by_id, training, all_fx, loc_lookup, loc_names,
                _load_yt_broadcasts(), _load_live_seed())
            attach_league_context(slide["_events"], teams_by_id)
            # Nothing on today → nothing to say. The slide is still built and stays
            # available to any deck that wants it; it's the slideshow entry that opts
            # out, via skip_when_empty (see build_slideshows). The today board needs
            # no team/section gating — it's the whole club's day — so an empty day is
            # the only reason a screen wouldn't show it.
            slide["_empty"] = not slide["_events"]

        if slide.get("template") == "league-table" and "_data" in slide:
            for table in slide["_data"]["league_table"]:
                ordered = sorted(
                    table["headings"].items(),
                    key=lambda x: int(x[0].split("_")[1]),
                )
                ordered = [
                    (k, v) for k, v in ordered
                    if k == "column_1" or v.lower() not in LEAGUE_TABLE_EXCLUDED
                ]
                team_col  = [(k, v) for k, v in ordered if k == "column_1"]
                pts_cols  = [(k, v) for k, v in ordered if k != "column_1" and v.lower() == "pts"]
                rest_cols = [(k, v) for k, v in ordered if k != "column_1" and v.lower() != "pts"]
                table["headings_list"] = team_col + rest_cols + pts_cols
                table["rows"] = table["values"]

        # Panel count drives the derived duration: a data-driven `_panels` list
        # (team) wins; video slides set _override_duration and own their timing;
        # otherwise a fixed-carousel count; otherwise a plain slide is one panel.
        # Zero panels means no data this build — skip the slide.
        if "_panels" in slide:
            panel_count = len(slide["_panels"])
        elif slide.get("_override_duration"):
            panel_count = 1  # duration already computed by build_video_slide
        else:
            panel_count = len(FIXED_PANEL_LABELS.get(slide.get("template")) or [None])
        if panel_count == 0:
            slide_meta[slug] = {"_skip": True}
            print(f"  slide/{slug} — skipped (no panels)")
            continue

        if not slide.get("_override_duration"):
            panel_duration = slide.get("panel_duration", default_panel_duration)
            slide["panel_duration"] = panel_duration
            slide["duration"] = panel_duration * panel_count

        # The tab strip, for the template to render from (see the `panel_nav` macro).
        # Same list the atoms are named from, so what the wall shows and what the
        # editor tools call a panel are the same string by construction.
        panel_labels = slide_panel_labels(slide)
        if panel_labels:
            slide["_panel_labels"] = panel_labels

        slide_meta[slug] = {
            "slide_active": slide.get("active", True),
            "slide_expires": slide.get("expires"),
            # Label + kind, for the slide catalogue the deck builder browses
            # (site/slides.json) — see slide_title. They ride in slide_meta because
            # that is the only thing build_slideshows has when it writes the index;
            # flowing on into each deck entry is a small bonus, since an editor-built
            # deck's rows can then name themselves from data.json alone.
            "_title": slide_title(slide, slug),
            "_template": slide.get("template"),
            "duration": slide["duration"],
            "panel_duration": slide["panel_duration"],
            "_atoms": slide_atoms(slide, slug, panel_count, slide["panel_duration"]),
            "_videos": slide_video_srcs(slide),
            # Built, but with no data behind it this build. Decks opt out per entry
            # with skip_when_empty rather than the slide vanishing everywhere.
            "_empty": bool(slide.get("_empty")),
        }

        template = env.get_template(f"slides/{slide['template']}.html")
        html = template.render(slide=slide, slug=slug)

        out_dir = SITE / "slide" / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(html)
        print(f"  slide/{slug}")

    return slide_meta



def team_preview_performers(stats, team_id, match, n_bat=2, n_bowl=2):
    """Spoiler-safe Preview performers: the team's leading batters (by runs) and
    bowlers (by wickets) this season, with THIS match's contribution *subtracted*
    so the figures read as they stood going into the game. Anyone whose player id
    is absent from this match's XI (batted or bowled) is flagged `out`.

    Returns a list of performer dicts (batters then bowlers), each shaped for the
    match-intro performer rows: category / name / primary / secondary / out.
    Secondary stats are limited to subtractable aggregates (avg, SR, economy) —
    max-style figures like HS/best can't be recovered pre-match from aggregates.
    """
    if not stats:
        return []
    # This match's per-player contribution + participants, keyed by player id.
    bat_by_id = {b.get("id"): b for b in (match.get("our_batting") or []) if b.get("id")}
    bowl_by_id = {b.get("id"): b for b in (match.get("our_bowling") or []) if b.get("id")}
    played_ids = set(bat_by_id) | set(bowl_by_id)

    def avg(runs, dismissals):
        return f"{runs / dismissals:.1f}" if dismissals > 0 else "-"

    bats, bowls = [], []
    for pid, p in stats.get("players", {}).items():
        block = get_leaderboard_block(p, team_id, None)
        if not block:
            continue
        b, bw = block["batting"], block["bowling"]
        mb, mbw = bat_by_id.get(pid), bowl_by_id.get(pid)
        out = pid not in played_ids

        # Pre-match batting (subtract this innings if they batted).
        runs = b["runs"] - (int(mb["runs"] or 0) if mb else 0)
        inns = b["innings"] - (1 if mb else 0)
        nos = b["not_outs"] - (1 if mb and mb.get("not_out") else 0)
        balls = b["balls"] - (int(mb.get("balls") or 0) if mb else 0)
        if inns > 0 and runs >= 0:
            sr = f"{runs / balls * 100:.0f}" if balls > 0 else "-"
            bats.append({"category": "bat", "name": p["name"], "_rank": runs, "out": out,
                         "primary": str(runs), "unit": "runs", "secondary": f"avg {avg(runs, inns - nos)} · SR {sr}"})

        # Pre-match bowling (subtract this spell if they bowled).
        wkts = bw["wickets"] - (int(mbw["wickets"] or 0) if mbw else 0)
        bruns = bw["runs"] - (int(mbw["runs"] or 0) if mbw else 0)
        bballs = bw["balls"] - (int(mbw.get("balls") or 0) if mbw else 0)
        if wkts > 0:
            econ = f"{bruns / (bballs / 6):.1f}" if bballs > 0 else "-"
            bowls.append({"category": "bowl", "name": p["name"], "_rank": wkts, "out": out,
                          "primary": str(wkts), "unit": "wkts", "secondary": f"avg {avg(bruns, wkts)} · econ {econ}"})

    bats.sort(key=lambda x: -x["_rank"])
    bowls.sort(key=lambda x: -x["_rank"])
    return bats[:n_bat] + bowls[:n_bowl]


def team_current_performers(stats, team_id, n_bat=2, n_bowl=2, published_names=None):
    """Season-to-date leading batters (by runs) and bowlers (by wickets) for the
    Next Match preview and the live slide's Pre-match tape, shaped for the shared
    tale-of-the-tape performer rows. Like team_preview_performers but with nothing
    to subtract (the match hasn't happened), so the figures read as current season
    totals. `published_names` (a set of `_norm_name`'d published-XI names) flags a
    leader absent from today's XI as `out`; without it the XI is unknown → none are."""
    if not stats:
        return []

    def avg(runs, dismissals):
        return f"{runs / dismissals:.1f}" if dismissals > 0 else "-"

    def is_out(name):
        return bool(published_names) and _norm_name(name) not in published_names

    bats, bowls = [], []
    for p in stats.get("players", {}).values():
        block = get_leaderboard_block(p, team_id, None)
        if not block:
            continue
        b, bw = block["batting"], block["bowling"]
        out = is_out(p["name"])
        if b["innings"] > 0:
            sr = f"{b['runs'] / b['balls'] * 100:.0f}" if b["balls"] > 0 else "-"
            bats.append({"category": "bat", "name": p["name"], "_rank": b["runs"], "out": out,
                         "primary": str(b["runs"]), "unit": "runs",
                         "secondary": f"avg {avg(b['runs'], b['innings'] - b['not_outs'])} · SR {sr}"})
        if bw["wickets"] > 0:
            econ = f"{bw['runs'] / (bw['balls'] / 6):.1f}" if bw["balls"] > 0 else "-"
            bowls.append({"category": "bowl", "name": p["name"], "_rank": bw["wickets"], "out": out,
                          "primary": str(bw["wickets"]), "unit": "wkts",
                          "secondary": f"avg {avg(bw['runs'], bw['wickets'])} · econ {econ}"})

    bats.sort(key=lambda x: -x["_rank"])
    bowls.sort(key=lambda x: -x["_rank"])
    return bats[:n_bat] + bowls[:n_bowl]


def opp_preview_performers(opp_performers, n_bat=2, n_bowl=2):
    """Shape the fetched opposition top performers (already pre-match, from
    `fetch_opposition_data`) into the match-intro performer rows, mirroring our
    side's `team_preview_performers` output. No `out` tag — spoiler-safe previews
    don't assume the opposition XI."""
    if not opp_performers:
        return []

    def fig(v):  # 1 dp to match our side's performer figures; "-" when absent
        return f"{v:.1f}" if isinstance(v, (int, float)) else "-"

    out = []
    for b in (opp_performers.get("batting") or [])[:n_bat]:
        hs = b.get("high_score")
        secondary = f"avg {fig(b.get('average'))}"
        if hs is not None:
            secondary += f" · HS {hs}{'*' if b.get('high_score_not_out') else ''}"
        out.append({"category": "bat", "name": b["name"], "out": False,
                    "primary": str(b.get("runs", 0)), "unit": "runs", "secondary": secondary})
    for b in (opp_performers.get("bowling") or [])[:n_bowl]:
        out.append({"category": "bowl", "name": b["name"], "out": False,
                    "primary": str(b.get("wickets", 0)), "unit": "wkts",
                    "secondary": f"avg {fig(b.get('average'))} · econ {fig(b.get('economy'))}"})
    return out


def build_league_panel(team):
    """Current league table for a team, with headings_list/rows prepared exactly
    as the team slide's League tab. Returns (league_data, team_id_str, league_name)
    or None when the team has no league table."""
    league_id = team.get("play_cricket_league_id")
    if not league_id:
        return None
    path = FETCHED / f"league_table_{league_id}.json"
    if not path.exists():
        return None
    league_data = json.loads(path.read_text())
    for table in league_data.get("league_table", []):
        ordered = sorted(table["headings"].items(), key=lambda x: int(x[0].split("_")[1]))
        ordered = [(k, v) for k, v in ordered if k == "column_1" or v.lower() not in LEAGUE_TABLE_EXCLUDED]
        team_col = [(k, v) for k, v in ordered if k == "column_1"]
        pts_cols = [(k, v) for k, v in ordered if k != "column_1" and v.lower() == "pts"]
        rest_cols = [(k, v) for k, v in ordered if k != "column_1" and v.lower() != "pts"]
        table["headings_list"] = team_col + rest_cols + pts_cols
        table["rows"] = table["values"]
    return league_data, str(team.get("play_cricket_team_id", "")), team.get("league_name", "")


def _chrono_innings_ids(merged):
    """Ball-event innings ids ordered by first real-world clip time (1st, 2nd, …).

    A positional innings index (0 = batted first) maps to the same innings the
    scorecard shows, so reel clips land under the right innings phase.
    """
    if not merged:
        return []
    firsts = {}
    for e in merged.get("events", []):
        inn = e.get("innings")
        if inn is None:
            continue
        dt = e.get("dt_unix") or 0
        if inn not in firsts or dt < firsts[inn]:
            firsts[inn] = dt
    return sorted(firsts, key=lambda inn: firsts[inn])


def build_match_packages(env, slide_meta):
    """Generate the per-team 'latest match' package from Play Cricket data.

    For every team with a completed last match, emits a slide *set*
    `last-match-{team}` whose ordered members are, spoiler-safe:
        intro → 1st-innings scorecard → 2nd-innings scorecard → result summary
    A scorecard degrades out when its innings has no batting data; the result
    summary (`last-match-result-{team}`, also referenced standalone for the light
    'latest result' slot) degrades out when there is nothing to report. The intro
    is spoiler-safe (no result, no league position). Per-innings clip reels slot
    in between the scorecards in a later phase.

    Renders each member slide, records its meta into `slide_meta`, and returns the
    sets registry {set_slug: {members, group, active, expires}} for build_slideshows.
    """
    teams_by_id = load_teams()
    config = load_config()
    default_panel_duration = config.get("default_panel_duration", 20)
    max_age = config.get("last_match_max_age_days", 10)

    fixtures_path = FETCHED / "fixtures.json"
    fixtures_data = json.loads(fixtures_path.read_text()) if fixtures_path.exists() else {}
    last_matches = fixtures_data.get("last_match", {}) or {}
    stats_path = FETCHED / "player_stats_this_season.json"
    stats = json.loads(stats_path.read_text()) if stats_path.exists() else None

    intro_tmpl = env.get_template("slides/match-intro.html")
    sc_tmpl = env.get_template("slides/scorecard.html")
    result_tmpl = env.get_template("slides/match-result.html")
    league_tmpl = env.get_template("slides/match-league.html")
    video_tmpl = env.get_template("slides/video.html")

    def emit(slug, template, slide, expires=None, recency=None, empty=False):
        slide["duration"] = default_panel_duration
        slide["panel_duration"] = default_panel_duration
        html = template.render(slide=slide, slug=slug)
        out_dir = SITE / "slide" / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(html)
        slide_meta[slug] = {
            "slide_active": True,
            "slide_expires": expires,
            "_title": slide_title(slide, slug),
            # `template` is the Jinja object here, not a name; its `.name` is the
            # load path, e.g. `slides/match-intro.html` -> `match-intro`.
            "_template": Path(template.name).stem,
            "duration": default_panel_duration,
            "panel_duration": default_panel_duration,
            "_atoms": slide_atoms(slide, slug, 1, default_panel_duration),
            # The match this slide reports on, ISO. A run of consecutive
            # recency-bearing slides in a deck plays newest first — see
            # build_slideshows.
            "_recency": recency,
            # Nothing was published for this match — no scorecard, no result. The
            # slide still renders (saying so) for the results rotation, which keeps
            # one card per team; decks that would rather show nothing opt out with
            # skip_when_empty.
            "_empty": empty,
        }
        print(f"  slide/{slug}")

    sets = {}

    # Each job renders one match package. The live "last match" per team plus any
    # pinned matches (dedicated sets that survive a team moving on to newer games —
    # see load_pinned_matches). A pin reuses its team's real team_id for crest /
    # stats / league lookups but takes its own slug prefix and heading, and skips
    # the standalone latest-result card (that slot belongs to the live last match).
    # `set_title` is the wall heading; `archive_title` replaces it under
    # ?ctx=archive (slide-bridge.js), the mode the video compositor renders in —
    # "Last Match" is true only on the wall, and false the moment the clip is a
    # standalone YouTube video. See docs/narrated-decks.md.
    # (slug_prefix, team_id, match, set_title, archive_title, standalone_result)
    jobs = [(f"last-match-{tid}", tid, m, "Last Match", "Match Highlights", True)
            for tid, m in sorted(last_matches.items())]
    for pin in load_pinned_matches():
        if not pin.get("_package"):
            print(f"  pinned match '{pin.get('slug')}': missing package snapshot — skipped")
            continue
        pin_title = pin.get("title", "Match Highlights")
        jobs.append((pin["slug"], pin["team_id"], pin["_package"],
                     pin_title, pin_title, False))

    for slug_prefix, team_id, m, set_title, archive_title, standalone_result in jobs:
        team = teams_by_id.get(team_id, {})
        title = team.get("name", team_id)

        league_name = team.get("league_name", "")
        comp_name = m.get("competition_name", "") or ""
        if league_name and comp_name and comp_name != league_name:
            competition_display = f"{league_name} · {comp_name}"
        else:
            competition_display = league_name or comp_name
        opp_club, opp_team = _split_opp_name(
            m.get("opposition_name", ""), m.get("opposition_club_name", "")
        )
        # Every name on these slides is a cricket club, so " CC" says nothing and
        # costs width in tight boxes (the reel tag, the two-column result). Stripped
        # once here and at OUR_CLUB below, which covers the subtitle, the tape, the
        # toss line, the innings headlines, the result columns and description, and
        # the reel tag. The ground badge keeps its full name — that's a place.
        opp_club = drop_cc(opp_club)
        date_formatted = fmt_match_date(m.get("match_date", ""))
        ground = m.get("ground_name") or ""
        is_home = m.get("is_home", True)
        we_bat_first = m.get("we_bat_first", True)
        our_total_str = _short_innings_total(m.get("our_total"))
        result = m.get("result")

        # Curated highlight clips for this match (None for teams with no ball-event
        # fetch/curation). `innings_ids_chrono[i]` is the ball-event innings id for
        # the i-th scorecard innings, so reels attach to the right phase.
        merged = ball_events.load_merged(str(m.get("match_id") or ""))
        innings_ids_chrono = _chrono_innings_ids(merged)

        our_batting = _fmt_batting_rows(m.get("our_batting", []) or [])
        our_bowling = _fmt_bowling_rows(m.get("our_bowling", []) or [])
        their_batting = _fmt_batting_rows(m.get("their_batting", []) or [])
        their_bowling = _fmt_bowling_rows(m.get("their_bowling", []) or [])

        # Each innings splits into two full-width slides under the same strip step
        # (labels stay innings-level): batting then bowling. Both carry the innings
        # headline (batting club + readable score).
        # (batting_club, total, batting_rows, bowling_club, bowling_rows)
        our_innings = (OUR_CLUB, m.get("our_total"), our_batting, opp_club, their_bowling)
        their_innings = (opp_club, m.get("their_total"), their_batting, OUR_CLUB, our_bowling)
        ordered = [our_innings, their_innings] if we_bat_first else [their_innings, our_innings]
        labels = ["1st Innings", "2nd Innings"]
        innings_present = []   # unique innings labels with any content (for the strip)
        innings_members = []   # (innings_idx, slug, phase_label, slide_fields)
        innings_bat_club = {}  # innings_idx -> batting club (for the reel title)
        for i, (bat_club, total, batting, bowl_club, bowling) in enumerate(ordered):
            if not batting and not bowling:
                continue
            label = labels[i]
            innings_present.append(label)
            innings_bat_club[i] = bat_club
            _score, _overs = _split_innings_total(total)
            scoreline = {"_bat_club": bat_club, "_score_readable": _score, "_score_overs": _overs}
            if batting:
                innings_members.append((i, f"{slug_prefix}-innings-{i + 1}-batting", label, {
                    "_mode": "batting", "_batting": batting,
                    "_extras": innings_extras(total, batting),
                    "_extras_parts": extras_breakdown_str(total), **scoreline,
                }))
            if bowling:
                innings_members.append((i, f"{slug_prefix}-innings-{i + 1}-bowling", label, {
                    "_mode": "bowling", "_bowling": bowling, "_bowl_club": bowl_club, **scoreline,
                }))
        # Did this match reach an OUTCOME worth reporting? A result covers the cases
        # where nobody batted much (abandoned, conceded — Play-Cricket still records
        # a result), otherwise we need our own total. Deliberately NOT the
        # opposition's total on its own: a record abandoned part-way through
        # live-scoring keeps a one-sided stub (their 0-1 off 18 overs, our side
        # blank, no result) which reads as a match report but says nothing.
        has_result = bool(result or our_total_str)

        # The three heading levels: Title (set label) + Subtitle (team · date) are
        # constant across the set — kept data-driven so a later renderer (e.g. the
        # MP4 export) can override them. The sequence strip is the third level: one
        # entry per *phase*, and a phase can span several slides — Highlights,
        # Batting and Bowling are all "1st Innings". The result is the terminal
        # payoff and doubles as the standalone latest-result slide, so it carries
        # the shared header but no strip. League table is the final phase for
        # league teams (safe post-result).
        league_panel = build_league_panel(team)
        phases = (["Pre-match"] + innings_present
                  + (["Result"] if has_result else [])
                  + (["League"] if league_panel else []))
        iso = _iso_from_dmy(m.get("match_date", ""))
        if iso:
            _dt = datetime.strptime(iso, "%Y-%m-%d")
            # Year included: a match package IS the club record, and the archive
            # render (see _set_title_archive) is watched long after the season.
            date_short = _dt.strftime(f"%a {_dt.day} %b %Y")
        else:
            date_short = ""
        # Shared header fields. Subtitle is the team only; the match context (date,
        # venue, opposition, ground) lives in the right-hand meta, mirroring the
        # left side of the team slide's Schedule tile (right-aligned here).
        set_meta_fields = {
            "_set_date": date_short,
            "_set_is_home": is_home,
            "_set_opp_club": opp_club,
            "_set_opp_team": opp_team,
            "_set_ground": ground,
        }
        set_common = {"_set_title": set_title, "_set_title_archive": archive_title,
                      "_set_subtitle": title, **set_meta_fields}

        def with_strip(phase):
            return {**set_common, "_set_phases": phases, "_set_phase": phases.index(phase)}

        # Per-innings highlight reel: the curated match clips for one innings, in
        # chronological order, as a single fullbleed video slide slotted before that
        # innings' scorecards (same phase step). Only clips already synced to R2 (i.e.
        # resolved in the video manifest) are kept.
        #
        # An innings with no playable clips still BUILDS the slide — page, slide_meta,
        # auto-deck — flagged `_empty`, and is simply not added to the set. It used to
        # return None and not exist at all, which broke the one-sitting constraint
        # (docs/narrated-decks.md): on Night 1 there is no committed curation overlay,
        # so `select` returns nothing, so the reel slide the editor is about to curate
        # and narrate over does not exist — no row in /deck to attach clips to, no page
        # for the preview iframe, and nothing for compose.py to shoot the overlay layer
        # from. Building it empty costs one unreferenced page and gives the sitting a
        # real slide to inject `set-clips` into; the publisher's rebuild then fills the
        # same slug with R2 clips and the set picks it up.
        #
        # Returns the slug only when there is something to play, so the wall's set is
        # unchanged either way.
        def emit_reel(innings_idx, label):
            if innings_idx >= len(innings_ids_chrono):
                return None
            clips = list(reversed(ball_events.select(
                merged, "match", innings=innings_ids_chrono[innings_idx])))
            slug = f"{slug_prefix}-innings-{innings_idx + 1}-reel"
            # A solid top-left tag conceals the Frogbox HIGHLIGHTS/QR bug and shows
            # the innings + the batting team's crest (WCC's for our innings, the
            # opposition's otherwise) — the same crest used on the intro/result.
            bat_club = innings_bat_club.get(innings_idx, "")
            bat_crest = ("/assets/images/wcc-logo.png"
                         if "wendover" in bat_club.lower() else m.get("opposition_crest"))
            # The tag names both sides in full (club + XI), ordered by who batted
            # FIRST in the match — a fixed order across both reels — with a gold dot
            # on whoever is batting in this one. The order and the dot together are
            # the innings: dot on the top side = 1st innings, dot on the bottom =
            # 2nd. Re-sorting per reel would destroy that signal, leaving the dot
            # always on top and nothing to distinguish the two reels.
            # Club and XI kept apart: the template gives the designation the smaller
            # muted treatment the header subtitle uses (.sub-opp-sub).
            we_bat = "wendover" in bat_club.lower()
            ours = {"club": OUR_CLUB, "desig": title, "batting": we_bat}
            theirs = {"club": opp_club, "desig": opp_team, "batting": not we_bat}
            sides = [ours, theirs] if we_bat_first else [theirs, ours]
            # Resolve each clip's cards to rendered content and place them on the
            # played clip's timeline. The R2 file is trimmed to the *played* bounds,
            # so t=0 is `start`: a pre card sits over the lead-in [0, action_start],
            # a post card over the lead-out [action_end, end] (clip-relative seconds).
            # An unresolvable card (subject not found in stats/scorecard) is dropped.
            videos = []
            for c in clips:
                cards = []
                resolved = ball_events.resolve_cards(c, scorecard=m, player_stats=stats, team_id=team_id)
                if len(resolved) < len(c.get("cards") or []):
                    print(f"    ! {slug}: dropped {len(c['cards']) - len(resolved)} "
                          f"unresolvable card(s) on clip {c.get('id')}")
                for rc in resolved:
                    if rc["at"] == "pre":
                        window = [0, round(c["action_start"] - c["start"], 3)]
                    else:
                        window = [round(c["action_end"] - c["start"], 3),
                                  round(c["end"] - c["start"], 3)]
                    cards.append({**rc, "window": window})
                videos.append({"url": c["url"], "start": c["start"], "end": c["end"],
                               "body": c["body"], "type": c["type"], "cards": cards})
            slide = {
                "template": "video", "layout": "fullbleed", "reel": True,
                "title": f"{label} Highlights",  # page <title> only; not shown on the wall
                # Top-left square echoes this reel's host set-header: the same title
                # it carries, then both sides in batting order (_rt_sides). Full
                # set_common rather than a hand-picked few, because the archive render
                # also shows the date/venue meta the static members' headers carry.
                # _bat_crest is kept for possible reuse but isn't shown in the square.
                **set_common,
                "_innings_label": label, "_bat_crest": bat_crest, "_rt_sides": sides,
                "videos": videos,
            }
            build_video_slide(slide)
            slide["videos"] = [v for v in slide["videos"] if v.get("_video_src")]
            build_video_slide(slide)  # recompute duration for the resolved-only set
            out_dir = SITE / "slide" / slug
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "index.html").write_text(video_tmpl.render(slide=slide, slug=slug))
            slide_meta[slug] = {
                "slide_active": True, "slide_expires": None,
                "_title": slide_title(slide, slug), "_template": "video",
                "duration": slide["duration"], "panel_duration": slide["panel_duration"],
                "_atoms": slide_atoms(slide, slug, len(slide["videos"]), slide["panel_duration"]),
                "_videos": slide_video_srcs(slide),
                # Which curation this reel is made of. The editor sitting needs it to
                # get from a reel row back to /curate (and, later, to resolve the reel's
                # clips live from the curation draft) — see docs/narrated-decks.md,
                # "Clips reach a deck by reference, not by copy".
                "_pc_id": str(m.get("match_id") or ""),
                "_innings": innings_ids_chrono[innings_idx],
                # What is in R2, and for exactly which bounds. An editor amending
                # curation mid-sitting produces clips this build never fetched; the
                # only way to know which ones are already files is to compare against
                # what was built, and (url, start, end) IS the identity — it is what
                # clip_ids.fingerprint hashes to name the R2 object.
                "_clips": [{"url": v["url"], "start": v["start"], "end": v["end"],
                            "src": v["_video_src"]} for v in slide["videos"]],
                # No clips yet — curated but unsynced, or not curated at all. The slide
                # exists for the editor sitting; nothing plays it until it is filled.
                "_empty": not slide["videos"],
            }
            if not slide["videos"]:
                print(f"  slide/{slug} — reel (empty: no clips yet; built for /deck, "
                      f"not in the set)")
                return None
            print(f"  slide/{slug} — reel ({len(slide['videos'])} clips, {slide['duration']:.0f}s)")
            return slug

        members = []

        # Preview = spoiler-safe tale of the tape. Our side is populated now; the
        # opposition side (crest / form / top performers) needs new fetching and is
        # rendered as a visible TODO. Pre-match form = the season stats form (sorted
        # chronological, last 5) with THIS match — the newest entry — dropped. H2H =
        # an earlier meeting this season vs the same opponent, if in recent history.
        recent = (fixtures_data.get("recent_matches") or {}).get(team_id) or []
        prior = [r for r in recent if r.get("match_id") != m.get("match_id")]
        form_all = ((stats or {}).get("form", {}).get(team_id) or {}).get("all", [])
        # Drop this match (the newest entry) when it produced a result, then show
        # the most recent 5 available.
        our_form = (form_all[:-1] if result else form_all)[-5:]
        our_performers = team_preview_performers(stats, team_id, m)
        opp_form = m.get("opposition_form") or []
        opp_performers = opp_preview_performers(m.get("opposition_performers"))
        opp_crest = m.get("opposition_crest")
        h2h_match = next((r for r in prior
                          if str(r.get("opposition_team_id")) == str(m.get("opposition_team_id"))), None)
        h2h = ""
        if h2h_match and h2h_match.get("result"):
            h2h = f"Earlier this season · {_RESULT_LABELS.get(h2h_match['result'], h2h_match['result'])}"

        # Toss line for the footer: prefer a clean constructed sentence (winner +
        # bat/field), falling back to the API's raw text; empty when unknown.
        toss_won_us = m.get("toss_won_by_us")
        toss_bat = m.get("toss_elected_bat")
        if toss_won_us is not None and toss_bat is not None:
            toss_winner = OUR_CLUB if toss_won_us else opp_club
            toss_line = f"{toss_winner} won the toss and elected to {'bat' if toss_bat else 'field'}"
        else:
            toss_line = m.get("toss_text") or ""

        # When neither a scorecard nor a result is published (e.g. an unrecorded
        # friendly), the intro footer says so in place of the toss headline.
        if not innings_members and not has_result:
            toss_line = "Match scorecard and result not available"
        # Whether this match earns a slot at all. Broader than the footer wording
        # above: no outcome means nothing to report even when a half-scored record
        # leaves some rows behind, so a match still marked "in progress" days later
        # doesn't stand as a team's latest news. Decks opt out with skip_when_empty;
        # the results rotation keeps its one-card-per-team and says so on the card.
        nothing_to_report = not has_result

        intro_slug = f"{slug_prefix}-intro"
        emit(intro_slug, intro_tmpl, {
            "template": "match-intro", "title": title,
            "_opp_club_name": opp_club,
            "_our_crest": "/assets/images/wcc-logo.png",
            "_our_form": our_form, "_our_performers": our_performers,
            "_opp_crest": opp_crest, "_opp_form": opp_form, "_opp_performers": opp_performers,
            "_division": competition_display, "_toss": toss_line, "_h2h": h2h,
            # Pre-match lists the home team on the left.
            "_our_left": is_home,
            **with_strip("Pre-match"),
        })
        members.append(intro_slug)

        reeled = set()
        for i, sc_slug, label, fields in innings_members:
            if i not in reeled:
                reeled.add(i)
                reel_slug = emit_reel(i, label)
                if reel_slug:
                    members.append(reel_slug)
            emit(sc_slug, sc_tmpl, {
                "template": "scorecard", "title": title,
                **fields, **with_strip(label),
            })
            members.append(sc_slug)

        # Result = two-column tale of the tape: a team-each-side comparison (crest,
        # name, result pill + points + score + performers) over a footer margin line.
        # Renders in two places from one field set: the in-set terminal step (with
        # the sequence strip) and the standalone latest-result card (no strip).
        opp_result = {"W": "L", "L": "W"}.get(result, result)
        result_desc = result_summary(
            result, m.get("our_total"), m.get("their_total"), we_bat_first, OUR_CLUB, opp_club
        )
        set_result_fields = {
            "_no_match": False,
            "_result_desc": result_desc,
            # Result lists the side that batted first on the left.
            "_our_left": we_bat_first,
            "_our_crest": "/assets/images/wcc-logo.png",
            "_our_name": OUR_CLUB,
            "_our_result": result, "_our_result_label": _RESULT_LABELS.get(result, result),
            "_our_points": m.get("our_points"),
            "_our_score": _split_innings_total(m.get("our_total"))[0],
            "_our_overs": _split_innings_total(m.get("our_total"))[1],
            "_our_performers": team_performers(our_batting, our_bowling, their_batting),
            "_opp_crest": m.get("opposition_crest"),
            "_opp_name": opp_club,
            "_opp_result": opp_result, "_opp_result_label": _RESULT_LABELS.get(opp_result, opp_result),
            "_opp_points": m.get("their_points"),
            "_opp_score": _split_innings_total(m.get("their_total"))[0],
            "_opp_overs": _split_innings_total(m.get("their_total"))[1],
            "_opp_performers": team_performers(their_batting, their_bowling, our_batting),
        }
        if has_result:
            set_result_slug = f"{slug_prefix}-result"
            emit(set_result_slug, result_tmpl, {
                "template": "match-result", "title": title,
                **set_result_fields, **with_strip("Result"),
            })
            members.append(set_result_slug)

        # Standalone latest-result card for the results rotation — the same Result
        # tale of the tape minus the sequence strip. Emitted for the live last match
        # only (a pin isn't the team's latest, so it must not claim that slot): when
        # no result or scorecard is published it degrades to crests + team names with
        # a footer note, so every team keeps a results-rotation slide.
        if standalone_result:
            match_iso = _iso_from_dmy(m.get("match_date", ""))
            emit(f"last-match-result-{team_id}", result_tmpl, {
                "template": "match-result", "title": title,
                "_set_title": "Last Match Result", "_set_subtitle": title,
                **set_meta_fields, **set_result_fields,
                "_result_desc": result_desc or "Match scorecard and result not available",
            },
                # Same window as the package it stands in for: a result stops being
                # news at the same age whether it's told in four panels or one.
                expires=_plus_days(match_iso, max_age), recency=match_iso,
                empty=nothing_to_report)

        if league_panel:
            league_data, league_team_id, league_name = league_panel
            league_slug = f"{slug_prefix}-league"
            emit(league_slug, league_tmpl, {
                "template": "match-league", "title": title,
                "_league_data": league_data, "_league_team_id": league_team_id,
                "_league_name": league_name,
                # The two teams in this match, to badge their table rows with the
                # points won here, coloured by result (team_id is a string in the
                # league table rows).
                "_opp_team_id": str(m.get("opposition_team_id") or ""),
                "_our_match_points": m.get("our_points"),
                "_opp_match_points": m.get("their_points"),
                "_our_result": result,
                "_opp_result": opp_result,
                **with_strip("League"),
            })
            members.append(league_slug)

        sets[slug_prefix] = {
            "members": members,
            "group": slug_prefix,
            "active": True,
            # Which Play-Cricket match this package reports on. /curate sends the
            # editor to /deck with a match id, and this is what lets /deck find the
            # package for it — including a pinned set, whose slug says nothing about
            # the team.
            "pc_id": str(m.get("match_id") or ""),
            # Names the set's own deck page (/slideshow/<set slug>/) — the set
            # header's two constant heading levels, which is how the package reads
            # on screen: "Match Highlights · Wendover CC 1st XI".
            "title": f"{set_title} · {title}",
            # A match fades: the full package is worth the airtime while it's the
            # club's recent news, then gives way to the one-card result (see
            # `standalone` below). Dated from the match, so a team still playing
            # never reaches it — its last match is replaced weekly. Pins carry no
            # expiry: being pinned is the whole point of them.
            "expires": (_plus_days(_iso_from_dmy(m.get("match_date", "")), max_age)
                        if standalone_result else None),
            # The standalone card duplicates this set's own `-result` member, so a
            # deck carrying both would show the same card twice. Recorded here for
            # build_slideshows to suppress the standalone wherever the set runs.
            "standalone": f"last-match-result-{team_id}" if standalone_result else None,
            # No outcome to report — see nothing_to_report. Decks opt out with
            # skip_when_empty on the set entry.
            "empty": nothing_to_report,
        }

    if sets:
        print(f"  match packages: {len(sets)} set(s)")
    return sets


def _recency_ordered(merged):
    """Play each run of consecutive match-reporting slides newest match first.

    Deck order is authored, but match dates are only known at build time, so a
    results block can't be hand-ordered — it would be wrong by the next weekend.
    Any maximal run of adjacent slides carrying `_recency` (the ISO date of the
    match they report) is sorted here, most recent first; everything else keeps
    its authored position, and a lone recency slide between other slides is a
    run of one. Slides within a set already order themselves and carry no
    `_recency`, so a package is never scrambled.
    """
    out, run = [], []

    def flush():
        out.extend(sorted(run, key=lambda s: s["_recency"], reverse=True))
        run.clear()

    for s in merged:
        if s.get("_recency"):
            run.append(s)
            continue
        flush()
        out.append(s)
    flush()
    return out


def _apply_panel_subset(entry, label=""):
    """Narrow a resolved deck entry to some of its slide's panels.

    A deck entry may carry `panels: [0, 2]` — the editor added the whole slide and
    then turned atoms off (the subtractive UI in docs/narrated-decks.md). The slide
    itself is untouched: it is the same page in every deck, so the subset travels
    with the entry and the player pushes it in as `set-panels`.

    Two things change here, and both matter downstream:

      * `_atoms` is filtered **and renumbered to ordinals**, because `slide-bridge.js`
        presents an ordinal space to the outside world. `compose.py` addresses a
        still by `atom["panel"]` via the player's own `goto-panel`, so renumbering is
        what keeps the render path working with no change to it. The original panel
        numbers stay recoverable from the entry's own `panels` list.
      * `duration` is resummed from the kept atoms, so a deck's total is right and
        the derived timeline agrees with it.

    Refused on reels for the same reason `set-panels` is: their atoms are finer than
    their panels, and a clip subset is `set-clips`.
    """
    panels = entry.get("panels")
    if not panels:
        return entry
    if entry.get("_template") == "video":
        print(f"  {label}: '{entry.get('slug')}' is a reel — panel subset ignored "
              f"(curate the clips instead)")
        entry.pop("panels", None)
        return entry

    atoms = entry.get("_atoms")
    if atoms is None:
        # A live-match slide: its panels are whatever the feed produced by render
        # time, so there is nothing here to take a subset of.
        print(f"  {label}: '{entry.get('slug')}' has no atom list — panel subset ignored")
        entry.pop("panels", None)
        return entry

    keep = sorted({p for p in panels if isinstance(p, int) and 0 <= p < len(atoms)})
    if not keep or len(keep) == len(atoms):
        # Every panel, or none of them that exist — either way the whole slide is
        # what this entry means, and carrying a redundant list would only invite
        # the two to disagree later.
        entry.pop("panels", None)
        return entry

    entry["panels"] = keep
    entry["_atoms"] = [{**atoms[p], "panel": i} for i, p in enumerate(keep)]
    entry["duration"] = round(sum(a.get("duration") or 0 for a in entry["_atoms"]), 3)
    return entry


def _resolve_deck(entries, slide_meta, sets, default_panel_duration, today_iso,
                  label="", deck_rules=True):
    """Resolve authored deck entries into the ordered slide list a player runs.

    Merges each entry with its slide's computed meta (duration, active, expires).
    A set reference expands to its members contiguously, each tagged with the group
    id and carrying any set-level expiry; entry-level keys (e.g. show_when) are
    inherited by every member. Unknown slugs and data-skipped slides are dropped.
    Both players read the derived `duration` from here — neither knows about panels.

    `deck_rules` covers the rules that are about *deck composition* rather than the
    slide itself: dropping expired entries, and suppressing a standalone card that a
    set in the same deck already contains. Auto-decks (one slide or one set, at
    /slideshow/<slug>/) turn them off — they're permalinks, and an expired card is
    still the thing that URL names.
    """
    # A set that has aged out is dropped here rather than left to the players'
    # runtime `expires` filter, because the two rules have to agree: while a
    # package runs it suppresses its standalone twin (below), so the twin can
    # only resurface if the same pass that retires the package sees it go. The
    # build is nightly and these expiries are date-granular, so evaluating here
    # is exactly as timely as evaluating in the player.
    def live_set(s):
        if not deck_rules:
            return s.get("active", True)
        return s.get("active", True) and not (s.get("expires") and s["expires"] < today_iso)

    # Slides this deck must NOT carry because a set it expands already contains
    # the same card (last-match-result-{team} duplicates the package's own
    # `-result` member). Collected up front so the order of the two entries in
    # the deck doesn't matter.
    superseded = {s["standalone"] for e in entries
                  for s in [sets.get(e.get("slug"))]
                  if s and s.get("standalone") and live_set(s)} if deck_rules else set()

    merged = []
    for entry in entries:
        entry_slug = entry.get("slug")

        if entry_slug in superseded:
            print(f"  {label}: '{entry_slug}' covered by its match package — skipped")
            continue

        if entry_slug in sets:
            s = sets[entry_slug]
            if not live_set(s):
                continue
            if entry.get("skip_when_empty") and s.get("empty"):
                print(f"  {label}: '{entry_slug}' has no content — skipped")
                continue
            # `panels` names panels of *one* slide, so it cannot be inherited by
            # every member the way show_when and friends are.
            inherited = {k: v for k, v in entry.items() if k not in ("slug", "panels")}
            for member_slug in s["members"]:
                meta = slide_meta.get(member_slug)
                if not meta or meta.get("_skip"):
                    continue
                member_entry = {**inherited, **meta, "slug": member_slug, "_group": s["group"]}
                if s.get("expires") is not None:
                    member_entry["expires"] = s["expires"]
                    member_entry["slide_expires"] = s["expires"]
                member_entry.setdefault("duration", default_panel_duration)
                merged.append(member_entry)
            continue

        meta = slide_meta.get(entry_slug)
        if meta is None:
            print(f"  {label}: unknown slide '{entry_slug}' — skipped")
            continue
        if meta.get("_skip"):
            continue
        # Opt-in per deck: drop a slide that built with no data behind it (e.g.
        # the today board on a day with nothing on). Other decks still carry it.
        if entry.get("skip_when_empty") and meta.get("_empty"):
            print(f"  {label}: '{entry_slug}' has no content — skipped")
            continue
        # Retired here as well as at runtime, for the same reason as live_set():
        # a lapsed result card must be gone from the pass that decides whether
        # its package still covers it.
        if deck_rules and meta.get("slide_expires") and meta["slide_expires"] < today_iso:
            continue
        merged_entry = {**entry, **meta}
        merged_entry.setdefault("duration", default_panel_duration)
        merged.append(_apply_panel_subset(merged_entry, label))

    return _recency_ordered(merged)


def _write_deck_data(out_dir, show, build_version):
    """Write the two files a player fetches for a deck, and return the clip count.

    data.json is the resolved deck (the players build their iframes from it, so no
    deck is baked into HTML — one shell serves every deck via ?deck=<slug>).
    precache.json is the offline player's build-time asset manifest: every clip URL
    this deck can show, deduped in first-seen order, plus a build_version. A
    deterministic list (vs. runtime crawling) gives the loading gate an exact
    denominator and the pruner an exact keep-set.
    See docs/player-offline-architecture.md.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    # Stamped in so anything derived from this deck (a timeline, a composite) can
    # record which build it came from, and warn when the live site has moved past
    # it. The players ignore the key.
    (out_dir / "data.json").write_text(json.dumps({**show, "build_version": build_version}))

    seen = set()
    precache_videos = []
    for s in show["slides"]:
        for src in s.get("_videos") or []:
            if src not in seen:
                seen.add(src)
                precache_videos.append(src)
    (out_dir / "precache.json").write_text(json.dumps({
        "build_version": build_version,
        "videos": precache_videos,
    }))
    return len(precache_videos)


def write_slide_catalogue(slide_meta, sets, decks, build_version):
    """Publish ``site/slides.json`` — the index of every slide this build produced.

    Phase 6a of docs/narrated-decks.md. The deck builder needs to *browse* slides,
    and nothing published the list: ``slide_meta`` knows every slug, but it only
    ever reached the browser folded into a deck that already contained the slide.
    Adding a slide the current deck does not have therefore had no source at all.

    Deliberately thin — enough to list, group, filter and warn on, and no more. The
    full slide entry (durations, ``_atoms``, ``videos``) comes from the slide's own
    auto-deck at ``/slideshow/<slug>/data.json`` when the editor actually inserts
    it, so a slide entry has exactly one definition rather than two. Every slide
    here has such a deck: the auto-deck loop below skips only authored deck slugs
    (whose deck contains that same slide anyway) and set slugs (which are not
    slides).

    ``atoms: null`` means *unknown*, not none — a live-match slide's panels are
    whatever the feed has produced by render time, which is also why it can be
    neither narrated nor composited.
    """
    members = {m: set_slug for set_slug, s in (sets or {}).items()
               for m in s.get("members", [])}
    slides = []
    for slug, meta in sorted(slide_meta.items()):
        if meta.get("_skip"):
            continue
        atoms = meta.get("_atoms")
        slides.append({
            "slug": slug,
            "title": meta.get("_title") or slug,
            "template": meta.get("_template"),
            "atoms": len(atoms) if atoms is not None else None,
            "duration": meta.get("duration"),
            "panel_duration": meta.get("panel_duration"),
            "set": members.get(slug),
            "active": meta.get("slide_active", True),
            "expires": meta.get("slide_expires"),
            "empty": bool(meta.get("_empty")),
            "live": bool(meta.get("_live")),
        })
    catalogue = {
        "build_version": build_version,
        "slides": slides,
        # The authored slideshows, which are what an editor *starts from*: the
        # builder's first move is "load this deck and customise it", and without a
        # list there is nothing to offer. Auto-decks are deliberately absent — they
        # are one slide or one set, both already covered above.
        "decks": decks,
        # Sets are insertable as a unit ("add the whole Last Match package"), and
        # naming them is also what lets the builder warn that an insertion has split
        # one — see the warnings panel in docs/narrated-decks.md.
        "sets": [{"slug": set_slug, "title": s.get("title") or set_slug,
                  "members": s.get("members", []), "pc_id": s.get("pc_id") or None}
                 for set_slug, s in sorted((sets or {}).items())],
    }
    (SITE / "slides.json").write_text(json.dumps(catalogue, indent=2))
    print(f"  slides.json: {len(slides)} slide(s), {len(catalogue['sets'])} set(s)")


def build_slideshows(env, slide_meta, sets=None):
    # slide_meta (from build_slides/build_match_packages) carries each slide's
    # computed duration, active/expires, and a _skip flag for slides with no data
    # this build. `sets` maps a set slug to its ordered member slugs + group id;
    # referencing a set injects its members contiguously (see below).
    sets = sets or {}
    config = load_config()
    default_panel_duration = config.get("default_panel_duration", 20)
    preview_cfg = config.get("preview", {})
    built_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    today_iso = _today().isoformat()
    # Stamped into each precache.json so the offline player can tell when a
    # slideshow's asset set has changed (see docs/player-offline-architecture.md,
    # "Intelligent refresh"). UTC, second-granularity ISO-8601.
    build_version = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    site_url = preview_cfg.get("site_url", "")
    qr_data_url = generate_qr_data_url(site_url) if site_url else ""

    default_refresh = config.get("default_refresh_interval_seconds", 300)

    # Slugs an authored deck already owns. Authored wins: `fantasy-league` is both a
    # slide and a hand-written deck of that one slide, and the deck is the richer
    # answer, so no auto-deck is generated over it.
    authored = {p.stem for p in (CONTENT / "slideshows").glob("*.json")}

    homepage_shows = []
    authored_decks = []
    for show_path in sorted((CONTENT / "slideshows").glob("*.json")):
        show = json.loads(show_path.read_text())
        slug = show_path.stem

        merged = _resolve_deck(show.get("slides", []), slide_meta, sets,
                               default_panel_duration, today_iso,
                               label=f"slideshow/{slug}")
        show["slides"] = merged

        out_dir = SITE / "slideshow" / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(
            env.get_template("player.html").render(
                screen=False, title=show["title"], slug=slug, preview=preview_cfg,
                built_at=built_at, qr_data_url=qr_data_url))
        n_clips = _write_deck_data(out_dir, show, build_version)
        print(f"  slideshow/{slug}  ({n_clips} clip(s) to precache)")
        # Members, not just a count: the deck builder adds a slideshow's slides only
        # where they are not already in the draft (a slug appears at most once in a
        # deck), so it has to know which slugs a show contains before fetching it.
        authored_decks.append({"slug": slug, "title": show["title"],
                               "slides": len(merged),
                               "members": [m["slug"] for m in merged]})

        # A deck can legitimately build with nothing in it — the archive decks empty
        # out between seasons, and in any fixture gap longer than
        # last_match_max_age_days. The page is still generated (the URL keeps
        # working, and it refills on the next build), but an empty deck is not
        # offered on the homepage: following the link would show a blank player.
        if "homepage_rank" in show and not merged:
            print(f"  slideshow/{slug}: no slides — not listed on the homepage")
        elif "homepage_rank" in show:
            homepage_shows.append({
                "slug": slug,
                "title": show["title"],
                "rank": show["homepage_rank"],
                "description": show.get("description"),
            })

    # ── Auto-decks ────────────────────────────────────────────────────────────
    # Every set and every slide is also playable on its own, in the same player
    # frame, at /slideshow/?deck=<slug> — so a feature only has to be built in the
    # player, never twice for "slide viewed directly" and "slide in a show".
    # A set gets a page as well (a dozen or so, and they're the shareable ones:
    # /slideshow/match-denham-cc/ plays the whole match package). Bare slides get
    # data only — ~240 near-identical shells is what the ?deck= param exists to
    # avoid. /slide/<slug>/ is untouched: it stays the raw frame the player embeds.
    n_sets = n_slides = 0
    for set_slug, s in sorted(sets.items()):
        if set_slug in authored:
            continue
        merged = _resolve_deck([{"slug": set_slug}], slide_meta, sets,
                               default_panel_duration, today_iso,
                               label=f"slideshow/{set_slug}", deck_rules=False)
        if not merged:
            continue
        deck = {"title": s.get("title", set_slug), "slides": merged,
                "refresh_interval_seconds": default_refresh}
        out_dir = SITE / "slideshow" / set_slug
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(
            env.get_template("player.html").render(
                screen=False, title=deck["title"], slug=set_slug, preview=preview_cfg,
                built_at=built_at, qr_data_url=qr_data_url))
        _write_deck_data(out_dir, deck, build_version)
        n_sets += 1

    for slide_slug, meta in sorted(slide_meta.items()):
        if slide_slug in authored or slide_slug in sets or meta.get("_skip"):
            continue
        merged = _resolve_deck([{"slug": slide_slug}], slide_meta, sets,
                               default_panel_duration, today_iso,
                               label=f"slideshow/{slide_slug}", deck_rules=False)
        if not merged:
            continue
        deck = {"title": slide_slug, "slides": merged,
                "refresh_interval_seconds": default_refresh}
        _write_deck_data(SITE / "slideshow" / slide_slug, deck, build_version)
        n_slides += 1

    print(f"  auto-decks: {n_sets} set page(s), {n_slides} slide deck(s)")

    # The bare shell, which plays whatever ?deck= names. Every auto-deck URL is
    # this page plus a param; the per-deck pages above are the same shell with the
    # slug baked in as the default.
    (SITE / "slideshow" / "index.html").write_text(
        env.get_template("player.html").render(
            screen=False, title="Slideshow", slug=None, preview=preview_cfg,
            built_at=built_at, qr_data_url=qr_data_url))

    write_slide_catalogue(slide_meta, sets, authored_decks, build_version)

    return sorted(homepage_shows, key=lambda x: x["rank"])


def build_screen_locations(env, homepage_shows=None):
    locs_path = CONTENT / "locations.json"
    if not locs_path.exists():
        return
    locs_data = json.loads(locs_path.read_text())

    # Expose locations.json to the static site for the smart player
    (SITE / "locations.json").write_text(json.dumps(locs_data))

    config = load_config()
    preview_cfg = config.get("preview", {})
    built_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    site_url = preview_cfg.get("site_url", "")
    qr_data_url = generate_qr_data_url(site_url) if site_url else ""

    screen_locs = [l for l in locs_data["locations"] if l.get("screen")]
    team_names = {tid: t.get("name", tid) for tid, t in load_teams().items()}

    # Unified home-page card list. Card types — screen, slideshow, external,
    # youtube — each rendered with a type icon. Screens and homepage slideshows
    # are derived automatically; extra `external`/`youtube` cards come from
    # config.json "homepage_cards".
    cards = []
    for loc in screen_locs:
        cards.append({
            "type": "screen",
            "title": loc["name"],
            "href": f"/screen/{loc['id']}/?interactive",
            "loc_id": loc["id"],
        })
    for show in (homepage_shows or []):
        cards.append({
            "type": "slideshow",
            "title": show["title"],
            "href": f"/slideshow/{show['slug']}/?interactive",
            "description": show.get("description"),
        })
    youtube_data = None
    for c in config.get("homepage_cards", []):
        if c.get("type") == "external" and c.get("url"):
            cards.append({
                "type": "external",
                "title": c.get("title", c["url"]),
                "href": c["url"],
                "target": "_blank",
                "description": c.get("description"),
            })
        elif c.get("type") == "youtube" and c.get("url"):
            yt_path = FETCHED / "youtube_live.json"
            yt = json.loads(yt_path.read_text()) if yt_path.exists() else {}
            cards.append({
                "type": "youtube",
                "title": c.get("title", "Live Streams"),
                "href": c["url"],
                "target": "_blank",
            })
            youtube_data = {"live": yt.get("live", []), "upcoming": yt.get("upcoming", [])}

    index_tmpl = env.get_template("screen/index.html")
    (SITE / "index.html").write_text(
        index_tmpl.render(preview=preview_cfg, built_at=built_at,
                          cards=cards, team_names=team_names, youtube=youtube_data)
    )
    print("  index.html")

    player_tmpl = env.get_template("player.html")
    for loc in screen_locs:
        html = player_tmpl.render(screen=True, location=loc, title=loc["name"],
                                  preview=preview_cfg, built_at=built_at, qr_data_url=qr_data_url)
        out_dir = SITE / "screen" / loc["id"]
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(html)
        print(f"  screen/{loc['id']}")


if __name__ == "__main__":
    print("Cleaning site/...")
    clean()

    print("Copying assets...")
    copy_assets()

    env = make_env()

    print("Building PWA icons and manifest...")
    build_pwa(env)

    print("Building slides...")
    slide_meta = build_slides(env)

    print("Building match packages...")
    sets = build_match_packages(env, slide_meta)

    # Live-match feature set is gated behind config.live_enabled so unfinished
    # work can sit in main without being built or polled. Off = no live slides,
    # no poll list, no overlay pages; the players (also flag-gated) never wire up
    # the poller, so nothing hits live.wendovercc.org.
    live_enabled = load_config().get("live_enabled", False)

    if live_enabled:
        print("Building live-match slides...")
        build_live_matches(env, slide_meta)
    else:
        print("Skipping live-match slides (live_enabled=false)")

    print("Building slideshows...")
    homepage_shows = build_slideshows(env, slide_meta, sets)

    if live_enabled:
        print("Building live config...")
        build_live_config()
        build_league_config()
        build_live_flash(env)
        build_live_ticker(env)
        build_live_strip(env)

    print("Building context calendar...")
    build_context_calendar()

    print("Building screen locations...")
    build_screen_locations(env, homepage_shows)

    print("Building curation tool...")
    build_curation(env)
    build_deck_builder(env)
    build_narrate(env)

    (SITE / ".nojekyll").write_text("")
    print("\nDone. To preview locally:")
    print("  cd site && python -m http.server 8000")
    print("  open http://localhost:8000/slideshow/pavilion-auto/")
