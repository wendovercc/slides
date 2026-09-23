#!/usr/bin/env python3
"""Write the committed package snapshot a pinned match is built from.

`load_pinned_matches()` in build.py reads a pin's scorecard from
content/data/matches/{match_id}.package.json rather than from fixtures.json,
because fetch_fixtures.py only retains each team's most recent games — an older
match rolls out of the live feed while the pin is meant to outlive it. A
completed match is immutable, so the snapshot never goes stale.

Until now those snapshots were made by hand. This writes one, reusing
fetch_fixtures.fetch_our_match_scorecard so the shape cannot drift from the
live feed's.

The case that needs it most is a match fixtures.json never carried in the first
place: an intra-club game (President's Day, pre-season, a festival), whose sides
are ad-hoc Play-Cricket teams that appear in no team's fixture list. Name which
side the package speaks as with --our-team-id; the other becomes "opposition"
throughout, which is how every downstream slide is written.

    python scripts/make_match_package.py --match-id 7756252 --our-team-id 424725

A club scorer does not always close a match on Play-Cricket. When the API still
reports it in progress, or the ground was left unset, the snapshot is the right
place to correct it — it is committed, hand-curated, and read in preference to
the feed. The overrides are deliberately explicit so a correction is visible in
the diff and in this command line, never silently inferred:

    --ground "Witchell Ground" --result W --result-description "..."

Requires PLAY_CRICKET_API_TOKEN (and PLAY_CRICKET_SITE_ID to locate the match).
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import fetch_fixtures as ff

ROOT = Path(__file__).parent.parent
CONTENT = ROOT / "content"
CURATION_DIR = CONTENT / "data" / "matches"
# Both sides of an intra-club game are us, so the "opposition" crest is our own.
WCC_CREST = "/assets/images/wcc-logo.png"


def find_match(match_id, site_id, season, api_token):
    """The match's listing entry — fetch_our_match_scorecard reads the fixture
    fields (date, time, ground, competition, club names/ids) from it, and only
    the innings from match_detail."""
    data = ff.api_get("matches.json", api_token, site_id=site_id, season=season)
    for m in data.get("matches", []):
        if str(m.get("id")) == str(match_id):
            return m
    return None


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--match-id", type=int, required=True)
    p.add_argument("--our-team-id", default=None,
                   help="Play-Cricket team id the package speaks as (default: the "
                        "home side, which is what an intra-club fixture is listed under)")
    p.add_argument("--season", type=int, default=None,
                   help="season to search for the match (default: from config.json)")
    p.add_argument("--ground", default=None, help="override ground_name")
    p.add_argument("--competition", default=None,
                   help="override competition_name — a club-day fixture is filed "
                        "under no competition, and the slides have a line for one")
    p.add_argument("--result", default=None,
                   help="override result (W/L/D/T/A/C/NR) — for a match Play-Cricket "
                        "never finalised")
    p.add_argument("--result-description", default=None, help="override result_description")
    p.add_argument("--opposition-crest", default=None,
                   help=f"override the opposition crest path (intra-club: {WCC_CREST})")
    args = p.parse_args()

    ff.load_dotenv()
    api_token = os.environ.get("PLAY_CRICKET_API_TOKEN")
    site_id = os.environ.get("PLAY_CRICKET_SITE_ID")
    if not api_token or not site_id:
        sys.exit("PLAY_CRICKET_API_TOKEN and PLAY_CRICKET_SITE_ID must be set")

    season = args.season or json.loads((CONTENT / "config.json").read_text()) \
        ["seasons"]["this_season"]

    match = find_match(args.match_id, site_id, season, api_token)
    if not match:
        sys.exit(f"Match {args.match_id} not found in site {site_id}'s {season} matches")

    our_id = str(args.our_team_id or match.get("home_team_id") or "")
    if not our_id:
        sys.exit("Could not determine our team id — pass --our-team-id")

    pkg = ff.fetch_our_match_scorecard(match, our_id, api_token)
    if not pkg:
        sys.exit(f"No scorecard available for match {args.match_id}")

    # Opposition enrichment (crest, form, performers) is left to the caller by
    # fetch_our_match_scorecard, and stays None here by default: an ad-hoc
    # intra-club side has no season behind it to have form or performers from.
    if args.opposition_crest:
        pkg["opposition_crest"] = args.opposition_crest
    if args.ground:
        pkg["ground_name"] = args.ground
    if args.competition:
        pkg["competition_name"] = args.competition
    if args.result:
        pkg["result"] = args.result
    if args.result_description:
        pkg["result_description"] = args.result_description

    out = CURATION_DIR / f"{args.match_id}.package.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(pkg, indent=2) + "\n")

    print(f"  {out.relative_to(ROOT)}")
    print(f"  v {pkg['opposition_club_name']} {pkg['opposition_name']} "
          f"({'home' if pkg['is_home'] else 'away'}) · result {pkg['result']}")
    ours, theirs = pkg.get("our_total") or {}, pkg.get("their_total") or {}
    print(f"  us {ours.get('runs')}/{ours.get('wickets')} ({ours.get('overs')}) · "
          f"them {theirs.get('runs')}/{theirs.get('wickets')} ({theirs.get('overs')})")


if __name__ == "__main__":
    main()
