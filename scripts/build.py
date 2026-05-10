#!/usr/bin/env python3
"""Build pipeline: content/ + templates/ + assets/ → site/"""

import base64
import io
import json
import shutil
from pathlib import Path

import qrcode
from jinja2 import Environment, FileSystemLoader, StrictUndefined

ROOT = Path(__file__).parent.parent
CONTENT = ROOT / "content"
TEMPLATES = ROOT / "templates"
ASSETS = ROOT / "assets"
SITE = ROOT / "site"

LEAGUE_TABLE_EXCLUDED = {"ave+", "batp", "bowlp", "offbp", "pen", "t"}
LEADERBOARD_TEMPLATES = {"batting-leaderboard", "bowling-leaderboard"}
FANTASY_TEMPLATES = {
    "fantasy-team-standings": "fantasy_team_standings",
    "fantasy-player-standings": "fantasy_player_standings",
    "fantasy-team-of-week": "fantasy_team_of_week",
}
FANTASY_EMPTY = {"headers": [], "rows": [], "tabs": {}, "page_title": None, "fetched_at": None}


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


def generate_qr_data_url(url: str) -> str:
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/png;base64,{data}"


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
        data_path = CONTENT / "data" / f"league_table_{team['play_cricket_league_id']}.json"
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
            "form": (form.get(team_id) or {}).get(str(team["play_cricket_league_id"]), (form.get(team_id) or {}).get("all", [])),
            "pts_gap": pts_gap,
            "pts_pct": pts_pct,
            "leader_pts": leader_pts,
        })
    slide["_rows"] = rows


def build_slides(env):
    teams_by_id = load_teams()
    config = load_config()
    lb_config = config.get("leaderboards", {})

    _stats_cache = {}

    def load_stats(label):
        if label not in _stats_cache:
            path = CONTENT / "data" / f"player_stats_{label}.json"
            _stats_cache[label] = json.loads(path.read_text()) if path.exists() else None
        return _stats_cache[label]

    for slide_path in sorted((CONTENT / "slides").glob("*.json")):
        slide = json.loads(slide_path.read_text())
        slug = slide_path.stem

        if slide.get("template") == "league-table" and "team" in slide:
            team = teams_by_id[slide["team"]]
            data_path = CONTENT / "data" / f"league_table_{team['play_cricket_league_id']}.json"
            slide["_data"] = json.loads(data_path.read_text())
            slide["_highlight_team_id"] = str(team["play_cricket_team_id"])
            slide["_team"] = team
        elif "data" in slide:
            data_path = ROOT / slide["data"]
            slide["_data"] = json.loads(data_path.read_text())

        if slide.get("template") in FANTASY_TEMPLATES:
            key = FANTASY_TEMPLATES[slide["template"]]
            data_path = CONTENT / "data" / f"{key}.json"
            slide["_data"] = json.loads(data_path.read_text()) if data_path.exists() else FANTASY_EMPTY

        if slide.get("template") == "cta" and "qr_url" in slide:
            slide["_qr_data_url"] = generate_qr_data_url(slide["qr_url"])

        if slide.get("template") == "league-positions":
            build_league_positions(slide, teams_by_id, load_stats("this_season"))

        if slide.get("template") in LEADERBOARD_TEMPLATES:
            if slide.get("competition") == "league" and slide.get("team"):
                team = teams_by_id.get(slide["team"])
                if team and "play_cricket_league_id" in team:
                    slide["competition"] = str(team["play_cricket_league_id"])
            stats = load_stats("this_season")
            if stats:
                if slide["template"] == "batting-leaderboard":
                    build_batting_leaderboard(slide, stats, lb_config)
                else:
                    build_bowling_leaderboard(slide, stats, lb_config)

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
                table["headings_list"] = team_col + pts_cols + rest_cols
                table["rows"] = table["values"]

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
