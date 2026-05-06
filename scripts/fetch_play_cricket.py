#!/usr/bin/env python3
"""Fetch Play Cricket data at build time.

Reads content/teams.json and fetches a league table for each team that has a
division_id. Requires PLAY_CRICKET_API_TOKEN env var; exits cleanly if absent
so local builds work using committed fixture files.
"""

import json
import os
import sys
import urllib.request
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


def fetch_league_table(division_id, api_token):
    url = f"{API_BASE}/league_table.json?division_id={division_id}&api_token={api_token}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read())


def main():
    api_token = os.environ.get("PLAY_CRICKET_API_TOKEN")
    if not api_token:
        print("PLAY_CRICKET_API_TOKEN not set — skipping Play Cricket fetch")
        sys.exit(0)

    teams = json.loads((CONTENT / "teams.json").read_text())["teams"]

    data_dir = CONTENT / "data"
    data_dir.mkdir(exist_ok=True)

    for team in teams:
        league_id = team.get("play_cricket_league_id")
        if not league_id:
            print(f"  {team['id']}: no play_cricket_league_id — skipping")
            continue

        print(f"  Fetching league table for {team['name']} (league {league_id})...")
        try:
            data = fetch_league_table(league_id, api_token)
            out_path = data_dir / f"league_table_{league_id}.json"
            out_path.write_text(json.dumps(data, indent=2))
            print(f"    → {out_path.relative_to(ROOT)}")
        except Exception as e:
            print(f"    ERROR: {e}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    load_dotenv()
    print("Fetching Play Cricket data...")
    main()
