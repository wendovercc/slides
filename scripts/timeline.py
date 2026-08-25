#!/usr/bin/env python3
"""Derive a timeline from a built deck — Phase 1 of docs/narrated-decks.md.

A *timeline* is the ordered list of beats a compositor renders: one beat per
atom, with a duration and (for clips) the media segment behind it. There are two
ways to produce one — record a narrator playing the deck, or derive it from the
deck's own durations. This is the derived half, and it needs no editor, no
microphone and no recording session: every duration it wants was already
computed at build time and published in each slide's `_atoms` list.

    python scripts/timeline.py last-match-1st-xi -o timeline.json
    python scripts/timeline.py --data site/slideshow/last-match-1st-xi/data.json

`source: "derived"` timelines have exact durations, so the audio-is-master rule
that governs recorded ones (truncate/hold to fit the take) never engages here.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"

# The R2 clips carry real crowd/bat-on-ball audio, which serves a silent render
# far better than actual silence. Normalisation is the compositor's job.
DEFAULT_CLIP_AUDIO = "keep"


def load_deck(slug=None, data_path=None):
    """The built deck document (`data.json`), by slug or explicit path."""
    path = Path(data_path) if data_path else SITE / "slideshow" / slug / "data.json"
    if not path.exists():
        raise SystemExit(f"no built deck at {path} — run scripts/build.py first")
    return json.loads(path.read_text())


def derive_timeline(deck, slug=None, clip_audio=DEFAULT_CLIP_AUDIO, warn=None):
    """Walk a deck's slides, flatten their atoms, and return a timeline document.

    Slides are expected to publish `_atoms` (see `slide_atoms` in build.py). Two
    kinds don't, and they're handled rather than crashed on:

    - a live-match slide, whose panels only exist once a feed has produced them.
      It's day-bound and never narrated, so it's dropped from the timeline.
    - anything else missing a list, e.g. a deck built before this existed. It
      falls back to a single beat of the slide's whole duration, which is at
      least renderable.
    """
    warn = warn or (lambda msg: print(f"  ! {msg}", file=sys.stderr))
    beats = []
    for slide in deck.get("slides", []):
        slug_ = slide.get("slug")
        atoms = slide.get("_atoms")
        if atoms is None and slide.get("_live"):
            warn(f"{slug_}: live slide — panels are feed-driven, dropped from the timeline")
            continue
        if atoms is None:
            warn(f"{slug_}: no atom list — falling back to one beat of the whole slide")
            atoms = [{"panel": 0, "duration": slide.get("duration", 0)}]
        for atom in atoms:
            key = {"slide": slug_, "panel": atom.get("panel", 0)}
            if atom.get("card"):
                key["card"] = atom["card"]
            beat = {"atom": key, "duration": atom.get("duration", 0)}
            if atom.get("media"):
                beat["media"] = atom["media"]
            beats.append(beat)

    return {
        "deck": slug or deck.get("title"),
        "build_version": deck.get("build_version"),
        "source": "derived",
        "clip_audio": clip_audio,
        "beats": beats,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("deck", nargs="?", help="deck slug under site/slideshow/")
    ap.add_argument("--data", help="path to a data.json, instead of a slug")
    ap.add_argument("-o", "--out", help="write here (default: stdout)")
    ap.add_argument("--clip-audio", choices=("keep", "duck", "mute"),
                    default=DEFAULT_CLIP_AUDIO,
                    help=f"how the compositor treats clip audio (default: {DEFAULT_CLIP_AUDIO})")
    args = ap.parse_args()
    if not args.deck and not args.data:
        ap.error("give a deck slug or --data")

    deck = load_deck(args.deck, args.data)
    timeline = derive_timeline(deck, slug=args.deck, clip_audio=args.clip_audio)

    total = sum(b["duration"] for b in timeline["beats"])
    n_clips = sum(1 for b in timeline["beats"] if b.get("media"))
    n_cards = sum(1 for b in timeline["beats"] if b["atom"].get("card"))
    print(f"  {len(timeline['beats'])} beat(s), {n_clips} media, {n_cards} card, "
          f"{total:.0f}s total", file=sys.stderr)

    text = json.dumps(timeline, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n")
        print(f"  → {args.out}", file=sys.stderr)
    else:
        print(text)


if __name__ == "__main__":
    main()
