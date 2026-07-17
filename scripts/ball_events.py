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
