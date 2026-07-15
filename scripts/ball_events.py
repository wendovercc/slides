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
      "match":   {"include": true, "pin": 1-5},
      "team":    {"include": true, "pin": ...},
      "novelty": {"include": true, "pin": ...},
      "players": { "<Full Name>": {"include": true, "pin": ..., "narrative": "..."} },
      "tags":    ["diving catch", "last ball"] }

``load_merged`` applies that overlay onto the raw events; ``select`` queries the merged
list for one context (match / team / novelty / players / tags), newest-first with pins
1-5 holding fixed positions, capped at N.
"""

import json
from pathlib import Path

ROOT = Path(__file__).parent.parent
FETCHED_MATCHES = ROOT / "content" / "data" / "fetched" / "matches"
CURATION_DIR = ROOT / "content" / "data" / "matches"

# One-per-clip contexts (each an include + optional pin). `players` and `tags`
# are handled separately because they fan out per clip.
CLIP_CONTEXTS = ("match", "team", "novelty")


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
            contexts[ctx] = {
                "include": bool(c and c.get("include")),
                "pin": c.get("pin") if c else None,
            }

        # Players: fetched our_players default to not-included; the overlay adds
        # inclusion, pins, per-player narratives and any hand-added names.
        players = {}
        for name in ev.get("our_players", []) or []:
            players[name] = {"include": False, "pin": None, "narrative": None}
        for name, rec in (o.get("players") or {}).items():
            entry = players.setdefault(name, {"include": False, "pin": None, "narrative": None})
            entry["include"] = bool(rec.get("include"))
            entry["pin"] = rec.get("pin")
            if rec.get("narrative") is not None:
                entry["narrative"] = rec["narrative"]

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


def _apply_pins(unpinned_newest_first, pinned):
    """Interleave pinned clips (1-indexed target positions) into the newest-first list.

    A clip pinned to position *p* holds slot *p*; everything else fills the gaps in
    newest-first order. Pins that can't be honoured (position beyond the clip count)
    settle at the end. Duplicate pins: last writer wins.
    """
    out = []
    queue = list(unpinned_newest_first)
    pos = 1
    max_pin = max(pinned) if pinned else 0
    while queue or pos <= max_pin:
        if pos in pinned:
            out.append(pinned[pos])
        elif queue:
            out.append(queue.pop(0))
        pos += 1
    return out


def select(merged, context, *, player=None, tag=None, innings=None, cap=None):
    """Ordered clip list for one context: newest-first, pins fixed, capped at N.

    ``context`` is one of ``match`` / ``team`` / ``novelty`` / ``players`` / ``tags``.
    ``players`` needs ``player`` (full name); ``tags`` needs ``tag``. ``innings`` filters
    to a single innings id. Each returned clip is ``{url, start, end, body, innings, id}``
    where ``body`` = per-player narrative ?? base narrative ?? event title.
    """
    events = merged.get("events", []) if merged else []
    if innings is not None:
        events = [e for e in events if e.get("innings") == innings]

    def included(e):
        if context in CLIP_CONTEXTS:
            c = e["contexts"][context]
            return c["include"], c["pin"], e["narrative"]
        if context == "players":
            rec = e["players"].get(player)
            if not rec:
                return False, None, e["narrative"]
            body = rec["narrative"] if rec.get("narrative") else e["narrative"]
            return rec["include"], rec["pin"], body
        if context == "tags":
            return (tag in e["tags"]), None, e["narrative"]
        raise ValueError(f"unknown context: {context}")

    chosen = []
    for e in events:
        inc, pin, body = included(e)
        if inc:
            chosen.append((e, pin, body or e.get("title") or ""))

    pinned = {}
    unpinned = []
    for e, pin, body in chosen:
        item = {
            "url": e.get("youtube_url"),
            "start": e.get("start"),
            "end": e.get("end"),
            "body": body,
            "innings": e.get("innings"),
            "id": e.get("id"),
        }
        if isinstance(pin, int) and 1 <= pin <= 5:
            pinned[pin] = item
        else:
            unpinned.append((e, item))

    ordered_unpinned = [item for _, item in sorted(
        [(e, item) for e, item in unpinned],
        key=lambda pair: (pair[0].get("dt_unix") or 0, pair[0].get("over") or 0, pair[0].get("ball") or 0),
        reverse=True,
    )]
    ordered = _apply_pins(ordered_unpinned, pinned)
    return ordered[:cap] if cap else ordered


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
