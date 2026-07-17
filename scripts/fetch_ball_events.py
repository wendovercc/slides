#!/usr/bin/env python3
"""Fetch Frogbox ball-event clip metadata from the Results Vault API (build step).

Runs in CI after fetch_fixtures.py. Auto-detects recently-played matches that
have a Frogbox live stream, pulls every auto-generated scoring-event clip
(wickets, fours, sixes, ...) with its cricket metadata, estimates a default
YouTube start/end for each, and writes the raw events to
content/data/fetched/matches/{pc_match_id}.json (gitignored, rebuilt every build).

No video is downloaded here — clips are reviewed against the YouTube stream on
the curation page. Curation (adjusting start/end, rating, categorising,
include/exclude) lives in a separate committed overlay,
content/data/matches/{pc_match_id}.curation.json, keyed by clip id and produced
by that page. The build merges the overlay over these raw events, so refetching
never clobbers human edits; the downstream YouTube→R2 pipeline and analysis
slides consume the merged result.

Match discovery (no --match-id given):
    - every match with a committed curation overlay (so curated matches keep
      getting fresh raw metadata), plus
    - recent matches (default last DISCOVERY_DAYS days) read from
      content/data/fetched/fixtures.json that turn out to have a stream.
    Pass --match-id to (re)fetch a single match by hand.

Auth: the X-IAS-API-REQUEST token is generated locally (see generate_token) —
    base64(3DES-ECB(unix time - 60s)) keyed on the shared secret published in the
    Match Centre JS bundle. No credentials required; set RESULTS_VAULT_TOKEN in
    .env only to override with a hand-captured token. PLAY_CRICKET_API_TOKEN is
    optional — if set, the Play Cricket scorecard is read to attribute fielders
    to dismissals (catches/stumpings/run-outs), which Frogbox's data omits.

Always exits 0 — a match that can't be fetched is skipped, never failing the build.
"""

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parent.parent
CONTENT = ROOT / "content"
# Raw events: gitignored (under data/fetched), regenerated every build.
FETCHED_DIR = CONTENT / "data" / "fetched" / "matches"
# Curation overlays: committed, one {pc_id}.curation.json per curated match.
CURATION_DIR = CONTENT / "data" / "matches"
FIXTURES_PATH = CONTENT / "data" / "fetched" / "fixtures.json"
ROSTER_PATH = CONTENT / "data" / "fetched" / "player_stats_this_season.json"

# Results Vault API (public identifiers, lifted from the Match Centre JS bundle).
RV_BASE = "https://api.resultsvault.co.uk/rv"
ENTITY_ID = "130000"
API_ID = "1003"
SPORT_ID = "1"
# Play Cricket scorecard — read (with PLAY_CRICKET_API_TOKEN, optional) to recover
# fielders for dismissals, which Frogbox's clip metadata doesn't include.
PC_API_BASE = "http://play-cricket.com/api/v2"
# apiSharedSecret from the Match Centre bundle; used verbatim (24 ASCII bytes →
# Triple-DES) to sign the X-IAS-API-REQUEST token. See generate_token().
RV_SHARED_SECRET = b"5BD4A72CE1934BA5A629CD98"

# Our club, matched as a case-insensitive substring of the RV team name so it
# survives "Wendover CC", "Wendover CC 1st XI", etc.
CLUB = "wendover"

# match_event_type_id -> our event `type` label.
EVENT_TYPES = {
    1001: "wicket",
    1002: "four",
    1003: "six",
    1004: "other",
    1005: "other",
}

# Default YouTube-clip roll around the event moment (seconds). The Frogbox event
# timestamp marks the delivery; we grab a little before (run-up) and after
# (result). Both are editable per-event in the JSON afterwards.
DEFAULT_PRE_ROLL = 10
DEFAULT_POST_ROLL = 25

# How far back auto-discovery looks in fixtures.json for streamed matches.
DISCOVERY_DAYS = 14


def load_dotenv():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


# ---------------------------------------------------------------------------
# Auth token (X-IAS-API-REQUEST)
#
# The Match Centre widget signs every request with base64(3DES-ECB-PKCS7(t)),
# where t is the current unix time (seconds) minus 60, encoded as an ASCII
# string, and the key is the shared secret's 24 bytes used directly (→ 3DES).
# A self-contained DES lives here so the script has no third-party crypto
# dependency, matching the other stdlib-only fetch_*.py scripts.
# ---------------------------------------------------------------------------

# Standard DES permutation / S-box tables.
_IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,
       57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7]
_FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,
       36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25]
_E = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,
      22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1]
_P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25]
_PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,
        63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4]
_PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,
        41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32]
_SHIFT = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1]
_SBOX = [
 [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
 [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
 [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
 [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
 [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
 [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
 [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
 [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
]


def _bits(data: bytes) -> list:
    return [(b >> i) & 1 for b in data for i in range(7, -1, -1)]


def _frombits(bits: list) -> bytes:
    out = bytearray()
    for i in range(0, len(bits), 8):
        v = 0
        for b in bits[i:i + 8]:
            v = (v << 1) | b
        out.append(v)
    return bytes(out)


def _perm(block: list, table: list) -> list:
    return [block[i - 1] for i in table]


def _des_subkeys(key8: bytes) -> list:
    k = _perm(_bits(key8), _PC1)
    c, d = k[:28], k[28:]
    subkeys = []
    for s in _SHIFT:
        c, d = c[s:] + c[:s], d[s:] + d[:s]
        subkeys.append(_perm(c + d, _PC2))
    return subkeys


def _des_f(r: list, k: list) -> list:
    x = [a ^ b for a, b in zip(_perm(r, _E), k)]
    out = []
    for i in range(8):
        c = x[i * 6:i * 6 + 6]
        row = (c[0] << 1) | c[5]
        col = (c[1] << 3) | (c[2] << 2) | (c[3] << 1) | c[4]
        val = _SBOX[i][row * 16 + col]
        out += [(val >> j) & 1 for j in range(3, -1, -1)]
    return _perm(out, _P)


def _des_block(block8: bytes, subkeys: list) -> bytes:
    b = _perm(_bits(block8), _IP)
    l, r = b[:32], b[32:]
    for k in subkeys:
        l, r = r, [a ^ b for a, b in zip(l, _des_f(r, k))]
    return _frombits(_perm(r + l, _FP))


def _des_ecb(key8: bytes, data: bytes, decrypt: bool = False) -> bytes:
    subkeys = _des_subkeys(key8)
    if decrypt:
        subkeys = subkeys[::-1]
    return b"".join(_des_block(data[i:i + 8], subkeys) for i in range(0, len(data), 8))


def _des3_ecb_encrypt(key24: bytes, data: bytes) -> bytes:
    """Triple-DES (EDE) ECB encrypt with an 8-byte-block PKCS#7 pad."""
    pad = 8 - (len(data) % 8)
    data += bytes([pad]) * pad
    k1, k2, k3 = key24[:8], key24[8:16], key24[16:24]
    out = bytearray()
    for i in range(0, len(data), 8):
        blk = _des_ecb(k1, data[i:i + 8], decrypt=False)
        blk = _des_ecb(k2, blk, decrypt=True)
        blk = _des_ecb(k3, blk, decrypt=False)
        out += blk
    return bytes(out)


def generate_token() -> str:
    """Build a fresh X-IAS-API-REQUEST token, as the Match Centre widget does."""
    plaintext = str(round(time.time()) - 60).encode("ascii")
    return base64.b64encode(_des3_ecb_encrypt(RV_SHARED_SECRET, plaintext)).decode("ascii")


# ---------------------------------------------------------------------------
# Results Vault API
# ---------------------------------------------------------------------------

def api_get(path: str, params: dict, token: str):
    """GET {RV_BASE}/{path} with the auth header, return parsed JSON."""
    query = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{RV_BASE}/{path.lstrip('/')}?{query}"
    req = urllib.request.Request(url, headers={
        "X-IAS-API-REQUEST": token,
        "Accept": "application/json",
        "User-Agent": "wendovercc-slides/fetch_ball_events",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8").strip()
        if not body:
            raise SystemExit(f"  Results Vault returned an empty body for {path}")
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            raise SystemExit(f"  Results Vault returned non-JSON for {path}: {body[:120]!r}")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise SystemExit(
                f"  Results Vault returned {e.code} for {path} — the auth token "
                "was rejected. The widget's shared secret or signing scheme may "
                "have changed; re-check generate_token(), or set a hand-captured "
                "RESULTS_VAULT_TOKEN in .env as an override."
            )
        raise SystemExit(f"  Results Vault HTTP {e.code} for {url}: {e.read()[:300]!r}")


def _first(obj):
    """RV endpoints sometimes wrap the payload in a single-element list."""
    if isinstance(obj, list):
        return obj[0] if obj else {}
    return obj or {}


def resolve_rv_match_id(pc_match_id: int, token: str) -> str:
    data = api_get(f"mappings/4/12/{pc_match_id}/", {"sportid": SPORT_ID, "apiid": API_ID}, token)
    obj = _first(data)
    rv_id = obj.get("object_id1")
    if not rv_id:
        raise SystemExit(f"  No RV match mapping for PC match {pc_match_id} (response: {str(data)[:300]})")
    return str(rv_id)


def fetch_match(rv_match_id: str, token: str) -> dict:
    data = api_get(f"{ENTITY_ID}/matches/{rv_match_id}/", {"apiid": API_ID, "strmflg": "3"}, token)
    return _first(data)


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

_MS_DATE_RE = re.compile(r"/Date\((-?\d+)(?:([+-]\d{4}))?\)/")


def parse_dt(value):
    """Parse an RV timestamp to (unix_seconds, tz_offset_seconds).

    Handles ASP.NET "/Date(1783771061000+0100)/", plain unix seconds (int or
    numeric string) and ISO-8601. Returns (None, 0) if unparseable.
    """
    if value is None:
        return None, 0
    if isinstance(value, (int, float)):
        # Heuristic: values in the ms range are milliseconds.
        return (int(value) // 1000 if value > 1e12 else int(value)), 0
    s = str(value).strip()
    m = _MS_DATE_RE.search(s)
    if m:
        secs = int(m.group(1)) // 1000
        offset = 0
        if m.group(2):
            sign = 1 if m.group(2)[0] == "+" else -1
            offset = sign * (int(m.group(2)[1:3]) * 3600 + int(m.group(2)[3:5]) * 60)
        return secs, offset
    if s.isdigit():
        v = int(s)
        return (v // 1000 if v > 1e12 else v), 0
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return int(dt.timestamp()), int(dt.utcoffset().total_seconds()) if dt.utcoffset() else 0
    except ValueError:
        return None, 0


def is_wendover(team_name) -> bool:
    return CLUB in (team_name or "").lower()


def format_name(first, last) -> str:
    parts = [(first or "").strip(), (last or "").strip()]
    return " ".join(p for p in parts if p) or None


def find(obj: dict, *keys):
    """Return the first present, non-empty value among keys (shallow)."""
    for k in keys:
        v = obj.get(k)
        if v not in (None, "", []):
            return v
    return None


# ---------------------------------------------------------------------------
# Wendover player matching
# ---------------------------------------------------------------------------

def load_roster() -> list:
    """Load {name, first, last_token, last_full, teams} for every known player."""
    if not ROSTER_PATH.exists():
        print(f"  ! roster not found at {ROSTER_PATH.relative_to(ROOT)} — our_players will be empty")
        return []
    try:
        players = json.loads(ROSTER_PATH.read_text()).get("players", {})
    except Exception as e:
        print(f"  ! could not read roster ({e}) — our_players will be empty")
        return []
    roster = []
    for p in (players.values() if isinstance(players, dict) else players):
        name = (p.get("name") or "").strip()
        if not name:
            continue
        first, _, rest = name.partition(" ")
        roster.append({
            "name": name,
            "first": first.lower(),
            "last_token": (rest.split()[-1] if rest else "").lower(),
            "last_full": rest.lower(),
            "teams": p.get("teams") or [],
        })
    return roster


def _name_key(full_name):
    """(last, first-initial) from a full name, e.g. 'Rasikh Butt' -> ('butt','r')."""
    parts = (full_name or "").split()
    return (parts[-1].lower(), parts[0][:1].lower()) if len(parts) >= 2 else None


def _name_key_fl(first, last):
    """(last, first-initial) from separate first/last fields."""
    last = (last or "").strip().lower()
    return (last, (first or "").strip()[:1].lower()) if last else None


def fetch_scorecard_fielders(pc_match_id, api_token) -> dict:
    """Map opposition batter -> Wendover fielder name from the Play Cricket
    scorecard, so catches/stumpings/run-outs can be attributed to the fielder.
    Returns {} if no token or on any error (fielders just aren't auto-added)."""
    if not api_token:
        return {}
    url = f"{PC_API_BASE}/match_detail.json?match_id={pc_match_id}&api_token={api_token}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"  {pc_match_id}: scorecard fetch failed ({e}) — fielders not auto-added")
        return {}
    md = data.get("match_details")
    md = md[0] if isinstance(md, list) and md else md
    if not isinstance(md, dict):
        return {}
    fielders = {}
    for inn in md.get("innings", []):
        if is_wendover(inn.get("team_batting_name")):
            continue  # Wendover batting -> fielders are the opposition
        for b in inn.get("bat", []):
            fname = (b.get("fielder_name") or "").strip()
            key = _name_key(b.get("batsman_name"))
            if fname and key:
                fielders[key] = fname
    return fielders


def _first_matches(roster_first: str, frog_first: str) -> bool:
    if not frog_first:
        return True
    if not roster_first:
        return False
    # Either side may be an initial ("K" vs "Kaynu").
    if len(frog_first) == 1 or len(roster_first) == 1:
        return roster_first[0] == frog_first[0]
    return roster_first == frog_first


def match_player(roster: list, first, last, prefer_team=None):
    """Resolve a Frogbox first/last name to a full roster name, or None."""
    last = (last or "").strip().lower()
    if not last:
        return None
    first = (first or "").strip().lower()
    cands = [p for p in roster if last in (p["last_token"], p["last_full"])]
    cands = [p for p in cands if _first_matches(p["first"], first)]
    if not cands:
        return None
    if prefer_team:
        preferred = [p for p in cands if prefer_team in p["teams"]]
        if preferred:
            cands = preferred
    return cands[0]["name"]


def event_our_players(clip: dict, roster: list, prefer_team=None, fielders=None) -> list:
    """Return the Wendover players involved in a clip, each tagged with the
    role(s) they played in it: ``[{"name": ..., "roles": ["bowler", ...]}]``.

    Roles are the auto-derivable ones — ``batter`` / ``bowler`` / ``fielder``
    (``other`` is a manual-only bucket added in curation). One player can hold
    more than one role on a clip (e.g. caught-and-bowled → bowler + fielder).
    For intra-club games both sides are Wendover, so the batting *and* bowling
    branches both contribute. Order of first appearance is preserved.
    """
    order = []
    roles = {}

    def add(name, role):
        if not name:
            return
        if name not in roles:
            roles[name] = []
            order.append(name)
        if role not in roles[name]:
            roles[name].append(role)

    if is_wendover(clip.get("bowling_team_name")):
        add(match_player(roster, clip.get("bowler_first_name"), clip.get("bowler_last_name"), prefer_team), "bowler")
        # Frogbox omits the fielder; recover it from the scorecard (catches,
        # stumpings, run-outs) — Wendover is fielding here, so it's one of ours.
        if fielders:
            fname = fielders.get(_name_key_fl(clip.get("dismissed_batter_first_name"),
                                              clip.get("dismissed_batter_last_name")))
            if fname:
                parts = fname.split()
                f = match_player(roster, parts[0], parts[-1], prefer_team) if len(parts) >= 2 else None
                add(f, "fielder")
    if is_wendover(clip.get("batting_team_name")):
        add(match_player(roster, clip.get("batter_first_name"), clip.get("batter_last_name"), prefer_team), "batter")
        add(match_player(roster, clip.get("dismissed_batter_first_name"),
                         clip.get("dismissed_batter_last_name"), prefer_team), "batter")

    return [{"name": name, "roles": roles[name]} for name in order]


# ---------------------------------------------------------------------------
# Build the events list + match JSON
# ---------------------------------------------------------------------------

def derive_team(match: dict):
    """Slugify the Wendover side of the match, e.g. 'Wendover CC 1st XI' → '1st-xi'."""
    for side in (match.get("home_name"), match.get("away_name")):
        if side and CLUB in side.lower():
            name = re.sub(r"(?i)wendover\s+cc\s*", "", side).strip()
            name = re.sub(r"\s+", "-", name).lower()
            return name or None
    return None


def build_events(clips, anchor_unix, youtube_url, roster, team, fielders, args):
    """anchor_unix = the RV timestamp corresponding to YouTube video-second-0
    (recording_started_utc). dt_utc and the anchor share the RV clock's skew, so
    the skew cancels and (dt_utc - anchor) is the true position in the stream."""
    events = []
    for clip in clips:
        dt_unix, _ = parse_dt(clip.get("dt_utc"))
        type_id = clip.get("match_event_type_id")
        start = end = None
        if youtube_url and anchor_unix and dt_unix:
            offset = dt_unix - anchor_unix
            start = max(0, offset - args.pre_roll)
            end = offset + args.post_roll

        events.append({
            "id": find(clip, "id", "match_stream_highlight_id", "highlight_id"),
            "type": EVENT_TYPES.get(type_id, "other"),
            "match_event_type_id": type_id,
            "title": clip.get("title"),
            # Default caption for the video panel; overridable on the curation page.
            "narrative": clip.get("title"),
            "over": find(clip, "over_no", "over"),
            "ball": find(clip, "ball_no", "ball"),
            "innings": find(clip, "innings_id", "innings"),
            "batter": format_name(clip.get("batter_first_name"), clip.get("batter_last_name")),
            # Full roster name of the batter when it's one of ours (else None) — the
            # default subject for the pre-action "new batsman" card, since `batter`
            # itself is only the abbreviated scorecard name.
            "batter_our_player": match_player(roster, clip.get("batter_first_name"),
                                              clip.get("batter_last_name"), team),
            "bowler": format_name(clip.get("bowler_first_name"), clip.get("bowler_last_name")),
            "dismissed_batter": format_name(clip.get("dismissed_batter_first_name"),
                                            clip.get("dismissed_batter_last_name")),
            # Full roster name of the dismissed batter when it's one of ours (else
            # None) — a clean default subject for the post-action dismissal card,
            # since `dismissed_batter` itself is only the abbreviated scorecard name.
            "dismissed_our_player": match_player(roster, clip.get("dismissed_batter_first_name"),
                                                 clip.get("dismissed_batter_last_name"), team),
            "batting_team": clip.get("batting_team_name"),
            "bowling_team": clip.get("bowling_team_name"),
            "our_players": event_our_players(clip, roster, team, fielders),
            "frogbox_url": clip.get("embed_url"),
            "youtube_url": youtube_url,
            "start": start,
            "end": end,
            "dt_unix": dt_unix,
        })
    return events


def process_match(pc_id: int, token: str, roster: list, args) -> bool:
    """Fetch one match's events and write the raw file. Returns True if written."""
    try:
        rv_match_id = resolve_rv_match_id(pc_id, token)
        match = fetch_match(rv_match_id, token)
    except SystemExit as e:
        print(f"  {pc_id}: skipped — {str(e).strip()}")
        return False

    stream = _first(match.get("matchStreams") or match.get("MatchStreams") or [])
    clips = stream.get("MatchStreamHighlights") or stream.get("matchStreamHighlights") or []
    if not clips:
        print(f"  {pc_id}: no Frogbox stream / clips — skipping")
        return False

    video_id = find(stream, "video_id", "youtube_video_id", "videoId")
    youtube_url = f"https://www.youtube.com/watch?v={video_id}" if video_id else None
    stream_start_unix, offset = parse_dt(find(stream, "start_utc", "start_time", "stream_start_utc"))
    # recording_started_utc marks YouTube video-second-0 (see build_events). It
    # shares the RV clock skew with dt_utc, so it's the correct position anchor;
    # start_utc is ~10 min later (first ball) and would put every clip early.
    rec_started_unix, _ = parse_dt(find(stream, "recording_started_utc", "recording_start_utc"))
    anchor_unix = rec_started_unix or stream_start_unix
    if not rec_started_unix and stream_start_unix:
        print(f"  {pc_id}: ! no recording_started_utc — positions anchored on start_utc, may be offset")
    team = args.team or derive_team(match)
    fielders = fetch_scorecard_fielders(pc_id, os.environ.get("PLAY_CRICKET_API_TOKEN"))

    events = build_events(clips, anchor_unix, youtube_url, roster, team, fielders, args)
    match_date = None
    if stream_start_unix:
        match_date = datetime.fromtimestamp(stream_start_unix + offset, tz=timezone.utc).date().isoformat()

    out = {
        "pc_match_id": pc_id,
        "rv_match_id": int(rv_match_id) if str(rv_match_id).isdigit() else rv_match_id,
        "date": match_date,
        "team": team,
        "competition": find(match, "competition_name", "grade_name", "competition"),
        "home_name": (find(match, "home_team_name", "hometeamname", "home_name") or "").strip() or None,
        "away_name": (find(match, "away_team_name", "awayteamname", "away_name") or "").strip() or None,
        "video_id": video_id,
        "youtube_url": youtube_url,
        "stream_start_utc": stream_start_unix,
        "recording_started_utc": rec_started_unix,
        "events": events,
    }

    FETCHED_DIR.mkdir(parents=True, exist_ok=True)
    (FETCHED_DIR / f"{pc_id}.json").write_text(json.dumps(out, indent=2) + "\n")
    ours = sum(1 for e in events if e["our_players"])
    print(f"  {pc_id} ({team or '?'}): {len(events)} events ({ours} with a Wendover player) "
          f"→ fetched/matches/{pc_id}.json")
    return True


# ---------------------------------------------------------------------------
# Match discovery
# ---------------------------------------------------------------------------

def _parse_ddmmyyyy(s):
    try:
        return datetime.strptime(s, "%d/%m/%Y").date()
    except (ValueError, TypeError):
        return None


def discover_recent_match_ids(since_days: int) -> set:
    """PC match ids from fixtures.json recent_matches within the lookback window."""
    if not FIXTURES_PATH.exists():
        print(f"  ! {FIXTURES_PATH.relative_to(ROOT)} not found — run fetch_fixtures.py first")
        return set()
    try:
        data = json.loads(FIXTURES_PATH.read_text())
    except Exception as e:
        print(f"  ! could not read fixtures.json ({e})")
        return set()
    cutoff = date.today() - timedelta(days=since_days)
    ids = set()
    for matches in (data.get("recent_matches") or {}).values():
        for m in matches:
            mid = m.get("match_id")
            if not mid:
                continue
            d = _parse_ddmmyyyy(m.get("match_date"))
            if d is None or d >= cutoff:
                ids.add(int(mid))
    return ids


def curated_match_ids() -> set:
    """PC match ids that already have a committed curation overlay."""
    ids = set()
    suffix = ".curation.json"
    for p in CURATION_DIR.glob(f"*{suffix}"):
        stem = p.name[:-len(suffix)]
        if stem.isdigit():
            ids.add(int(stem))
    return ids


def main():
    parser = argparse.ArgumentParser(description="Fetch Frogbox ball-event metadata (build step).")
    parser.add_argument("--match-id", type=int, default=None,
                        help="Fetch a single PC match id, skipping auto-discovery")
    parser.add_argument("--team", default=None,
                        help="Override the team slug (else derived from the match teams)")
    parser.add_argument("--since-days", type=int, default=DISCOVERY_DAYS,
                        help=f"Auto-discovery lookback window in days (default {DISCOVERY_DAYS})")
    parser.add_argument("--pre-roll", type=int, default=DEFAULT_PRE_ROLL,
                        help=f"Seconds before the event for the YouTube clip (default {DEFAULT_PRE_ROLL})")
    parser.add_argument("--post-roll", type=int, default=DEFAULT_POST_ROLL,
                        help=f"Seconds after the event for the YouTube clip (default {DEFAULT_POST_ROLL})")
    args = parser.parse_args()

    load_dotenv()
    token = os.environ.get("RESULTS_VAULT_TOKEN") or generate_token()
    roster = load_roster()

    if args.match_id:
        match_ids = [args.match_id]
    else:
        match_ids = sorted(discover_recent_match_ids(args.since_days) | curated_match_ids())

    if not match_ids:
        print("  No matches to check.")
        return 0

    print(f"  Checking {len(match_ids)} match(es)…")
    written = 0
    for pc_id in match_ids:
        try:
            if process_match(pc_id, token, roster, args):
                written += 1
        except Exception as e:
            print(f"  {pc_id}: error — {e}")
    print(f"  fetch_ball_events: {written} match file(s) written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
