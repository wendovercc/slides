#!/usr/bin/env python3
"""Publish assets for a composed match deck — title, description, thumbnail, playlist.

    python scripts/publish_meta.py last-match-1st-xi

Writes build/publish/<deck>/ containing everything the YouTube upload form wants:

    title.txt          spoiler-free, <=100 chars
    description.txt    summary + chapters + result + performers
    thumbnail.png      1280x720
    publish.json       the same fields machine-readable, for a future API upload

**Upload is deliberately NOT automated.** YOUTUBE_API_KEY is an API key, which can
only authenticate read calls; videos.insert needs OAuth with the youtube.upload
scope. More decisively, uploads from an unaudited API project are *locked* to
private (any project created after 28 July 2020), and lifting that needs a
compliance audit — so an automated upload would produce a video that cannot be
published. These assets make the manual upload a copy-paste, and publish.json is
shaped so the API call can be added later without redoing any of it.

Chapters come from the deck's derived timeline (scripts/timeline.py), so the
timestamps are the ones the compositor actually rendered, not an estimate.
"""
import argparse
import json
import re
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build  # noqa: E402  — importable: its main body is under a __main__ guard
import timeline as timeline_mod  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUT_ROOT = ROOT / "build" / "publish"
THUMB_W, THUMB_H = 1280, 720
TITLE_MAX = 100          # YouTube's hard limit
CLUB_URL = "wendovercc.org"


# ── match facts ───────────────────────────────────────────────────────────────

def team_id_from_deck(deck):
    """"last-match-1st-xi" -> "1st-xi". Match decks are named after their team."""
    m = re.match(r"^last-match-(.+)$", deck)
    return m.group(1) if m else None


def load_match(team_id):
    fixtures = json.loads((build.FETCHED / "fixtures.json").read_text())
    match = (fixtures.get("last_match") or {}).get(team_id)
    if not match:
        raise SystemExit(f"no last match for team '{team_id}' in fixtures.json")
    teams = json.loads((build.CONTENT / "teams.json").read_text())
    teams = teams["teams"] if isinstance(teams, dict) else teams
    team = next((t for t in teams if t.get("id") == team_id), {})
    return match, team


def competition_line(match, team):
    """League and division together.

    Never the division alone: "Division 6C" identifies nothing to anyone outside
    the league, and a YouTube title is read by exactly those people.
    """
    league = team.get("league_name", "") or ""
    comp = match.get("competition_name", "") or ""
    if league and comp and comp != league:
        return f"{league} {comp}"
    return league or comp


def sides_of(match, team, we_first=True):
    """Both sides as (club, designation), our side first unless `we_first` is False."""
    opp_club, opp_desig = build._split_opp_name(
        match.get("opposition_name", ""), match.get("opposition_club_name", ""))
    ours = {"club": build.OUR_CLUB, "desig": team.get("name", ""),
            "crest": "/assets/images/wcc-logo.png"}
    theirs = {"club": build.drop_cc(opp_club), "desig": opp_desig,
              "crest": match.get("opposition_crest")}
    return [ours, theirs] if we_first else [theirs, ours]


def side_label(side):
    return f"{side['club']} {side['desig']}".strip()


# ── title ─────────────────────────────────────────────────────────────────────

def make_title(match, team):
    """Spoiler-free: the fixture and the date. No score, no winner.

    No league or division — they were pushing the title past readable length, and
    both already appear on the thumbnail and in the description, where there is
    room for them. Degrades in steps rather than being cut mid-word, because
    YouTube truncates at 100 characters: the long date drops to a short one, then
    goes entirely. The fixture is never sacrificed — it is the only part that
    identifies the video.
    """
    ours, theirs = sides_of(match, team)
    fixture = f"{side_label(ours)} vs {side_label(theirs)}"
    long_date = build.fmt_match_date(match.get("match_date", ""))
    # "Saturday 22 August 2026" -> "22 Aug 2026"
    short_date = re.sub(r"^\w+ ", "", long_date)
    short_date = re.sub(r" (\w{3})\w* ", r" \1 ", short_date)

    for candidate in (f"{fixture} · {long_date}",
                      f"{fixture} · {short_date}",
                      fixture):
        if len(candidate) <= TITLE_MAX:
            return candidate
    return fixture[:TITLE_MAX]


# ── chapters ──────────────────────────────────────────────────────────────────

def chapter_label(slug, deck, match, team):
    """A slide slug turned into something a viewer would click.

    Returns None for a slide that shouldn't be a chapter at all.
    """
    tail = slug[len(deck):].lstrip("-") if slug.startswith(deck) else slug
    we_first = match.get("we_bat_first", True)
    ours, theirs = sides_of(match, team)

    if tail == "intro":
        return "Preview"
    if tail == "result":
        return "Result"
    if tail == "league":
        return "League table"
    m = re.match(r"^innings-(\d+)-(reel|batting|bowling)$", tail)
    if not m:
        return None
    idx, kind = int(m.group(1)) - 1, m.group(2)
    # Innings 1 is whoever batted first; the batting side flips for innings 2.
    batting = (ours if we_first else theirs) if idx == 0 else (theirs if we_first else ours)
    bowling = theirs if batting is ours else ours
    if kind == "reel":
        return f"{side_label(batting)} innings — highlights"
    if kind == "batting":
        return f"{side_label(batting)} batting"
    return f"{side_label(bowling)} bowling"


def hms(seconds):
    s = int(seconds)
    h, m, s = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def make_chapters(tl, deck, match, team):
    """One chapter per slide run, timed off the rendered timeline.

    YouTube only honours chapters when the first is at 00:00, there are at least
    three, and each runs 10s or more — so a run that would break those rules is
    merged into the one before it rather than silently disabling the whole list.
    """
    runs = []   # [start, duration, slug]
    at = 0.0
    for beat in tl["beats"]:
        slug = beat["atom"]["slide"]
        dur = float(beat["duration"])
        if runs and runs[-1][2] == slug:
            runs[-1][1] += dur
        else:
            runs.append([at, dur, slug])
        at += dur

    chapters = []
    for start, dur, slug in runs:
        label = chapter_label(slug, deck, match, team)
        if label is None or (chapters and dur < 10):
            continue          # too short to be a legal chapter — absorbed by the previous one
        chapters.append({"start": start, "label": label})
    if chapters:
        chapters[0]["start"] = 0.0   # the first chapter must be 00:00
    return chapters if len(chapters) >= 3 else []


# ── description ───────────────────────────────────────────────────────────────

def top_performers(match):
    """A few lines worth reading: our best bat and best bowl, then theirs."""
    lines = []

    def bat(rows, label):
        best = max((r for r in rows or [] if r.get("runs") is not None),
                   key=lambda r: r.get("runs") or 0, default=None)
        if best and (best.get("runs") or 0) > 0:
            balls = f" ({best['balls']})" if best.get("balls") else ""
            lines.append(f"{label} {best['name']} {best['runs']}{'*' if best.get('not_out') else ''}{balls}")

    def bowl(rows, label):
        best = max((r for r in rows or [] if r.get("wickets") is not None),
                   key=lambda r: (r.get("wickets") or 0, -(r.get("runs") or 0)), default=None)
        if best and (best.get("wickets") or 0) > 0:
            lines.append(f"{label} {best['name']} {best['wickets']}-{best['runs']}")

    bat(match.get("our_batting"), "Batting:")
    bowl(match.get("our_bowling"), "Bowling:")
    return lines


def make_description(match, team, chapters):
    ours, theirs = sides_of(match, team)
    comp = competition_line(match, team)
    date_long = build.fmt_match_date(match.get("match_date", ""))
    ground = match.get("ground_name") or ""
    where = "at " + ground if ground else ""

    out = [f"Highlights from {side_label(ours)} vs {side_label(theirs)}, "
           f"played {where} on {date_long}".replace("  ", " ").rstrip() + ".",
           f"Competition: {comp}." if comp else "", ""]

    if chapters:
        out.append("Chapters")
        out += [f"{hms(c['start'])} {c['label']}" for c in chapters]
        out.append("")

    # Result sits below the chapters on purpose: the title and thumbnail are
    # spoiler-free, and YouTube previews only the first couple of lines in a feed.
    we_first = match.get("we_bat_first", True)
    summary = build.result_summary(
        match.get("result"), match.get("our_total"), match.get("their_total"),
        we_first, build.OUR_CLUB, theirs["club"])
    scores = [(ours, match.get("our_total")), (theirs, match.get("their_total"))]
    if not we_first:
        scores.reverse()
    out.append("Result")
    if summary:
        out.append(summary)
    for side, total in scores:
        short = build._short_innings_total(total)
        if short:
            out.append(f"{side_label(side)} {short}")
    out.append("")

    perf = top_performers(match)
    if perf:
        out += ["Wendover top performers"] + perf + [""]

    out.append(f"{CLUB_URL}")
    return "\n".join(out).replace("\n\n\n", "\n\n").strip() + "\n"


def make_playlist(match):
    """One playlist per season, all teams — e.g. "Match Highlights — 2026"."""
    year = (match.get("match_date", "") or "").split("/")[-1]
    return f"Match Highlights — {year}" if year else "Match Highlights"


# ── thumbnail ─────────────────────────────────────────────────────────────────

@contextmanager
def _staged(html):
    """The thumbnail HTML, served from site/ so /assets/ crests and fonts resolve."""
    path = SITE / "_publish-thumbnail.html"
    path.write_text(html)
    try:
        yield path.name
    finally:
        path.unlink(missing_ok=True)


def render_thumbnail(match, team, out_path):
    """Shoot the thumbnail template at exactly 1280x720.

    Same approach as the compositor's stills — headless Chromium against a local
    server — but a fixed pixel viewport rather than the 1920x1080 wall frame.
    """
    import compose  # local import: only the thumbnail needs Playwright
    from playwright.sync_api import sync_playwright

    env = build.make_env()
    html = env.get_template("thumbnail.html").render(
        sides=sides_of(match, team),
        our_name=side_label(sides_of(match, team)[0]),
        opp_name=side_label(sides_of(match, team)[1]),
        competition=competition_line(match, team),
        date_long=build.fmt_match_date(match.get("match_date", "")),
        ground=match.get("ground_name") or "",
    )
    with _staged(html) as name, compose.serve(SITE) as base_url:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_context(
                viewport={"width": THUMB_W, "height": THUMB_H},
                device_scale_factor=1).new_page()
            page.goto(f"{base_url}/{name}", wait_until="load")
            try:
                page.evaluate("document.fonts.ready")
            except Exception:
                pass
            page.wait_for_timeout(300)
            page.screenshot(path=str(out_path))
            browser.close()
    return out_path


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("deck", help="deck slug under site/slideshow/ (e.g. last-match-1st-xi)")
    ap.add_argument("--team", help="team id, if it isn't derivable from the deck slug")
    ap.add_argument("-o", "--out", help="output dir (default: build/publish/<deck>/)")
    ap.add_argument("--no-thumbnail", action="store_true",
                    help="skip the thumbnail (avoids needing Playwright)")
    args = ap.parse_args()

    team_id = args.team or team_id_from_deck(args.deck)
    if not team_id:
        ap.error(f"can't derive a team from '{args.deck}' — pass --team")
    match, team = load_match(team_id)

    tl = timeline_mod.derive_timeline(timeline_mod.load_deck(args.deck), slug=args.deck)
    chapters = make_chapters(tl, args.deck, match, team)

    title = make_title(match, team)
    description = make_description(match, team, chapters)
    playlist = make_playlist(match)

    out = Path(args.out) if args.out else OUT_ROOT / args.deck
    out.mkdir(parents=True, exist_ok=True)
    (out / "title.txt").write_text(title + "\n")
    (out / "description.txt").write_text(description)
    (out / "publish.json").write_text(json.dumps({
        "deck": args.deck,
        "match_id": match.get("match_id"),
        "title": title,
        "description": description,
        "playlist": playlist,
        "tags": ["cricket", "Wendover Cricket Club", team.get("name", ""),
                 competition_line(match, team)],
        "category": "Sports",
        "privacy": "public",
        "recording_date": build._iso_from_dmy(match.get("match_date", "")),
        "chapters": chapters,
    }, indent=2) + "\n")

    print(f"  {out}/title.txt")
    print(f"  {out}/description.txt")
    print(f"  {out}/publish.json")
    if not args.no_thumbnail:
        render_thumbnail(match, team, out / "thumbnail.png")
        print(f"  {out}/thumbnail.png  ({THUMB_W}x{THUMB_H})")

    print(f"\nTitle    {title}  ({len(title)}/{TITLE_MAX} chars)")
    print(f"Playlist {playlist}")
    print(f"Chapters {len(chapters)}")
    if not chapters:
        print("  ! no chapters — YouTube needs at least 3, each 10s or longer")


if __name__ == "__main__":
    main()
