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


def load_merged(pc_id, *, fetched_dir=FETCHED_MATCHES, curation_dir=CURATION_DIR):
    """Return the match's fetched data with its committed overlay applied, or None.

    The returned dict is the raw match metadata (date/team/youtube_url/…) with an
    ``events`` list in which each clip carries its effective trim, base narrative,
    per-context include/pin, per-player include/pin/narrative and free tags.
    """
    raw = _load_json(Path(fetched_dir) / f"{pc_id}.json")
    if raw is None:
        return None
    overlay = _load_json(Path(curation_dir) / f"{pc_id}.curation.json") or {}

    merged_events = []
    for ev in raw.get("events", []):
        clip_id = str(ev.get("id"))
        o = overlay.get(clip_id) or {}

        # Effective trim + base narrative (override ?? fetched default ?? title).
        start = o["start"] if o.get("start") is not None else ev.get("start")
        end = o["end"] if o.get("end") is not None else ev.get("end")
        base_narrative = o.get("narrative")
        if base_narrative is None:
            base_narrative = ev.get("narrative") or ev.get("title") or ""

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
            "narrative": base_narrative,
            "contexts": contexts,
            "players": players,
            "tags": list(o.get("tags") or []),
        })

    return {**raw, "events": merged_events}


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
    single innings id. Each returned clip is ``{url, start, end, body, innings, id}``
    where ``body`` = base narrative ?? event title.
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
        "start": e.get("start"),
        "end": e.get("end"),
        "body": e["narrative"] or e.get("title") or "",
        "innings": e.get("innings"),
        "id": e.get("id"),
    } for e in ordered]
    return items[:cap] if cap else items


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
