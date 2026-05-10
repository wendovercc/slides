#!/usr/bin/env python3
"""Fetch and aggregate player batting/bowling stats from Play Cricket match details.

For each season in content/config.json, fetches all matches for our teams,
processes each completed match's scorecard, and writes aggregated per-player
stats to content/data/player_stats_{label}.json.

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


def overs_to_balls(overs_str):
    """Convert cricket overs string e.g. '8.3' (8 overs 3 balls) to total balls."""
    if not overs_str:
        return 0
    parts = str(overs_str).split(".")
    complete = int(parts[0]) if parts[0] else 0
    remainder = int(parts[1]) if len(parts) > 1 and parts[1] else 0
    return complete * 6 + remainder


def is_not_out(how_out):
    s = (how_out or "").strip().lower()
    return s == "not out" or s.startswith("retired")


def empty_stats_block():
    return {
        "matches": 0,
        "batting": {
            "innings": 0,
            "not_outs": 0,
            "runs": 0,
            "balls": 0,
            "high_score": None,
            "high_score_not_out": None,
            "fours": 0,
            "sixes": 0,
            "fifties": 0,
            "hundreds": 0,
        },
        "bowling": {
            "balls": 0,
            "maidens": 0,
            "runs": 0,
            "wickets": 0,
            "best": None,
        },
    }


def merge_batting(block, runs, balls, fours, sixes, not_out):
    b = block["batting"]
    b["innings"] += 1
    if not_out:
        b["not_outs"] += 1
    b["runs"] += runs
    b["balls"] += balls
    b["fours"] += fours
    b["sixes"] += sixes
    if runs >= 100:
        b["hundreds"] += 1
    elif runs >= 50:
        b["fifties"] += 1
    if b["high_score"] is None or runs > b["high_score"]:
        b["high_score"] = runs
        b["high_score_not_out"] = not_out


def compute_derived(block):
    """Add derived batting and bowling stats to a stats block in place."""
    b = block["batting"]
    outs = b["innings"] - b["not_outs"]
    b["average"] = round(b["runs"] / outs, 2) if outs > 0 else None
    b["strike_rate"] = round(b["runs"] / b["balls"] * 100, 2) if b["balls"] > 0 else None

    bl = block["bowling"]
    bl["average"] = round(bl["runs"] / bl["wickets"], 2) if bl["wickets"] > 0 else None
    bl["economy"] = round(bl["runs"] / bl["balls"] * 6, 2) if bl["balls"] > 0 else None


def compute_all_derived(players):
    for player in players.values():
        compute_derived(player["stats"]["all"])
        for team_entry in player["stats"]["by_team"].values():
            compute_derived(team_entry["all"])
            for comp_block in team_entry["by_competition"].values():
                compute_derived(comp_block)


def merge_bowling(block, balls, maidens, runs, wickets):
    b = block["bowling"]
    b["balls"] += balls
    b["maidens"] += maidens
    b["runs"] += runs
    b["wickets"] += wickets
    current_best = b["best"]
    if current_best is None or wickets > current_best["wickets"] or (
        wickets == current_best["wickets"] and runs < current_best["runs"]
    ):
        b["best"] = {"wickets": wickets, "runs": runs}


def get_or_create_player(players, player_id, player_name):
    if player_id not in players:
        players[player_id] = {
            "id": player_id,
            "name": player_name,
            "teams": [],
            "stats": {
                "all": empty_stats_block(),
                "by_team": {},
            },
        }
    return players[player_id]


def ensure_team_stats(player, team_id):
    if team_id not in player["stats"]["by_team"]:
        player["stats"]["by_team"][team_id] = {
            "all": empty_stats_block(),
            "by_competition": {},
        }
    return player["stats"]["by_team"][team_id]


def ensure_competition_stats(team_stats, competition_id):
    if competition_id not in team_stats["by_competition"]:
        team_stats["by_competition"][competition_id] = empty_stats_block()
    return team_stats["by_competition"][competition_id]


def determine_result(detail, our_pc_team_id):
    """Return the match result from our team's perspective: W/L/D/T/A/C or None."""
    result = (detail.get("result") or "").strip().upper()
    if result in ("A", "C", "D", "T", "NR"):
        return result
    if result == "W":
        home_team_id = str(detail.get("home_team_id", ""))
        our_name = (
            detail.get("home_team_name", "")
            if our_pc_team_id == home_team_id
            else detail.get("away_team_name", "")
        )
        result_desc = detail.get("result_description", "")
        return "W" if (our_name and our_name in result_desc) else "L"
    return None


def process_match(detail, our_teams_by_pc_id, players, competitions, form, match_date_str=""):
    competition_id = str(detail.get("competition_id", ""))
    competition_name = detail.get("competition_name", "")
    if competition_id and competition_name:
        competitions[competition_id] = competition_name

    home_team_id = str(detail.get("home_team_id", ""))
    away_team_id = str(detail.get("away_team_id", ""))

    # Identify which Play Cricket team ID is ours and map to internal ID
    if home_team_id in our_teams_by_pc_id:
        our_pc_team_id = home_team_id
    elif away_team_id in our_teams_by_pc_id:
        our_pc_team_id = away_team_id
    else:
        return
    our_team_id = our_teams_by_pc_id[our_pc_team_id]

    result_char = determine_result(detail, our_pc_team_id)
    if result_char and match_date_str:
        form.setdefault(our_team_id, []).append((match_date_str, result_char))

    innings_list = detail.get("innings", [])
    if not innings_list:
        return

    match_players = set()

    for innings in innings_list:
        batting_team_id = str(innings.get("team_batting_id", ""))
        # team_fielding_id is not populated in the API — infer from match header
        fielding_team_id = away_team_id if batting_team_id == home_team_id else home_team_id

        our_batting = batting_team_id == our_pc_team_id
        our_bowling = fielding_team_id == our_pc_team_id

        if our_batting:
            for bat in innings.get("bat", []):
                how_out = bat.get("how_out", "")
                if (how_out or "").strip().lower() == "dnb":
                    continue
                player_id = str(bat.get("batsman_id", ""))
                if not player_id or player_id == "0":
                    continue

                player_name = bat.get("batsman_name", "")
                runs = int(bat.get("runs") or 0)
                balls = int(bat.get("balls") or 0)
                fours = int(bat.get("fours") or 0)
                sixes = int(bat.get("sixes") or 0)
                not_out = is_not_out(how_out)

                player = get_or_create_player(players, player_id, player_name)
                if our_team_id not in player["teams"]:
                    player["teams"].append(our_team_id)

                team_stats = ensure_team_stats(player, our_team_id)
                comp_stats = ensure_competition_stats(team_stats, competition_id) if competition_id else None

                merge_batting(player["stats"]["all"], runs, balls, fours, sixes, not_out)
                merge_batting(team_stats["all"], runs, balls, fours, sixes, not_out)
                if comp_stats:
                    merge_batting(comp_stats, runs, balls, fours, sixes, not_out)

                match_players.add(player_id)

        if our_bowling:
            for bowl in innings.get("bowl", []):
                player_id = str(bowl.get("bowler_id", ""))
                if not player_id or player_id == "0":
                    continue

                player_name = bowl.get("bowler_name", "")
                balls = overs_to_balls(bowl.get("overs", "0"))
                maidens = int(bowl.get("maidens") or 0)
                runs = int(bowl.get("runs") or 0)
                wickets = int(bowl.get("wickets") or 0)

                player = get_or_create_player(players, player_id, player_name)
                if our_team_id not in player["teams"]:
                    player["teams"].append(our_team_id)

                team_stats = ensure_team_stats(player, our_team_id)
                comp_stats = ensure_competition_stats(team_stats, competition_id) if competition_id else None

                merge_bowling(player["stats"]["all"], balls, maidens, runs, wickets)
                merge_bowling(team_stats["all"], balls, maidens, runs, wickets)
                if comp_stats:
                    merge_bowling(comp_stats, balls, maidens, runs, wickets)

                match_players.add(player_id)

    # Increment match counts once per player per match
    for player_id in match_players:
        player = players[player_id]
        player["stats"]["all"]["matches"] += 1
        team_entry = player["stats"]["by_team"].get(our_team_id)
        if team_entry:
            team_entry["all"]["matches"] += 1
            if competition_id and competition_id in team_entry["by_competition"]:
                team_entry["by_competition"][competition_id]["matches"] += 1


def fetch_season_stats(site_id, api_token, season_year, our_teams_by_pc_id):
    print(f"  Fetching match list for season {season_year}...")
    data = api_get("matches.json", api_token, site_id=site_id, season=season_year)
    all_matches = data.get("matches", [])

    today = date.today()

    def match_date(m):
        try:
            return datetime.strptime(m.get("match_date", ""), "%d/%m/%Y").date()
        except ValueError:
            return None

    our_matches = [
        m for m in all_matches
        if (str(m.get("home_team_id", "")) in our_teams_by_pc_id
            or str(m.get("away_team_id", "")) in our_teams_by_pc_id)
        and (match_date(m) or date.max) <= today
    ]
    print(f"  {len(our_matches)} completed matches found for our teams")

    players = {}
    competitions = {}
    form = {}

    our_matches_sorted = sorted(our_matches, key=lambda m: match_date(m) or date.min)

    for match in our_matches_sorted:
        match_id = match["id"]
        match_date_str = match.get("match_date", "")
        try:
            result = api_get("match_detail.json", api_token, match_id=match_id)
            details = result.get("match_details", [])
            if details:
                process_match(details[0], our_teams_by_pc_id, players, competitions, form, match_date_str)
        except Exception as e:
            print(f"    WARNING: failed to process match {match_id}: {e}", file=sys.stderr)

    compute_all_derived(players)

    # Sort by date (already sorted) and keep only the result characters, last 5
    form_trimmed = {
        team_id: [r for _, r in sorted(entries, key=lambda x: x[0])][-5:]
        for team_id, entries in form.items()
    }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "season": season_year,
        "competitions": competitions,
        "players": players,
        "form": form_trimmed,
    }


def main():
    api_token = os.environ.get("PLAY_CRICKET_API_TOKEN")
    site_id = os.environ.get("PLAY_CRICKET_SITE_ID")

    if not api_token or not site_id:
        missing = [k for k, v in {
            "PLAY_CRICKET_API_TOKEN": api_token,
            "PLAY_CRICKET_SITE_ID": site_id,
        }.items() if not v]
        print(f"{', '.join(missing)} not set — skipping player stats fetch")
        sys.exit(0)

    config = json.loads((CONTENT / "config.json").read_text())
    teams = json.loads((CONTENT / "teams.json").read_text())["teams"]

    our_teams_by_pc_id = {
        str(t["play_cricket_team_id"]): t["id"]
        for t in teams
        if "play_cricket_team_id" in t
    }

    data_dir = CONTENT / "data"
    data_dir.mkdir(exist_ok=True)

    for label, year in config["seasons"].items():
        print(f"Fetching player stats: {label} ({year})...")
        stats = fetch_season_stats(site_id, api_token, year, our_teams_by_pc_id)
        out_path = data_dir / f"player_stats_{label}.json"
        out_path.write_text(json.dumps(stats, indent=2))
        print(f"  → {out_path.relative_to(ROOT)}")
        player_count = len(stats["players"])
        match_count = sum(
            p["stats"]["all"]["matches"] for p in stats["players"].values()
        ) // max(len(our_teams_by_pc_id), 1)
        print(f"  {player_count} players across ~{match_count} matches")


if __name__ == "__main__":
    load_dotenv()
    main()
