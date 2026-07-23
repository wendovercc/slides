#!/usr/bin/env python3
"""Shared merge + select for curated ball events.

Merges a match's raw fetched events (``content/data/fetched/matches/{pc_id}.json``)
with its committed curation overlay (``content/data/matches/{pc_id}.curation.json``),
applying the same semantics as the ``/curate/`` page's in-browser merge. This is the
single Python source of truth for turning curated clips into slide content — consumed
by ``build.py`` (reel generation) and by ``fetch_videos.py`` / ``sync_videos.py``
(curation-driven R2 sync).

The overlay stores only what differs from the fetched defaults, keyed by clip id:

    { "start": N, "end": N, "narrative": "base caption",
      "match":   {"include": true},
      "players": { "<Full Name>": ["batter", "bowler", "fielder", "other"] },
      "tags":    ["diving catch", "last ball"] }

`/curate` is now scoped to match highlights only: a single ``match`` include per clip
(no reordering — the reel is newest-first). The ``players`` map records the role(s) each
Wendover player played in the clip; roles are auto-derived at fetch time (batter / bowler
/ fielder) and the overlay stores only *corrections* — a name → role-list override, an
empty list to drop an auto-tagged player, or a hand-added name (``other`` is manual-only).
These role tags carry no weight in the match reel; they exist to power the later
cross-match player / role / team filtering.

``load_merged`` applies that overlay onto the raw events; ``select`` queries the merged
list for one context (match / players / tags), newest-first, capped at N.
"""

import json
from pathlib import Path

ROOT = Path(__file__).parent.parent
FETCHED_MATCHES = ROOT / "content" / "data" / "fetched" / "matches"
CURATION_DIR = ROOT / "content" / "data" / "matches"
CONFIG_PATH = ROOT / "content" / "config.json"

# One-per-clip include contexts. `players` (role tags) and `tags` are handled
# separately because they fan out per clip. `match` is the sole reel context now.
CLIP_CONTEXTS = ("match",)
# The roles a Wendover player can be auto-tagged with on a clip; `other` is a
# manual-only bucket added in curation, never derived.
PLAYER_ROLES = ("batter", "bowler", "fielder", "other")


def _load_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def card_pad_defaults(*, config_path=CONFIG_PATH):
    """Default pad seconds per card type, from the central `card_types` config.

    A card overlay is drawn over lead-in (`pre`) / lead-out (`post`) footage; its
    ``dwell`` is the default number of seconds that footage runs, i.e. how far the
    played clip is widened beyond the action point. This is the single source of
    truth the curate UI and this module both read (the curation overlay stores only
    overrides). Returns ``{card_type: dwell}``.
    """
    config = _load_json(Path(config_path)) or {}
    return {c["key"]: c.get("dwell", 0)
            for c in (config.get("card_types") or []) if c.get("key")}


def load_merged(pc_id, *, fetched_dir=FETCHED_MATCHES, curation_dir=CURATION_DIR):
    """Return the match's fetched data with its committed overlay applied, or None.

    The returned dict is the raw match metadata (date/team/youtube_url/…) with an
    ``events`` list in which each clip carries its effective action trim
    (``start``/``end``), the pad-widened played bounds (``clip_start``/``clip_end``),
    base narrative, per-context include, per-player roles, free tags and card refs.
    """
    raw = _load_json(Path(fetched_dir) / f"{pc_id}.json")
    if raw is None:
        return None
    overlay = _load_json(Path(curation_dir) / f"{pc_id}.curation.json") or {}
    pad_defaults = card_pad_defaults()

    # Frogbox drift: a clip's `offset_adjustment` is a one-step correction that
    # carries forward. The effective offset for a clip is the running sum of every
    # adjustment up to and including it, in real-world (chronological) order — the
    # same accumulation the curate UI does (`effOffset`). Stored trims are absolute
    # (drift-corrected as you set them), so the offset only shifts fetched defaults.
    chrono = sorted(raw.get("events", []),
                    key=lambda e: (e.get("dt_unix") or 0, e.get("over") or 0, e.get("ball") or 0))
    eff_offset, running = {}, 0
    for e in chrono:
        adj = (overlay.get(str(e.get("id"))) or {}).get("offset_adjustment")
        if adj:
            running += adj
        eff_offset[str(e.get("id"))] = running

    merged_events = []
    for ev in raw.get("events", []):
        clip_id = str(ev.get("id"))
        o = overlay.get(clip_id) or {}
        offset = eff_offset.get(clip_id, 0)

        # Effective action trim (override ?? fetched default shifted by drift) and
        # base narrative (override ?? fetched default ?? title).
        start = o["start"] if o.get("start") is not None else _shift(ev.get("start"), offset)
        end = o["end"] if o.get("end") is not None else _shift(ev.get("end"), offset)
        base_narrative = o.get("narrative")
        if base_narrative is None:
            base_narrative = ev.get("narrative") or ev.get("title") or ""

        # Card pads widen the *played* clip beyond the action so a card overlay has
        # lead-in / lead-out footage to sit over. A pad exists only while a card is
        # present at that position; its length is the overlay override ?? the card
        # type's config dwell. (Matches curate.js effPre/effPost/shownStart/End.)
        cards = list(o.get("cards") or [])
        pre_pad = _pad(o, cards, "pre", pad_defaults)
        post_pad = _pad(o, cards, "post", pad_defaults)
        clip_start = _shift(start, -pre_pad)
        clip_end = _shift(end, post_pad)

        contexts = {}
        for ctx in CLIP_CONTEXTS:
            c = o.get(ctx)
            contexts[ctx] = {"include": bool(c and c.get("include"))}

        # Players: fetched our_players carry auto-derived roles; the overlay
        # stores corrections as name → role-list (empty list = drop the auto
        # tag, a new name = hand-added). Effective roles = override ?? default.
        players = {}
        for entry in ev.get("our_players", []) or []:
            # Tolerate the legacy flat-string shape (name only, no roles).
            name = entry if isinstance(entry, str) else entry.get("name")
            roles = [] if isinstance(entry, str) else list(entry.get("roles") or [])
            if name:
                players[name] = {"roles": roles}
        for name, rec in (o.get("players") or {}).items():
            roles = list(rec or [])
            if roles:
                players[name] = {"roles": roles}
            else:
                players.pop(name, None)  # explicit empty override drops the player
        players = {n: v for n, v in players.items() if v["roles"]}

        merged_events.append({
            **ev,
            "start": start,
            "end": end,
            "clip_start": clip_start,
            "clip_end": clip_end,
            "narrative": base_narrative,
            "contexts": contexts,
            "players": players,
            "tags": list(o.get("tags") or []),
            "cards": cards,
        })

    return {**raw, "events": merged_events}


def _shift(value, delta):
    """Shift a (possibly None) second offset by delta, staying None if unset."""
    return value if value is None else value + delta


def _pad(overlay_entry, cards, at, pad_defaults):
    """Effective pad seconds for one side of a clip (0 when no card sits there).

    Mirrors curate.js: with no card at `at` the pad is 0 (any stale stored value is
    ignored); otherwise it is the overlay override ?? the card type's config dwell.
    """
    card = next((c for c in cards if c.get("at") == at), None)
    if not card:
        return 0
    override = overlay_entry.get(at)
    if override is not None:
        return override
    return pad_defaults.get(card.get("type"), 0)


def _newest_first(events):
    # dt_unix is real-world clip time; over/ball break ties within a match.
    return sorted(
        events,
        key=lambda e: (e.get("dt_unix") or 0, e.get("over") or 0, e.get("ball") or 0),
        reverse=True,
    )


def select(merged, context, *, player=None, role=None, tag=None, innings=None, cap=None):
    """Ordered clip list for one context: newest-first, capped at N.

    ``context`` is one of ``match`` / ``players`` / ``tags``. ``players`` needs
    ``player`` (full name) and optionally ``role`` (batter / bowler / fielder /
    other; ``None`` = any role); ``tags`` needs ``tag``. ``innings`` filters to a
    single innings id.

    Each returned clip is ``{url, start, end, body, innings, id, action_start,
    action_end, cards}``. ``start``/``end`` are the *played* clip bounds — the
    action widened by any card pads — so they are what gets downloaded to R2 and
    what plays on the wall; ``action_start``/``action_end`` keep the un-padded
    moment (for the future card-overlay timing). ``body`` = base narrative ?? title.
    """
    events = merged.get("events", []) if merged else []
    if innings is not None:
        events = [e for e in events if e.get("innings") == innings]

    def included(e):
        if context in CLIP_CONTEXTS:
            return e["contexts"][context]["include"]
        if context == "players":
            rec = e["players"].get(player)
            if not rec:
                return False
            return (role in rec["roles"]) if role else bool(rec["roles"])
        if context == "tags":
            return tag in e["tags"]
        raise ValueError(f"unknown context: {context}")

    chosen = [e for e in events if included(e)]
    ordered = sorted(
        chosen,
        key=lambda e: (e.get("dt_unix") or 0, e.get("over") or 0, e.get("ball") or 0),
        reverse=True,
    )
    items = [{
        "url": e.get("youtube_url"),
        "start": e.get("clip_start"),
        "end": e.get("clip_end"),
        "action_start": e.get("start"),
        "action_end": e.get("end"),
        "body": e["narrative"] or e.get("title") or "",
        "innings": e.get("innings"),
        "id": e.get("id"),
        "type": e.get("type"),
        "cards": e.get("cards") or [],
    } for e in ordered]
    return items[:cap] if cap else items


# ── Card resolution ─────────────────────────────────────────────────────────
# A curation card carries only intent — {at, type, player}. The figures are
# resolved here at build time from the same season stats / scorecard the slides
# use, mirroring how `select` turns a clip into rendered content. The result is a
# small template-ready dict per card (name + optional headline + labelled stats),
# so wording/layout stay in `video.html`.

# Scorecard `how_out` codes → readable dismissal text for the summary card.
_HOW_OUT = {
    "b": "bowled", "ct": "caught", "lbw": "lbw", "st": "stumped",
    "run out": "run out", "hw": "hit wicket", "ro": "run out",
}


def _name_key(name):
    """(last, first-initial) from a name — tolerant of abbreviated first names.

    Matches the curation card's subject ("S Methari" / "Harry Godden") against a
    stats/scorecard row's full name ("Solomon Methari"). Same key shape as
    fetch_ball_events._name_key.
    """
    parts = (name or "").split()
    if len(parts) < 2:
        return None
    return (parts[-1].lower(), parts[0][:1].lower())


def _trim_num(value, digits=1):
    """Format a number without trailing .0 (39.88 -> '39.9', 122.0 -> '122')."""
    if value is None:
        return None
    s = f"{float(value):.{digits}f}".rstrip("0").rstrip(".")
    return s or "0"


def _resolve_new_batsman(card, scorecard, player_stats, team_id):
    """Pre-match batting form for a Wendover batter, matching the intro slide.

    The figures mirror ``build.team_preview_performers``: the player's stats for
    THIS TEAM across all competitions (``by_team[team_id].all`` — the same block
    ``get_leaderboard_block(p, team_id, None)`` returns), with this match's own
    contribution *subtracted* so the card reads as the form they brought into the
    game (not the season-plus-this-innings total). Only runs / avg / SR are shown —
    max-style figures (HS, 50s) can't be recovered pre-match from aggregates, so the
    intro omits them and so do we. Returns None (card dropped) when the batter has no
    block for this team or no prior innings once this match is removed.
    """
    key = _name_key(card.get("player"))
    if not key or not player_stats:
        return None
    players = player_stats.get("players") or {}
    rows = players.values() if isinstance(players, dict) else players
    rec = next((p for p in rows if _name_key(p.get("name")) == key), None)
    if not rec:
        return None
    block = (((rec.get("stats") or {}).get("by_team") or {}).get(team_id or "") or {}).get("all")
    bat = (block or {}).get("batting")
    if not bat or not bat.get("innings"):
        return None

    # Subtract this match's innings for the player (found by play-cricket id, as the
    # intro does), so the line is their form coming into the game.
    pid = str(rec.get("id"))
    mb = next((r for r in (scorecard.get("our_batting") or []) if scorecard
               and str(r.get("id")) == pid), None)
    runs = bat["runs"] - (int(mb.get("runs") or 0) if mb else 0)
    inns = bat["innings"] - (1 if mb else 0)
    nos = bat["not_outs"] - (1 if mb and mb.get("not_out") else 0)
    balls = bat["balls"] - (int(mb.get("balls") or 0) if mb else 0)
    if inns <= 0 or runs < 0:
        return None

    outs = inns - nos
    stats = [{"v": str(runs), "l": "runs"}]
    if outs > 0:
        stats.append({"v": f"{runs / outs:.1f}", "l": "avg"})
    if balls > 0:
        stats.append({"v": f"{runs / balls * 100:.0f}", "l": "SR"})
    # 50s / 100s are counts, so (unlike HS, a max) they subtract cleanly: drop this
    # match's innings if it was a fifty / hundred. Shown only when non-zero.
    match_runs = int(mb.get("runs") or 0) if mb else None
    fifties = bat.get("fifties", 0) - (1 if match_runs is not None and 50 <= match_runs < 100 else 0)
    hundreds = bat.get("hundreds", 0) - (1 if match_runs is not None and match_runs >= 100 else 0)
    if fifties > 0:
        stats.append({"v": str(fifties), "l": "50s"})
    if hundreds > 0:
        stats.append({"v": str(hundreds), "l": "100s"})
    # The card carries the kind badge (not the ball's outcome). As a pre card it's
    # spoiler-free — the ball's own caption/outcome only surface once the action starts.
    return {"name": rec.get("name"), "badge": "New batsman",
            "sublabel": "This season", "stats": stats}


def _resolve_dismissal(card, scorecard, player_stats, team_id):
    """Innings-summary line for a dismissed batter, from the match scorecard.

    Searches both batting cards (ours + opposition) by name; returns None when the
    subject isn't found (e.g. the scorecard has rolled off) so the card is dropped.
    """
    key = _name_key(card.get("player"))
    if not key or not scorecard:
        return None
    rows = (scorecard.get("our_batting") or []) + (scorecard.get("their_batting") or [])
    row = next((r for r in rows if _name_key(r.get("name")) == key), None)
    if not row:
        return None
    runs, balls = row.get("runs"), row.get("balls")
    if runs is None:
        return None
    # Runs stand alone as the gold headline; the ball count drops into the stats
    # row alongside the other innings figures.
    headline = str(runs)
    sr = _trim_num(runs / balls * 100, 0) if balls else None
    stats = []
    if balls:
        stats.append({"v": str(balls), "l": "balls"})
    stats += [
        {"v": str(row.get("fours", 0)), "l": "fours"},
        {"v": str(row.get("sixes", 0)), "l": "sixes"},
    ]
    if sr is not None:
        stats.append({"v": sr, "l": "SR"})
    how = (row.get("how_out") or "").strip().lower()
    return {
        "name": row.get("name"), "badge": "Batsman innings",
        "headline": headline,
        "sublabel": _HOW_OUT.get(how, how) if not row.get("not_out") else "not out",
        "stats": stats,
    }


_CARD_RESOLVERS = {
    "new_batsman": _resolve_new_batsman,
    "dismissal_summary": _resolve_dismissal,
}


def resolve_cards(clip, *, scorecard=None, player_stats=None, team_id=None):
    """Turn a clip's card refs into rendered content, dropping the unresolvable.

    ``clip`` is a `select()` item (carries ``cards`` + played/action bounds).
    ``scorecard`` is this match's built scorecard (for the innings summary + the
    new-batsman match subtraction); ``player_stats`` is player_stats_this_season and
    ``team_id`` the reel's team slug (for the new-batsman season line). Returns a list
    of ``{at, type, name, badge?, headline?, sublabel?, stats:[{v,l}]}`` in the
    clip's card order; a card whose subject can't be resolved is omitted (a warning is
    the caller's to log). Unknown card types are skipped.
    """
    out = []
    for card in clip.get("cards") or []:
        resolver = _CARD_RESOLVERS.get(card.get("type"))
        if not resolver:
            continue
        content = resolver(card, scorecard, player_stats, team_id)
        if content:
            out.append({"at": card.get("at"), "type": card.get("type"), **content})
    return out


def collect_curated_clips(*, fetched_dir=FETCHED_MATCHES, curation_dir=CURATION_DIR):
    """Every curated match-reel clip across all fetched matches, de-duplicated.

    Discovery source for the R2 sync: each clip is ``{url, start, end}`` at its
    *played* (pad-widened, drift-corrected) bounds, so the uploaded file already has
    room for a card overlay. De-duplicated on ``(url, start, end)`` — the same key
    the video fingerprint hashes — so a clip shared across contexts uploads once.
    """
    seen, clips = set(), []
    files = sorted(Path(fetched_dir).glob("*.json")) if Path(fetched_dir).exists() else []
    for f in files:
        merged = load_merged(f.stem, fetched_dir=fetched_dir, curation_dir=curation_dir)
        if not merged:
            continue
        for c in select(merged, "match"):
            url = c.get("url")
            if not url:
                continue
            key = (url, c.get("start"), c.get("end"))
            if key not in seen:
                seen.add(key)
                clips.append({"url": url, "start": c.get("start"), "end": c.get("end")})
    return clips


if __name__ == "__main__":
    # Smoke test: print selection sizes for every fetched+curated match.
    import sys

    ids = sys.argv[1:] or [p.stem for p in sorted(FETCHED_MATCHES.glob("*.json"))]
    for pc_id in ids:
        merged = load_merged(pc_id)
        if not merged:
            print(f"{pc_id}: no fetched data")
            continue
        n = len(merged["events"])
        counts = {ctx: len(select(merged, ctx)) for ctx in CLIP_CONTEXTS}
        innings = sorted({e.get("innings") for e in merged["events"] if e.get("innings")})
        print(f"{pc_id}: {n} events | {counts} | innings={innings}")
        for inn in innings:
            m = len(select(merged, "match", innings=inn))
            if m:
                print(f"    innings {inn}: {m} match clips")
