#!/usr/bin/env python3
"""Fetch upcoming fixtures and opposition stats from Play Cricket.

For each team in content/teams.json, finds the next upcoming match this season.
Uses home_club_id/away_club_id from the match to fetch the opposition club's
match history, computing their form and players to watch.

Writes content/data/fixtures.json.

Requires PLAY_CRICKET_API_TOKEN and PLAY_CRICKET_SITE_ID env vars; exits
cleanly if absent so local builds work using committed data files.
"""

import json
import os
import sys
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent.parent
CONTENT = ROOT / "content"
API_BASE = "http://play-cricket.com/api/v2"
MAX_OPP_MATCHES = 10


def load_dotenv():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def api_get(path, api_token, **params):
    params["api_token"] = api_token
    query = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{API_BASE}/{path}?{query}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read())


def parse_date(date_str):
    try:
        return datetime.strptime(date_str, "%d/%m/%Y").date()
    except (ValueError, TypeError):
        return None


# Stat helpers — mirrors the logic in fetch_player_stats.py

def overs_to_balls(overs_str):
    if not overs_str:
        return 0
    parts = str(overs_str).split(".")
    complete = int(parts[0]) if parts[0] else 0
    remainder = int(parts[1]) if len(parts) > 1 and parts[1] else 0
    return complete * 6 + remainder


def is_not_out(how_out):
    s = (how_out or "").strip().lower()
    return s in ("not out", "no") or s.startswith("retired")


def empty_batting():
    return {"innings": 0, "not_outs": 0, "runs": 0, "balls": 0,
            "high_score": None, "high_score_not_out": None}


def empty_bowling():
    return {"balls": 0, "maidens": 0, "runs": 0, "wickets": 0, "best": None}


def merge_batting(b, runs, balls, not_out):
    b["innings"] += 1
    if not_out:
        b["not_outs"] += 1
    b["runs"] += runs
    b["balls"] += balls
    if b["high_score"] is None or runs > b["high_score"]:
        b["high_score"] = runs
        b["high_score_not_out"] = not_out


def merge_bowling(b, balls, maidens, runs, wickets):
    b["balls"] += balls
    b["maidens"] += maidens
    b["runs"] += runs
    b["wickets"] += wickets
    cur = b["best"]
    if cur is None or wickets > cur["wickets"] or (
        wickets == cur["wickets"] and runs < cur["runs"]
    ):
        b["best"] = {"wickets": wickets, "runs": runs}


def derived_batting(b):
    outs = b["innings"] - b["not_outs"]
    b["average"] = round(b["runs"] / outs, 2) if outs > 0 else None


def derived_bowling(b):
    b["average"] = round(b["runs"] / b["wickets"], 2) if b["wickets"] > 0 else None
    b["economy"] = round(b["runs"] / b["balls"] * 6, 2) if b["balls"] > 0 else None


def determine_result_for_team(detail, their_team_id):
    """Return W/L/D/T/A/C from the perspective of their_team_id."""
    result = (detail.get("result") or "").strip().upper()
    if result in ("A", "C", "D", "T", "NR"):
        return result
    if result == "W":
        home_team_id = str(detail.get("home_team_id", ""))
        their_name = (
            detail.get("home_team_name", "")
            if their_team_id == home_team_id
            else detail.get("away_team_name", "")
        )
        result_desc = detail.get("result_description", "")
        return "W" if (their_name and their_name in result_desc) else "L"
    return None


def fetch_our_match_scorecard(match, our_pc_id, api_token):
    """Fetch and parse our team's scorecard from a completed match."""
    match_id = match["id"]
    try:
        result_data = api_get("match_detail.json", api_token, match_id=match_id)
        details = result_data.get("match_details", [])
        if not details:
            return None
        detail = details[0]
    except Exception as e:
        print(f"    WARNING: failed to fetch match detail {match_id}: {e}", file=sys.stderr)
        return None

    result_char = determine_result_for_team(detail, our_pc_id)
    result_description = (detail.get("result_description") or "").strip()

    home_id = str(detail.get("home_team_id", ""))
    away_id = str(detail.get("away_team_id", ""))
    is_home = our_pc_id == home_id
    opp_id = away_id if is_home else home_id

    our_innings_data = None
    their_innings_data = None
    for innings in detail.get("innings", []):
        batting_id = str(innings.get("team_batting_id", ""))
        if batting_id == our_pc_id:
            our_innings_data = innings
        elif batting_id == opp_id:
            their_innings_data = innings

    def innings_scorecard_batting(inn):
        """All batters in batting order, excluding DNB."""
        rows = []
        for bat in (inn or {}).get("bat", []):
            how_out = bat.get("how_out", "")
            if (how_out or "").strip().lower() == "dnb":
                continue
            pid = str(bat.get("batsman_id", ""))
            if not pid or pid == "0":
                continue
            rows.append({
                "name": bat.get("batsman_name", ""),
                "runs": int(bat.get("runs") or 0),
                "balls": int(bat.get("balls") or 0),
                "fours": int(bat.get("fours") or 0),
                "sixes": int(bat.get("sixes") or 0),
                "not_out": is_not_out(how_out),
                "how_out": (how_out or "").strip(),
                "fielder_name": (bat.get("fielder_name") or "").strip(),
                "bowler_name": (bat.get("bowler_name") or "").strip(),
            })
        return rows

    def innings_scorecard_bowling(inn):
        """All bowlers in bowling order with full figures."""
        acc = {}
        order = []
        for bowl in (inn or {}).get("bowl", []):
            pid = str(bowl.get("bowler_id", ""))
            if not pid or pid == "0":
                continue
            if pid not in acc:
                acc[pid] = {
                    "name": bowl.get("bowler_name", ""),
                    "wickets": 0, "runs": 0, "balls": 0, "maidens": 0,
                }
                order.append(pid)
            acc[pid]["wickets"] += int(bowl.get("wickets") or 0)
            acc[pid]["runs"] += int(bowl.get("runs") or 0)
            acc[pid]["balls"] += overs_to_balls(bowl.get("overs", "0"))
            acc[pid]["maidens"] += int(bowl.get("maidens") or 0)
        return [acc[pid] for pid in order]

    def innings_total(inn):
        if not inn:
            return None
        return {
            "runs": inn.get("runs", 0),
            "wickets": inn.get("wickets"),
            "overs": inn.get("overs") or "",
        }

    batted_first_id = str(detail.get("batted_first") or "")
    we_bat_first = batted_first_id == our_pc_id

    points_by_team = {str(p.get("team_id", "")): p for p in (detail.get("points") or [])}

    def calc_points(entry):
        if not entry:
            return None
        game = float(entry.get("game_points") or 0)
        bonus = float(entry.get("bonus_points_together") or 0)
        bonus_2nd = float(entry.get("bonus_points_2nd_innings_together") or 0)
        penalty = float(entry.get("penalty_points") or 0)
        total = game + bonus + bonus_2nd - penalty
        return int(total) if total == int(total) else round(total, 1)

    opp_club = (match.get("away_club_name", "") if is_home else match.get("home_club_name", "")) or ""
    opp_name = (match.get("away_team_name", "") if is_home else match.get("home_team_name", "")) or ""

    return {
        "match_date": match.get("match_date", ""),
        "match_time": match.get("match_time") or None,
        "ground_name": match.get("ground_name") or None,
        "competition_id": str(match.get("competition_id", "")),
        "competition_name": match.get("competition_name", "") or "",
        "is_home": is_home,
        "result": result_char,
        "result_description": result_description,
        "opposition_name": opp_name,
        "opposition_club_name": opp_club,
        "we_bat_first": we_bat_first,
        "our_total": innings_total(our_innings_data),
        "their_total": innings_total(their_innings_data),
        "our_batting": innings_scorecard_batting(our_innings_data),
        "our_bowling": innings_scorecard_bowling(their_innings_data),
        "their_batting": innings_scorecard_batting(their_innings_data),
        "their_bowling": innings_scorecard_bowling(our_innings_data),
        "our_points": calc_points(points_by_team.get(our_pc_id)),
        "their_points": calc_points(points_by_team.get(opp_id)),
        "opposition_team_id": opp_id,
    }


def fetch_opposition_data(opp_team_id, opp_site_id, season_year, api_token):
    """Fetch form and top player stats for a specific opposition team."""
    try:
        data = api_get("matches.json", api_token, site_id=opp_site_id, season=season_year)
    except Exception as e:
        print(f"    WARNING: failed to fetch opposition matches: {e}", file=sys.stderr)
        return None

    today = date.today()
    their_matches = [
        m for m in data.get("matches", [])
        if (str(m.get("home_team_id", "")) == opp_team_id
            or str(m.get("away_team_id", "")) == opp_team_id)
        and (parse_date(m.get("match_date", "")) or date.max) <= today
    ]
    their_matches_sorted = sorted(
        their_matches, key=lambda m: parse_date(m.get("match_date", "")) or date.min
    )
    recent = their_matches_sorted[-MAX_OPP_MATCHES:]

    form = []
    players = {}

    for match in recent:
        match_id = match["id"]
        try:
            result = api_get("match_detail.json", api_token, match_id=match_id)
            details = result.get("match_details", [])
            if not details:
                continue
            detail = details[0]

            result_char = determine_result_for_team(detail, opp_team_id)
            if result_char:
                form.append(result_char)

            home_team_id = str(detail.get("home_team_id", ""))
            away_team_id = str(detail.get("away_team_id", ""))

            for innings in detail.get("innings", []):
                batting_team_id = str(innings.get("team_batting_id", ""))
                fielding_team_id = (
                    away_team_id if batting_team_id == home_team_id else home_team_id
                )

                if batting_team_id == opp_team_id:
                    for bat in innings.get("bat", []):
                        how_out = bat.get("how_out", "")
                        if (how_out or "").strip().lower() == "dnb":
                            continue
                        pid = str(bat.get("batsman_id", ""))
                        if not pid or pid == "0":
                            continue
                        if pid not in players:
                            players[pid] = {
                                "name": bat.get("batsman_name", ""),
                                "batting": empty_batting(),
                                "bowling": empty_bowling(),
                            }
                        merge_batting(
                            players[pid]["batting"],
                            int(bat.get("runs") or 0),
                            int(bat.get("balls") or 0),
                            is_not_out(how_out),
                        )

                if fielding_team_id == opp_team_id:
                    for bowl in innings.get("bowl", []):
                        pid = str(bowl.get("bowler_id", ""))
                        if not pid or pid == "0":
                            continue
                        if pid not in players:
                            players[pid] = {
                                "name": bowl.get("bowler_name", ""),
                                "batting": empty_batting(),
                                "bowling": empty_bowling(),
                            }
                        merge_bowling(
                            players[pid]["bowling"],
                            overs_to_balls(bowl.get("overs", "0")),
                            int(bowl.get("maidens") or 0),
                            int(bowl.get("runs") or 0),
                            int(bowl.get("wickets") or 0),
                        )

        except Exception as e:
            print(
                f"    WARNING: failed to process opposition match {match_id}: {e}",
                file=sys.stderr,
            )

    for p in players.values():
        derived_batting(p["batting"])
        derived_bowling(p["bowling"])

    top_batters = sorted(
        [p for p in players.values() if p["batting"]["innings"] > 0],
        key=lambda p: p["batting"]["runs"],
        reverse=True,
    )[:3]

    top_bowlers = sorted(
        [p for p in players.values() if p["bowling"]["wickets"] > 0],
        key=lambda p: p["bowling"]["wickets"],
        reverse=True,
    )[:3]

    def fmt_batter(p):
        b = p["batting"]
        return {
            "name": p["name"],
            "innings": b["innings"],
            "not_outs": b["not_outs"],
            "runs": b["runs"],
            "average": b["average"],
            "high_score": b["high_score"],
            "high_score_not_out": bool(b["high_score_not_out"]),
        }

    def fmt_bowler(p):
        b = p["bowling"]
        return {
            "name": p["name"],
            "wickets": b["wickets"],
            "average": b["average"],
            "economy": b["economy"],
            "best": b["best"],
        }

    return {
        "form": form[-5:],
        "players": {
            "batting": [fmt_batter(p) for p in top_batters],
            "bowling": [fmt_bowler(p) for p in top_bowlers],
        },
    }


def main():
    api_token = os.environ.get("PLAY_CRICKET_API_TOKEN")
    site_id = os.environ.get("PLAY_CRICKET_SITE_ID")

    if not api_token or not site_id:
        missing = [
            k for k, v in {
                "PLAY_CRICKET_API_TOKEN": api_token,
                "PLAY_CRICKET_SITE_ID": site_id,
            }.items()
            if not v
        ]
        print(f"{', '.join(missing)} not set — skipping fixture fetch")
        sys.exit(0)

    config = json.loads((CONTENT / "config.json").read_text())
    teams = json.loads((CONTENT / "teams.json").read_text())["teams"]

    season_year = config["seasons"]["this_season"]
    teams_by_pc_id = {
        str(t["play_cricket_team_id"]): t
        for t in teams
        if "play_cricket_team_id" in t
    }

    print(f"Fetching fixture list for season {season_year}...")
    data = api_get("matches.json", api_token, site_id=site_id, season=season_year)
    all_matches = data.get("matches", [])

    today = date.today()

    # Find the earliest upcoming match per team (for next-match slides)
    # and collect all upcoming matches per team (for schedule slides)
    upcoming = {}
    all_upcoming = {}  # team_id → list of slim match dicts, sorted by date
    for match in all_matches:
        home_id = str(match.get("home_team_id", ""))
        away_id = str(match.get("away_team_id", ""))
        match_date = parse_date(match.get("match_date", ""))
        if not match_date or match_date <= today:
            continue
        for our_pc_id, team in teams_by_pc_id.items():
            if our_pc_id not in (home_id, away_id):
                continue
            tid = team["id"]
            is_home = our_pc_id == home_id
            existing_date = parse_date((upcoming.get(tid) or {}).get("match_date", ""))
            if existing_date is None or match_date < existing_date:
                upcoming[tid] = match
            all_upcoming.setdefault(tid, []).append({
                "match_date": match.get("match_date", ""),
                "match_time": match.get("match_time") or None,
                "ground_name": match.get("ground_name") or None,
                "competition_name": match.get("competition_name", ""),
                "is_home": is_home,
                "opposition_club_name": (
                    match.get("away_club_name", "") if is_home else match.get("home_club_name", "")
                ) or "",
                "opposition_team_name": (
                    match.get("away_team_name", "") if is_home else match.get("home_team_name", "")
                ) or "",
            })

    for tid in all_upcoming:
        all_upcoming[tid].sort(key=lambda m: parse_date(m["match_date"]) or date.max)

    print(f"  {len(upcoming)} team(s) with upcoming fixtures")

    teams_by_id = {t["id"]: t for t in teams}

    fixtures = {}
    for team_id, match in upcoming.items():
        team = teams_by_id[team_id]
        our_pc_id = str(team["play_cricket_team_id"])
        home_id = str(match.get("home_team_id", ""))
        away_id = str(match.get("away_team_id", ""))
        is_home = our_pc_id == home_id
        opp_team_id = away_id if is_home else home_id
        opp_name = (
            match.get("away_team_name", "") if is_home else match.get("home_team_name", "")
        )

        # Derive opposition club_id and club_name from the match
        home_club_id = str(match.get("home_club_id", ""))
        away_club_id = str(match.get("away_club_id", ""))
        opp_site_id = away_club_id if is_home else home_club_id
        opp_club_name = (
            match.get("away_club_name", "") if is_home else match.get("home_club_name", "")
        ) or ""

        fixture = {
            "match_date": match.get("match_date", ""),
            "match_time": match.get("match_time") or None,
            "ground_name": match.get("ground_name") or None,
            "competition_id": str(match.get("competition_id", "")),
            "competition_name": match.get("competition_name", ""),
            "is_home": is_home,
            "opposition_name": opp_name,
            "opposition_club_name": opp_club_name,
            "opposition_team_id": opp_team_id,
            "opposition_site_id": opp_site_id or None,
            "opposition_form": None,
            "opposition_players": None,
        }

        if opp_site_id:
            print(f"  Fetching opposition data for {team_id} vs {opp_name} (site {opp_site_id})...")
            opp_data = fetch_opposition_data(
                opp_team_id, opp_site_id, season_year, api_token
            )
            if opp_data:
                fixture["opposition_form"] = opp_data["form"]
                fixture["opposition_players"] = opp_data["players"]
        else:
            print(f"  WARNING: no club_id found for opposition in match {match.get('id')} — skipping opposition data")

        fixtures[team_id] = fixture

    # Find most-recent completed match per team (for last-match slides)
    last_match_candidates = {}
    for match in all_matches:
        home_id = str(match.get("home_team_id", ""))
        away_id = str(match.get("away_team_id", ""))
        match_date = parse_date(match.get("match_date", ""))
        if not match_date or match_date >= today:
            continue
        for our_pc_id, team in teams_by_pc_id.items():
            if our_pc_id not in (home_id, away_id):
                continue
            tid = team["id"]
            existing_date = parse_date((last_match_candidates.get(tid) or {}).get("match_date", ""))
            if existing_date is None or match_date > existing_date:
                last_match_candidates[tid] = match

    print(f"  {len(last_match_candidates)} team(s) with recent matches — fetching scorecards...")
    last_match = {}
    for team_id, match in last_match_candidates.items():
        team = teams_by_id[team_id]
        our_pc_id = str(team["play_cricket_team_id"])
        is_home_lm = our_pc_id == str(match.get("home_team_id", ""))
        opp = (match.get("away_team_name", "") if is_home_lm else match.get("home_team_name", "")) or "?"
        print(f"  Fetching last match scorecard for {team_id} vs {opp}...")
        scorecard = fetch_our_match_scorecard(match, our_pc_id, api_token)
        if scorecard:
            last_match[team_id] = scorecard

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "season": season_year,
        "fixtures": fixtures,
        "all_fixtures": all_upcoming,
        "last_match": last_match,
    }
    data_dir = CONTENT / "data" / "fetched"
    data_dir.mkdir(parents=True, exist_ok=True)
    out_path = data_dir / "fixtures.json"
    out_path.write_text(json.dumps(out, indent=2))
    print(f"  → {out_path.relative_to(ROOT)}")


if __name__ == "__main__":
    load_dotenv()
    main()
