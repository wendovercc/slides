#!/usr/bin/env python3
"""Build pipeline: content/ + templates/ + assets/ → site/"""

import base64
import hashlib
import io
import json
import shutil
from datetime import date, datetime
from pathlib import Path

import qrcode
from jinja2 import Environment, FileSystemLoader, StrictUndefined

ROOT = Path(__file__).parent.parent
CONTENT = ROOT / "content"
FETCHED = CONTENT / "data" / "fetched"
VIDEOS_CACHE    = CONTENT / "data" / "fetched" / "videos"
VIDEO_MANIFEST  = CONTENT / "data" / "video_manifest.json"
FETCHED_MATCHES = CONTENT / "data" / "fetched" / "matches"   # raw ball events (rebuilt each build)
CURATION_DIR    = CONTENT / "data" / "matches"               # committed {id}.curation.json overlays
TEMPLATES = ROOT / "templates"
ASSETS = ROOT / "assets"
SITE = ROOT / "site"

LEAGUE_TABLE_EXCLUDED = {"ave+", "batp", "bowlp", "offbp", "pen", "t"}
LEADERBOARD_TEMPLATES = {"leaderboard"}
HONOURS_TEMPLATES = {"honours"}
# Empty fallback for the fantasy-league panels when a feed is missing this build.
FANTASY_EMPTY = {"headers": [], "rows": [], "tabs": {}, "page_title": None, "fetched_at": None}

# Carousel templates whose panel count is fixed (panels are hard-coded in the
# template). The `team` template's panel count is data-driven instead — it
# publishes a `slide["_panels"]` list, which takes precedence over this map.
# Used to derive each slide's total duration = panel_duration × panel count.
FIXED_PANEL_COUNTS = {
    "honours": 4,
    "leaderboard": 4,
    "fantasy-league": 3,
}


def load_config():
    path = CONTENT / "config.json"
    return json.loads(path.read_text()) if path.exists() else {}


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


def build_batting_leaderboard(slide, stats_data, lb_config):
    team_filter = slide.get("teams") or slide.get("team")
    comp_filter = slide.get("competition")
    rows = lb_config.get("rows", 8)
    min_innings = lb_config.get("min_innings", 2)

    entries = []
    for p in stats_data["players"].values():
        block = get_leaderboard_block(p, team_filter, comp_filter)
        if block and block["matches"] > 0:
            entries.append({"name": p["name"], "block": block})

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
    min_balls = lb_config.get("min_overs", 2) * 6

    entries = []
    for p in stats_data["players"].values():
        block = get_leaderboard_block(p, team_filter, comp_filter)
        if block and block["matches"] > 0:
            entries.append({"name": p["name"], "block": block})

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
    slide["_min_overs"] = lb_config.get("min_overs", 2)


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
    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir()


def video_fingerprint(url: str, start, end) -> str:
    key = f"{url}:{start if start is not None else 0}-{end if end is not None else ''}"
    return hashlib.sha256(key.encode()).hexdigest()[:12]


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


def _curation_scorecards():
    """Index the recent scorecards in fixtures.json by match_id (as a string).

    Draws from both ``last_match`` (one per team) and ``recent_matches`` (a list
    per team), so a just-played match can be looked up while it's still in the
    retention window. Older matches roll off — callers fall back to the roster.
    """
    path = FETCHED / "fixtures.json"
    if not path.exists():
        return {}
    try:
        fx = json.loads(path.read_text())
    except Exception:
        return {}
    by_id = {}
    for last in (fx.get("last_match") or {}).values():
        mid = last.get("match_id")
        if mid is not None:
            by_id[str(mid)] = last
    for recents in (fx.get("recent_matches") or {}).values():
        for sc in recents or []:
            mid = sc.get("match_id")
            if mid is not None:
                by_id.setdefault(str(mid), sc)
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

    # Scorecards, keyed by match_id, so each match's role-tag player list is the
    # actual playing XI (from Play Cricket) rather than the whole club roster.
    scorecards = _curation_scorecards()

    index = []
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
        data["squad"] = _match_squad(scorecards.get(str(pc_id)))
        (data_dir / f"{pc_id}.json").write_text(json.dumps(data))
        index.append({
            "pc_match_id": pc_id,
            "team": data.get("team"),
            "date": data.get("date"),
            "competition": data.get("competition"),
            "home_name": data.get("home_name"),
            "away_name": data.get("away_name"),
            "n_events": len(data.get("events", [])),
        })
    index.sort(key=lambda m: (m.get("date") or ""), reverse=True)
    (out_dir / "matches.json").write_text(json.dumps(index))

    # Full club roster (names + teams) for the "add player" picker on the page.
    roster_path = FETCHED / "player_stats_this_season.json"
    roster = []
    if roster_path.exists():
        try:
            players = json.loads(roster_path.read_text()).get("players", {})
            seen = set()
            for p in (players.values() if isinstance(players, dict) else players):
                name = (p.get("name") or "").strip()
                if name and name not in seen:
                    seen.add(name)
                    roster.append({"name": name, "teams": p.get("teams") or []})
            roster.sort(key=lambda r: r["name"])
        except Exception:
            roster = []
    (out_dir / "roster.json").write_text(json.dumps(roster))

    # Card registry (types + default pad seconds) — the single source of truth the
    # page's card pickers read, so the JS never hard-codes the defaults that
    # ball_events.py also relies on.
    (out_dir / "card_types.json").write_text(json.dumps(load_config().get("card_types") or []))

    (out_dir / "index.html").write_text(env.get_template("curate/index.html").render())
    print(f"  curation: {len(index)} match(es) → /curate/")


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
    sponsor_dir = ASSETS / "images" / "sponsors"
    env.globals["sponsors"] = [
        {"name": p.stem.replace("-", " ").title(), "src": f"/assets/images/sponsors/{p.name}"}
        for p in sorted(sponsor_dir.glob("*.*"))
        if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".svg"}
    ]
    # Display form of the site URL (no scheme/trailing slash), shown under the
    # club name in slide footers/sidebars and on the home page.
    site_url = load_config().get("preview", {}).get("site_url", "")
    env.globals["site_url"] = site_url.split("//")[-1].rstrip("/")
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
    today_iso = date.today().isoformat()

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


def _short_innings_total(total):
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


def build_team(slide, teams_by_id, fixtures_data, stats_data, lb_config):
    """Assemble the multi-panel team slide object.

    Panels (any with no data are omitted from slide._panels):
      league · results · schedule · top_batting · top_bowling
    """
    team_id = slide.get("team")
    team = teams_by_id.get(team_id, {})
    fixtures_data = fixtures_data or {}
    today = date.today()
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

    # ── Tabs 4 & 5: Top batting / Top bowling (5 rows each table) ──────────
    TOP_ROWS = 5
    min_innings = (lb_config or {}).get("min_innings", 2)
    min_balls = (lb_config or {}).get("min_overs", 2) * 6

    slide["_top_runs"] = []
    slide["_top_avg_bat"] = []
    slide["_top_wkts"] = []
    slide["_top_avg_bowl"] = []
    slide["_has_top_batting"] = False
    slide["_has_top_bowling"] = False
    slide["_min_innings"] = min_innings
    slide["_min_overs"] = (lb_config or {}).get("min_overs", 2)

    if stats_data:
        entries = []
        for p in stats_data["players"].values():
            block = get_leaderboard_block(p, team_id, None)
            if block and block["matches"] > 0:
                entries.append({"name": p["name"], "block": block})

        def fmt_bat(e):
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
        )[:TOP_ROWS]

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

    slide["_panels"] = panels


ACTIVITY_PRIORITY = {"club_event": 0, "section_event": 1, "match": 2, "training": 3, "hire": 4}

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


def infer_section(team_ids):
    if not team_ids:
        return "all"
    sections = {"junior" if tid.startswith("u") else "senior" for tid in team_ids}
    return sections.pop() if len(sections) == 1 else "all"


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

    # Sort entries within each date by activity priority
    for loc_id in entries:
        for iso_date in entries[loc_id]["dates"]:
            entries[loc_id]["dates"][iso_date].sort(
                key=lambda e: ACTIVITY_PRIORITY.get(e["type"], 99)
            )

    calendar = {"generated_at": date.today().isoformat(), "entries": entries}
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
                load_stats("this_season"), lb_config,
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
            panel_count = FIXED_PANEL_COUNTS.get(slide.get("template"), 1)
        if panel_count == 0:
            slide_meta[slug] = {"_skip": True}
            print(f"  slide/{slug} — skipped (no panels)")
            continue

        if not slide.get("_override_duration"):
            panel_duration = slide.get("panel_duration", default_panel_duration)
            slide["panel_duration"] = panel_duration
            slide["duration"] = panel_duration * panel_count

        slide_meta[slug] = {
            "slide_active": slide.get("active", True),
            "slide_expires": slide.get("expires"),
            "duration": slide["duration"],
            "panel_duration": slide["panel_duration"],
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


def team_current_performers(stats, team_id, n_bat=2, n_bowl=2):
    """Season-to-date leading batters (by runs) and bowlers (by wickets) for the
    Next Match preview, shaped for the shared tale-of-the-tape performer rows.
    Like team_preview_performers but with nothing to subtract (the match hasn't
    happened) and no `out` tag (the XI is unknown), so the figures read as the
    current season totals."""
    if not stats:
        return []

    def avg(runs, dismissals):
        return f"{runs / dismissals:.1f}" if dismissals > 0 else "-"

    bats, bowls = [], []
    for p in stats.get("players", {}).values():
        block = get_leaderboard_block(p, team_id, None)
        if not block:
            continue
        b, bw = block["batting"], block["bowling"]
        if b["innings"] > 0:
            sr = f"{b['runs'] / b['balls'] * 100:.0f}" if b["balls"] > 0 else "-"
            bats.append({"category": "bat", "name": p["name"], "_rank": b["runs"], "out": False,
                         "primary": str(b["runs"]), "unit": "runs",
                         "secondary": f"avg {avg(b['runs'], b['innings'] - b['not_outs'])} · SR {sr}"})
        if bw["wickets"] > 0:
            econ = f"{bw['runs'] / (bw['balls'] / 6):.1f}" if bw["balls"] > 0 else "-"
            bowls.append({"category": "bowl", "name": p["name"], "_rank": bw["wickets"], "out": False,
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

    fixtures_path = FETCHED / "fixtures.json"
    fixtures_data = json.loads(fixtures_path.read_text()) if fixtures_path.exists() else {}
    last_matches = fixtures_data.get("last_match", {}) or {}
    stats_path = FETCHED / "player_stats_this_season.json"
    stats = json.loads(stats_path.read_text()) if stats_path.exists() else None

    intro_tmpl = env.get_template("slides/match-intro.html")
    sc_tmpl = env.get_template("slides/scorecard.html")
    result_tmpl = env.get_template("slides/match-result.html")
    league_tmpl = env.get_template("slides/match-league.html")

    def emit(slug, template, slide):
        slide["duration"] = default_panel_duration
        slide["panel_duration"] = default_panel_duration
        html = template.render(slide=slide, slug=slug)
        out_dir = SITE / "slide" / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(html)
        slide_meta[slug] = {
            "slide_active": True,
            "slide_expires": None,
            "duration": default_panel_duration,
            "panel_duration": default_panel_duration,
        }
        print(f"  slide/{slug}")

    sets = {}
    for team_id, m in sorted(last_matches.items()):
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
        date_formatted = fmt_match_date(m.get("match_date", ""))
        ground = m.get("ground_name") or ""
        is_home = m.get("is_home", True)
        we_bat_first = m.get("we_bat_first", True)
        our_total_str = _short_innings_total(m.get("our_total"))
        their_total_str = _short_innings_total(m.get("their_total"))
        result = m.get("result")

        our_batting = _fmt_batting_rows(m.get("our_batting", []) or [])
        our_bowling = _fmt_bowling_rows(m.get("our_bowling", []) or [])
        their_batting = _fmt_batting_rows(m.get("their_batting", []) or [])
        their_bowling = _fmt_bowling_rows(m.get("their_bowling", []) or [])

        # Each innings splits into two full-width slides under the same strip step
        # (labels stay innings-level): batting then bowling. Both carry the innings
        # headline (batting club + readable score).
        # (batting_club, total, batting_rows, bowling_club, bowling_rows)
        our_innings = ("Wendover CC", m.get("our_total"), our_batting, opp_club, their_bowling)
        their_innings = (opp_club, m.get("their_total"), their_batting, "Wendover CC", our_bowling)
        ordered = [our_innings, their_innings] if we_bat_first else [their_innings, our_innings]
        labels = ["1st Innings", "2nd Innings"]
        innings_present = []   # unique innings labels with any content (for the strip)
        innings_members = []   # (slug, phase_label, slide_fields)
        for i, (bat_club, total, batting, bowl_club, bowling) in enumerate(ordered):
            if not batting and not bowling:
                continue
            label = labels[i]
            innings_present.append(label)
            scoreline = {"_bat_club": bat_club, "_score_readable": _short_innings_total(total)}
            if batting:
                innings_members.append((f"last-match-{team_id}-innings-{i + 1}-batting", label, {
                    "_mode": "batting", "_batting": batting,
                    "_extras": innings_extras(total, batting),
                    "_extras_parts": extras_breakdown_str(total), **scoreline,
                }))
            if bowling:
                innings_members.append((f"last-match-{team_id}-innings-{i + 1}-bowling", label, {
                    "_mode": "bowling", "_bowling": bowling, "_bowl_club": bowl_club, **scoreline,
                }))
        has_result = bool(result or our_total_str or their_total_str)

        # The three heading levels: Title (set label) + Subtitle (team · date) are
        # constant across the set — kept data-driven so a later renderer (e.g. the
        # MP4 export) can override them. The sequence strip is the third level: one
        # step per *phase* (a phase can span a reel + its scorecard later). The
        # result is the terminal payoff and doubles as the standalone latest-result
        # slide, so it carries the shared header but no strip.
        # League table is the final step for league teams (safe post-result).
        league_panel = build_league_panel(team)
        steps = (["Intro"] + innings_present
                 + (["Result"] if has_result else [])
                 + (["League"] if league_panel else []))
        iso = _iso_from_dmy(m.get("match_date", ""))
        if iso:
            _dt = datetime.strptime(iso, "%Y-%m-%d")
            date_short = _dt.strftime(f"%a {_dt.day} %b")
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
        set_common = {"_set_title": "Last Match", "_set_subtitle": title, **set_meta_fields}

        def with_strip(step_label):
            return {**set_common, "_set_steps": steps, "_set_step": steps.index(step_label)}

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
            toss_winner = "Wendover CC" if toss_won_us else opp_club
            toss_line = f"{toss_winner} won the toss and elected to {'bat' if toss_bat else 'field'}"
        else:
            toss_line = m.get("toss_text") or ""

        # When neither a scorecard nor a result is published (e.g. an unrecorded
        # friendly), the intro footer says so in place of the toss headline.
        if not innings_members and not has_result:
            toss_line = "Match scorecard and result not available"

        intro_slug = f"last-match-{team_id}-intro"
        emit(intro_slug, intro_tmpl, {
            "template": "match-intro", "title": title,
            "_opp_club_name": opp_club,
            "_our_crest": "/assets/images/wcc-logo.png",
            "_our_form": our_form, "_our_performers": our_performers,
            "_opp_crest": opp_crest, "_opp_form": opp_form, "_opp_performers": opp_performers,
            "_division": competition_display, "_toss": toss_line, "_h2h": h2h,
            # Intro lists the home team on the left.
            "_our_left": is_home,
            **with_strip("Intro"),
        })
        members.append(intro_slug)

        for sc_slug, label, fields in innings_members:
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
            result, m.get("our_total"), m.get("their_total"), we_bat_first, "Wendover CC", opp_club
        )
        set_result_fields = {
            "_no_match": False,
            "_result_desc": result_desc,
            # Result lists the side that batted first on the left.
            "_our_left": we_bat_first,
            "_our_crest": "/assets/images/wcc-logo.png",
            "_our_name": "Wendover CC",
            "_our_result": result, "_our_result_label": _RESULT_LABELS.get(result, result),
            "_our_points": m.get("our_points"),
            "_our_score": _short_innings_total(m.get("our_total")),
            "_our_performers": team_performers(our_batting, our_bowling, their_batting),
            "_opp_crest": m.get("opposition_crest"),
            "_opp_name": opp_club,
            "_opp_result": opp_result, "_opp_result_label": _RESULT_LABELS.get(opp_result, opp_result),
            "_opp_points": m.get("their_points"),
            "_opp_score": _short_innings_total(m.get("their_total")),
            "_opp_performers": team_performers(their_batting, their_bowling, our_batting),
        }
        if has_result:
            set_result_slug = f"last-match-{team_id}-result"
            emit(set_result_slug, result_tmpl, {
                "template": "match-result", "title": title,
                **set_result_fields, **with_strip("Result"),
            })
            members.append(set_result_slug)

        # Standalone latest-result card for the results rotation — the same Result
        # tale of the tape minus the sequence strip. Always emitted: when no result
        # or scorecard is published it degrades to crests + team names with a footer
        # note, so every team keeps a results-rotation slide.
        emit(f"last-match-result-{team_id}", result_tmpl, {
            "template": "match-result", "title": title,
            "_set_title": "Last Match Result", "_set_subtitle": title,
            **set_meta_fields, **set_result_fields,
            "_result_desc": result_desc or "Match scorecard and result not available",
        })

        if league_panel:
            league_data, league_team_id, league_name = league_panel
            league_slug = f"last-match-{team_id}-league"
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

        sets[f"last-match-{team_id}"] = {
            "members": members,
            "group": f"last-match-{team_id}",
            "active": True,
            "expires": None,
        }

    if sets:
        print(f"  match packages: {len(sets)} team set(s)")
    return sets


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
    site_url = preview_cfg.get("site_url", "")
    qr_data_url = generate_qr_data_url(site_url) if site_url else ""

    homepage_shows = []
    for show_path in sorted((CONTENT / "slideshows").glob("*.json")):
        show = json.loads(show_path.read_text())
        slug = show_path.stem

        # Merge each entry with its slide's computed meta (duration, active,
        # expires). A set reference expands to its members contiguously, each
        # tagged with the group id and carrying any set-level expiry; entry-level
        # keys (e.g. show_when) are inherited by every member. Unknown slugs and
        # data-skipped slides are dropped. Both players read the derived
        # `duration` from here — neither knows about panels.
        merged = []
        for entry in show.get("slides", []):
            entry_slug = entry.get("slug")

            if entry_slug in sets:
                s = sets[entry_slug]
                if not s.get("active", True):
                    continue
                inherited = {k: v for k, v in entry.items() if k != "slug"}
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
                print(f"  slideshow/{slug}: unknown slide '{entry_slug}' — skipped")
                continue
            if meta.get("_skip"):
                continue
            merged_entry = {**entry, **meta}
            merged_entry.setdefault("duration", default_panel_duration)
            merged.append(merged_entry)
        show["slides"] = merged

        template = env.get_template("slideshow/player.html")
        html = template.render(show=show, slug=slug, preview=preview_cfg, built_at=built_at, qr_data_url=qr_data_url)

        out_dir = SITE / "slideshow" / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(html)

        # data.json consumed by the smart player at runtime
        (out_dir / "data.json").write_text(json.dumps(show))
        print(f"  slideshow/{slug}")

        if "homepage_rank" in show:
            homepage_shows.append({
                "slug": slug,
                "title": show["title"],
                "rank": show["homepage_rank"],
                "description": show.get("description"),
            })

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

    player_tmpl = env.get_template("screen/player.html")
    for loc in screen_locs:
        html = player_tmpl.render(location=loc, preview=preview_cfg, built_at=built_at, qr_data_url=qr_data_url)
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

    print("Building slideshows...")
    homepage_shows = build_slideshows(env, slide_meta, sets)

    print("Building context calendar...")
    build_context_calendar()

    print("Building screen locations...")
    build_screen_locations(env, homepage_shows)

    print("Building curation tool...")
    build_curation(env)

    (SITE / ".nojekyll").write_text("")
    print("\nDone. To preview locally:")
    print("  cd site && python -m http.server 8000")
    print("  open http://localhost:8000/slideshow/pavilion-auto/")
