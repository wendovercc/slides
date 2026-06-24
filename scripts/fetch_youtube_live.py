#!/usr/bin/env python3
"""Fetch the club's YouTube live + upcoming streams at build time.

Uses the YouTube Data API v3 with YOUTUBE_API_KEY (a CI secret). The channel is
taken from the `homepage_cards` entry of type "youtube" in content/config.json
(its `handle` or `channel_id`). Writes content/data/fetched/youtube_live.json:

    { fetched_at, channel_id, channel_url, live: [...], upcoming: [...] }

Each item: { title, video_id, url, scheduled_start?, actual_start? }.
Upcoming is sorted by scheduled start ascending. Exits cleanly (0) if the API
key or channel is absent so the build still succeeds — the home page just shows
the stream card without enrichment.
"""

import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent.parent
CONTENT = ROOT / "content"
OUT = CONTENT / "data" / "fetched" / "youtube_live.json"
API = "https://www.googleapis.com/youtube/v3"


def load_dotenv():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def get_json(path, **params):
    params["key"] = os.environ["YOUTUBE_API_KEY"]
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode())


def youtube_card():
    config = json.loads((CONTENT / "config.json").read_text())
    for c in config.get("homepage_cards", []):
        if c.get("type") == "youtube":
            return c
    return None


def resolve_channel_id(card):
    if card.get("channel_id"):
        return card["channel_id"]
    handle = (card.get("handle") or "").lstrip("@")
    if not handle:
        return None
    data = get_json("channels", part="id", forHandle=handle)
    items = data.get("items", [])
    return items[0]["id"] if items else None


def video_details(video_ids):
    """Map video_id -> liveStreamingDetails + snippet for the given ids."""
    if not video_ids:
        return {}
    data = get_json("videos", part="snippet,liveStreamingDetails", id=",".join(video_ids))
    out = {}
    for v in data.get("items", []):
        out[v["id"]] = {
            "title": v["snippet"]["title"],
            "live": v.get("liveStreamingDetails", {}),
        }
    return out


def collect(channel_id, event_type):
    """Search the channel for live/upcoming broadcasts, enriched with timing."""
    search = get_json(
        "search", part="snippet", channelId=channel_id,
        eventType=event_type, type="video", maxResults=10,
    )
    ids = [it["id"]["videoId"] for it in search.get("items", []) if it["id"].get("videoId")]
    details = video_details(ids)
    items = []
    for vid in ids:
        d = details.get(vid, {})
        lsd = d.get("live", {})
        items.append({
            "title": d.get("title", ""),
            "video_id": vid,
            "url": f"https://www.youtube.com/watch?v={vid}",
            "scheduled_start": lsd.get("scheduledStartTime"),
            "actual_start": lsd.get("actualStartTime"),
        })
    return items


def main():
    load_dotenv()
    if not os.environ.get("YOUTUBE_API_KEY"):
        print("  YOUTUBE_API_KEY not set — skipping YouTube fetch")
        return 0

    card = youtube_card()
    if not card:
        print("  No youtube homepage card in config — skipping")
        return 0

    try:
        channel_id = resolve_channel_id(card)
        if not channel_id:
            print("  Could not resolve YouTube channel — skipping")
            return 0

        live = collect(channel_id, "live")
        upcoming = collect(channel_id, "upcoming")
        upcoming.sort(key=lambda x: x.get("scheduled_start") or "")

        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps({
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "channel_id": channel_id,
            "channel_url": card.get("url", ""),
            "live": live,
            "upcoming": upcoming,
        }, indent=2))
        print(f"  youtube_live.json — {len(live)} live, {len(upcoming)} upcoming")
        return 0
    except Exception as e:
        # Never fail the build over an optional enrichment feed.
        print(f"  YouTube fetch failed ({e}) — skipping")
        return 0


if __name__ == "__main__":
    sys.exit(main())
