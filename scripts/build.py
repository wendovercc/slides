#!/usr/bin/env python3
"""Build pipeline: content/ + templates/ + assets/ → site/"""

import base64
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
TEMPLATES = ROOT / "templates"
ASSETS = ROOT / "assets"
SITE = ROOT / "site"

LEAGUE_TABLE_EXCLUDED = {"ave+", "batp", "bowlp", "offbp", "pen", "t"}
LEADERBOARD_TEMPLATES = {"batting-leaderboard", "bowling-leaderboard"}
HONOURS_TEMPLATES = {"batting-honours", "bowling-honours"}
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
    sponsor_dir = ASSETS / "images" / "sponsors"
    env.globals["sponsors"] = [
        {"name": p.stem.replace("-", " ").title(), "src": f"/assets/images/sponsors/{p.name}"}
        for p in sorted(sponsor_dir.glob("*.*"))
        if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".svg"}
    ]
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
            "form": (form.get(team_id) or {}).get(str(team["play_cricket_league_id"]), (form.get(team_id) or {}).get("all", [])),
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
    team_id = slide.get("team")
    fixture = (fixtures_data or {}).get("fixtures", {}).get(team_id)

    if not fixture:
        slide["_no_fixture"] = True
        return

    slide["_no_fixture"] = False
    slide["_fixture"] = fixture
    slide["_date_formatted"] = fmt_match_date(fixture.get("match_date", ""))

    # All-season form for our team (consistent with opposition form)
    form_data = (stats_data or {}).get("form", {}).get(team_id, {})
    slide["_our_form"] = form_data.get("all", [])

    # opposition_club_name comes from home/away_club_name in the match record;
    # opposition_name is sometimes just the team designation (e.g. "4th XI") not "Club - Team"
    opp_club = fixture.get("opposition_club_name", "") or ""
    opp_full = fixture.get("opposition_name", "")
    if opp_club:
        slide["_opp_club_name"] = opp_club
        slide["_opp_team_name"] = (
            opp_full[len(opp_club) + 3:]
            if opp_full.startswith(opp_club + " - ")
            else opp_full
        )
    elif " - " in opp_full:
        derived_club, _, opp_team_desig = opp_full.rpartition(" - ")
        slide["_opp_club_name"] = derived_club
        slide["_opp_team_name"] = opp_team_desig
    else:
        slide["_opp_club_name"] = opp_full
        slide["_opp_team_name"] = ""

    # Our top batters and bowlers (all-season, team-specific)
    slide["_our_players"] = {"batting": [], "bowling": []}
    if stats_data:
        batters, bowlers = [], []
        for p in stats_data["players"].values():
            block = get_leaderboard_block(p, team_id, None)
            if not block:
                continue
            if block["batting"]["innings"] > 0:
                batters.append((p["name"], block["batting"]))
            if block["bowling"]["wickets"] > 0:
                bowlers.append((p["name"], block["bowling"]))
        batters.sort(key=lambda x: x[1]["runs"], reverse=True)
        bowlers.sort(key=lambda x: x[1]["wickets"], reverse=True)
        slide["_our_players"]["batting"] = [
            {
                "name": n,
                "runs": b["runs"],
                "average": b.get("average"),
                "high_score": b["high_score"],
                "high_score_not_out": bool(b["high_score_not_out"]) if b["high_score_not_out"] is not None else False,
            }
            for n, b in batters[:3]
        ]
        slide["_our_players"]["bowling"] = [
            {
                "name": n,
                "wickets": b["wickets"],
                "average": b.get("average"),
                "best": b.get("best"),
            }
            for n, b in bowlers[:3]
        ]

    # League table for the middle column
    team = teams_by_id.get(team_id, {})
    league_id = team.get("play_cricket_league_id")
    our_pc_id = str(team.get("play_cricket_team_id", ""))
    opp_pc_id = fixture.get("opposition_team_id", "")

    slide["_league_rows"] = []
    slide["_league_name"] = team.get("league_name", "")
    slide["_division_name"] = ""

    if league_id:
        data_path = FETCHED / f"league_table_{league_id}.json"
        if data_path.exists():
            table_data = json.loads(data_path.read_text())
            table = table_data.get("league_table", [{}])[0]
            values = table.get("values", [])
            headings = table.get("headings", {})
            pts_col = next((k for k, v in headings.items() if v.lower() == "pts"), None)
            slide["_division_name"] = table.get("name", "")
            if not slide["_league_name"]:
                slide["_league_name"] = slide["_division_name"]

            for row in values:
                tid = str(row.get("team_id", ""))
                slide["_league_rows"].append({
                    "position": row.get("position", ""),
                    "name": row.get("column_1", ""),
                    "played": row.get("column_2", "0"),
                    "won": row.get("column_3", "0"),
                    "lost": row.get("column_5", "0"),
                    "pts": row.get(pts_col, "") if pts_col else "",
                    "is_us": tid == our_pc_id,
                    "is_opp": tid == opp_pc_id,
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


def build_last_match(slide, teams_by_id, fixtures_data):
    team_id = slide.get("team")
    data = (fixtures_data or {}).get("last_match", {}).get(team_id)

    if not data:
        slide["_no_match"] = True
        return

    slide["_no_match"] = False
    slide["_match"] = data
    slide["_date_formatted"] = fmt_match_date(data.get("match_date", ""))

    league_name = teams_by_id.get(team_id, {}).get("league_name", "")
    comp_name = data.get("competition_name", "") or ""
    if league_name and comp_name and comp_name != league_name:
        slide["_competition_display"] = f"{league_name} · {comp_name}"
    else:
        slide["_competition_display"] = league_name or comp_name
    slide["_result"] = data.get("result")
    result_flip = {"W": "L", "L": "W"}
    slide["_opp_result"] = result_flip.get(slide["_result"], slide["_result"])
    slide["_our_points"] = data.get("our_points")
    slide["_their_points"] = data.get("their_points")
    slide["_our_total_str"] = fmt_innings_total(data.get("our_total"))
    slide["_their_total_str"] = fmt_innings_total(data.get("their_total"))

    def fmt_batting(rows):
        return [
            {**b,
             "how_out_abbr": format_dismissal(
                 b.get("how_out", ""),
                 b.get("fielder_name", ""),
                 b.get("bowler_name", ""),
             ),
             "fours": b.get("fours", 0),
             "sixes": b.get("sixes", 0),
            }
            for b in rows
        ]

    def fmt_bowling(rows):
        return [
            {**b, "overs_str": balls_to_overs(b["balls"]), "maidens": b.get("maidens", 0)}
            for b in rows
        ]

    slide["_we_bat_first"] = data.get("we_bat_first", True)
    slide["_our_batting"] = fmt_batting(data.get("our_batting", []))
    slide["_our_bowling"] = fmt_bowling(data.get("our_bowling", []))
    slide["_their_batting"] = fmt_batting(data.get("their_batting", []))
    slide["_their_bowling"] = fmt_bowling(data.get("their_bowling", []))

    opp_club = data.get("opposition_club_name", "") or ""
    opp_full = data.get("opposition_name", "")
    if opp_club:
        slide["_opp_club_name"] = opp_club
        slide["_opp_team_name"] = (
            opp_full[len(opp_club) + 3:]
            if opp_full.startswith(opp_club + " - ")
            else opp_full
        )
    elif " - " in opp_full:
        derived_club, _, opp_team_desig = opp_full.rpartition(" - ")
        slide["_opp_club_name"] = derived_club
        slide["_opp_team_name"] = opp_team_desig
    else:
        slide["_opp_club_name"] = opp_full
        slide["_opp_team_name"] = ""


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

        if slide.get("template") in FANTASY_TEMPLATES:
            key = FANTASY_TEMPLATES[slide["template"]]
            data_path = FETCHED / f"{key}.json"
            slide["_data"] = json.loads(data_path.read_text()) if data_path.exists() else FANTASY_EMPTY

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

        if slide.get("template") == "last-match":
            build_last_match(slide, teams_by_id, load_fixtures())

        if slide.get("template") == "schedule":
            training, all_fixtures, loc_lookup, loc_names = load_schedule_data()
            build_schedule(slide, teams_by_id, training, all_fixtures, loc_lookup, loc_names)

        if slide.get("template") == "batting-honours":
            build_batting_honours(
                slide,
                load_honours("historic_batting_hundreds"),
                load_honours("season_batting_hundreds_this_season"),
            )

        if slide.get("template") == "bowling-honours":
            build_bowling_honours(
                slide,
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
    # Collect slide-level active/expires so data.json can carry them for the smart player
    slide_meta = {}
    for slide_path in (CONTENT / "slides").glob("*.json"):
        s = json.loads(slide_path.read_text())
        meta = {
            "slide_active": s.get("active", True),
            "slide_expires": s.get("expires"),
        }
        if "duration" in s:
            meta["duration"] = s["duration"]
        slide_meta[slide_path.stem] = meta

    config = load_config()
    preview_cfg = config.get("preview", {})
    built_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    site_url = preview_cfg.get("site_url", "")
    qr_data_url = generate_qr_data_url(site_url) if site_url else ""

    homepage_shows = []
    for show_path in sorted((CONTENT / "slideshows").glob("*.json")):
        show = json.loads(show_path.read_text())
        slug = show_path.stem

        template = env.get_template("slideshow/player.html")
        html = template.render(show=show, slug=slug, preview=preview_cfg, built_at=built_at, qr_data_url=qr_data_url)

        out_dir = SITE / "slideshow" / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(html)

        # data.json consumed by the smart player at runtime
        data = dict(show)
        data["slides"] = [
            {**entry, **slide_meta.get(entry["slug"], {})}
            for entry in show.get("slides", [])
        ]
        (out_dir / "data.json").write_text(json.dumps(data))
        print(f"  slideshow/{slug}")

        if "homepage_rank" in show:
            homepage_shows.append({"slug": slug, "title": show["title"], "rank": show["homepage_rank"]})

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

    index_tmpl = env.get_template("screen/index.html")
    (SITE / "index.html").write_text(
        index_tmpl.render(preview=preview_cfg, built_at=built_at,
                          screen_locs=screen_locs, homepage_shows=homepage_shows or [])
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

    print("Building slides...")
    build_slides(env)

    print("Building slideshows...")
    homepage_shows = build_slideshows(env)

    print("Building context calendar...")
    build_context_calendar()

    print("Building screen locations...")
    build_screen_locations(env, homepage_shows)

    (SITE / ".nojekyll").write_text("")
    print("\nDone. To preview locally:")
    print("  cd site && python -m http.server 8000")
    print("  open http://localhost:8000/slideshow/pavilion-auto/")
