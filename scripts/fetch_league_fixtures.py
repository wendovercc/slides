#!/usr/bin/env python3
"""Fetch the OTHER games in our leagues that are happening TODAY.

Feeds the live ticker's "other results / scores coming in" segment. The match
ids are resolved here at build time (fixtures are scheduled days ahead); the
live-proxy Worker later polls each id's PC-API match_detail for a score at a
slow cadence — see docs/live-presentation.md and the project note.

Scope is deliberately narrow: we only spend PC-API calls on competitions WCC
actually has a game in TODAY. No WCC league game today → we do (almost) nothing.

Why enumerate clubs at all: PC-API `matches.json` is strictly site_id-scoped —
there is no competition-wide matches endpoint, and no team_id→club/site lookup.
But our own season fixtures already pair every opponent with its club_id (which
IS the site_id), so the clubs in a division we care about = the clubs we play in
it. We harvest those and query each club's matches.json for today.

Writes content/data/fetched/league_today.json. Requires PLAY_CRICKET_API_TOKEN
and PLAY_CRICKET_SITE_ID; exits cleanly if absent so local builds use committed
data. Honours WCC_TODAY=YYYY-MM-DD to pin "today" for off-day testing.
"""

import json
import os
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).parent.parent
CONTENT = ROOT / "content"
FETCHED = CONTENT / "data" / "fetched"
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
    query = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    with urllib.request.urlopen(f"{API_BASE}/{path}?{query}", timeout=30) as resp:
        return json.loads(resp.read())


def today_date():
    """Build's notion of today; WCC_TODAY pins it for off-day testing."""
    override = os.environ.get("WCC_TODAY")
    if override:
        try:
            return datetime.strptime(override, "%Y-%m-%d").date()
        except ValueError:
            print(f"  WCC_TODAY={override!r} invalid — using real date")
    return date.today()


def parse_date(s):
    try:
        return datetime.strptime(s, "%d/%m/%Y").date()
    except (ValueError, TypeError):
        return None


def slim(match, competition_name):
    """The ticker-facing identity of a league match. Score/result are NOT here —
    those come later from the Worker's per-match match_detail poll; this is just
    who's playing, where, and the id to poll."""
    return {
        "match_id": match.get("id"),
        "competition_id": str(match.get("competition_id", "")),
        "competition_name": competition_name or match.get("competition_name", ""),
        "match_date": match.get("match_date", ""),
        "match_time": match.get("match_time") or None,
        "ground_name": match.get("ground_name") or None,
        "home_club_name": match.get("home_club_name", "") or "",
        "home_team_name": match.get("home_team_name", "") or "",
        "home_team_id": str(match.get("home_team_id") or ""),
        "away_club_name": match.get("away_club_name", "") or "",
        "away_team_name": match.get("away_team_name", "") or "",
        "away_team_id": str(match.get("away_team_id") or ""),
    }


def main():
    load_dotenv()
    api_token = os.environ.get("PLAY_CRICKET_API_TOKEN")
    site_id = os.environ.get("PLAY_CRICKET_SITE_ID")
    if not api_token or not site_id:
        missing = [k for k, v in {"PLAY_CRICKET_API_TOKEN": api_token,
                                  "PLAY_CRICKET_SITE_ID": site_id}.items() if not v]
        print(f"{', '.join(missing)} not set — skipping league-wide fetch")
        sys.exit(0)

    config = json.loads((CONTENT / "config.json").read_text())
    season = config["seasons"]["this_season"]
    today = today_date()
    today_str = today.strftime("%d/%m/%Y")

    def write(matches):
        FETCHED.mkdir(parents=True, exist_ok=True)
        out = {"generated_at": int(datetime.now().timestamp()),
               "date": today.isoformat(), "season": season, "matches": matches}
        path = FETCHED / "league_today.json"
        path.write_text(json.dumps(out, indent=2) + "\n")
        print(f"  → {path.relative_to(ROOT)} — {len(matches)} league match(es) today")

    # 1) Our season, once. This single call answers both "what leagues are we in
    #    today" and "which clubs share those leagues" (the club_id bridge).
    print(f"Fetching WCC season {season} to scope today's leagues...")
    our = api_get("matches.json", api_token, site_id=site_id, season=season).get("matches", [])

    # 2) Today's WCC matches → the competitions "happening today". Only these earn
    #    any further calls. Friendlies (no competition_id) have no league siblings.
    our_today_ids = set()
    today_comps = set()
    for m in our:
        if m.get("match_date") != today_str:
            continue
        our_today_ids.add(str(m.get("id")))
        cid = str(m.get("competition_id") or "")
        if cid:
            today_comps.add(cid)
    if not today_comps:
        print("  No WCC league match today — nothing to enrich")
        write([])
        return
    print(f"  {len(our_today_ids)} WCC match(es) today across {len(today_comps)} league(s)")

    # 3) Sibling club site_ids per today-league = the clubs we play in it
    #    (club_id == site_id). Excludes ourselves — our games aren't "other" games.
    clubs_by_comp = defaultdict(set)
    for m in our:
        cid = str(m.get("competition_id") or "")
        if cid not in today_comps:
            continue
        for club in (str(m.get("home_club_id") or ""), str(m.get("away_club_id") or "")):
            if club and club != str(site_id):
                clubs_by_comp[cid].add(club)
    all_clubs = sorted({c for cs in clubs_by_comp.values() for c in cs})
    comp_names = {str(m.get("competition_id")): m.get("competition_name")
                  for m in our if m.get("competition_id")}
    print(f"  {len(all_clubs)} sibling club(s) to check across today's leagues")

    # 4) Each sibling club's matches TODAY, kept only when it's in one of today's
    #    leagues (a club may also have unrelated games today) and isn't a WCC game.
    #    Dedupe by id — two clubs in the same match both surface it.
    league_today = {}
    for club in all_clubs:
        try:
            rows = api_get("matches.json", api_token, site_id=club, season=season).get("matches", [])
        except Exception as e:  # a single club's blip must not sink the batch
            print(f"    WARNING: matches.json failed for club {club}: {e}", file=sys.stderr)
            continue
        for m in rows:
            mid = str(m.get("id"))
            cid = str(m.get("competition_id") or "")
            if m.get("match_date") != today_str or cid not in today_comps:
                continue
            if mid in our_today_ids or mid in league_today:
                continue
            league_today[mid] = slim(m, comp_names.get(cid))

    matches = sorted(league_today.values(),
                     key=lambda x: (x.get("match_time") or "99:99", x["competition_name"]))
    write(matches)


if __name__ == "__main__":
    main()
