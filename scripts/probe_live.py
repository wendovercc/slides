#!/usr/bin/env python3
"""Live-match feed probe for the 'Live' slide exploration.

Given a Play-Cricket match id, resolves the Results Vault (Interact Sport) match
— the same backend the play-cricket.com website's own live scorecard uses — and
prints a live snapshot: match status / break, innings scores, batters at the
crease, last wicket, and any Frogbox highlight clips. Optionally polls every N
seconds so the feed can be watched mutating DURING a live match, to learn the
still-unknown bits:
  - what `status_id` reads in-play vs at a break (60 = completed);
  - whether `match_break_desc` fills during tea/drinks/innings;
  - whether the `CBalls` ball-by-ball slot ever populates live;
  - how quickly `scores_updated` moves (→ a sensible slide poll cadence).

Results Vault is a polled REST/JSON API (BunnyCDN + ASP.NET, Cache-Control
max-age=0, no push). Auth is a self-signed X-IAS-API-REQUEST token — see
generate_token() in fetch_ball_events, whose helpers this reuses (no secret).

    python3 scripts/probe_live.py <pc_match_id> [<pc_match_id> ...]
    python3 scripts/probe_live.py <pc_match_id> --watch 30   # poll every 30s
    python3 scripts/probe_live.py <pc_match_id> --diff        # print only on change
    python3 scripts/probe_live.py <pc_match_id> --raw         # dump full RV JSON
    python3 scripts/probe_live.py <pc_match_id> --scorecard   # batting+bowling card
    python3 scripts/probe_live.py <pc_match_id> --clips       # live-highlight watch

--clips (highlight watch): polls a streamed match, silently baselines the clips
already present, then flags each NEW highlight clip the moment it appears in
`MatchStreamHighlights` — with a playability probe of its frogbox.tv `.m3u8` and,
when a YouTube anchor is derivable (YOUTUBE_API_KEY + stream video_id), an
approximate real-time wicket→visible latency. This is the make-or-break test for
in-match video enrichment of the Live slide: does the feed populate DURING play,
and how fast? Loops until Ctrl-C (interval = --watch, default 20s).

Match ids come from the Play-Cricket match-centre URL, e.g.
play-cricket.com/website/results/<match_id>. Always exits 0 per-match on error.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_ball_events as fbe  # noqa: E402

_MS = re.compile(r"/Date\((-?\d+)")


def ts(v):
    """Format an RV /Date(ms)/ timestamp as local HH:MM:SS (else passthrough)."""
    if not v:
        return "-"
    m = _MS.search(str(v))
    if m:
        return time.strftime("%H:%M:%S", time.localtime(int(m.group(1)) / 1000))
    return str(v)


def snapshot(pc_id, token):
    """Return (human_summary, raw_match) for one Play-Cricket match id."""
    rv_id = fbe.resolve_rv_match_id(pc_id, token)
    m = fbe.fetch_match(rv_id, token)
    lines = [
        f"PC {pc_id}  RV {rv_id}  "
        f"{m.get('home_name', '').strip()} v {m.get('away_name', '').strip()}",
        f"  status_id={m.get('status_id')}  is_live_score={m.get('is_live_score')}  "
        f"allow_live={m.get('allow_live_score')}  was_live_scored={m.get('was_live_scored')}",
        f"  break={m.get('match_break_desc') or m.get('match_break_id')}  "
        f"scores_updated={ts(m.get('scores_updated'))}  score_text={m.get('score_text')!r}",
        f"  leader={m.get('leader_text')!r}",
    ]
    for team in m.get("MatchTeams", []):
        lines.append(
            f"  [{team.get('team_name', '').strip()}] score={team.get('match_score_text')} "
            f"toss={'W' if team.get('won_toss') else '-'} "
            f"bat1={'Y' if team.get('batted_first') else '-'} "
            f"result={team.get('result_type_text')}"
        )
        for inn in team.get("Innings", []):
            bats = [p for p in (inn.get("PlayerPerfs") or [])
                    if str(p.get("__type", "")).startswith("Batting")]
            # dismissal_id: 0/None = not yet batted, 1 = not out (AT CREASE),
            # anything else = dismissed. (The old `not dismissal_id` heuristic
            # mislabelled the whole yet-to-bat squad as at-crease and counted a
            # not-out batter as dismissed.)
            for p in (p for p in bats if p.get("dismissal_id") == _NOT_OUT):
                lines.append(
                    f"      * at crease: {p.get('player_name')} "
                    f"{p.get('runs')} ({p.get('balls')})  4s={p.get('fours')} 6s={p.get('sixes')}"
                )
            out = sorted((p for p in bats if p.get("dismissal_id") not in (None, 0, _NOT_OUT)),
                         key=lambda p: p.get("fow") or 0)
            if out:
                last = out[-1]
                lines.append(
                    f"      last out: {last.get('player_name')} "
                    f"{last.get('runs')} ({last.get('balls')}) — "
                    f"{last.get('dismissal_text')} @ {last.get('fow')}"
                )
            if inn.get("CBalls"):
                lines.append(
                    f"      >>> CBalls POPULATED: {len(inn['CBalls'])} balls "
                    "(ball-by-ball feed is LIVE!)"
                )
    stream = fbe._first(m.get("matchStreams") or [])
    if stream:
        clips = stream.get("MatchStreamHighlights") or []
        lines.append(
            f"  stream: video_id={stream.get('video_id')}  clips={len(clips)}  "
            f"frogbox_stream_id={stream.get('frogbox_stream_id')}"
        )
    return "\n".join(lines), m


# ---------------------------------------------------------------------------
# --scorecard: batting + bowling card, ordered by batting position
# ---------------------------------------------------------------------------

_NOT_OUT = 1  # dismissal_id: 1=not out, 2=caught, 4=bowled, 0=has not batted
_DNB = 99     # `number` sentinel for a batter who has not batted yet


def _is_bat(p):
    return str(p.get("__type", "")).split(":")[0].startswith("Batting")


def _is_bowl(p):
    return str(p.get("__type", "")).split(":")[0].startswith("Bowling")


def render_scorecard(m):
    """Render a text batting+bowling card for every started innings.

    Batting rows are ordered by `number` (the batting position); batters still
    on `number`==99 (_DNB) have not batted and are rolled into a "Did not bat"
    line rather than shown as 0-run rows. Not-out is `dismissal_id`==1; any
    other dismissal shows the feed's `dismissal_text` verbatim. Fall of wickets
    comes from `fow_order`/`fow`. Bowling figures are taken straight off the
    Bowling perfs sharing the innings; economy/strike-rate are derived. Only
    innings whose PlayerPerfs have populated are rendered."""
    out = []
    started = [(t, inn) for t in m.get("MatchTeams", [])
               for inn in t.get("Innings", []) if inn.get("PlayerPerfs")]
    match_done = m.get("status_id") == 60
    for idx, (t, inn) in enumerate(started):
            pp = inn.get("PlayerPerfs") or []
            # An innings is closed (→ "Did not bat") once a later innings has
            # begun, the side is all out, or the match is complete; while it is
            # still the live innings the unused batters are only "Yet to bat".
            innings_closed = (idx < len(started) - 1
                              or inn.get("wickets") == 10 or match_done)
            bats = [p for p in pp if _is_bat(p)]
            bowls = [p for p in pp if _is_bowl(p)]
            side = t.get("team_name", "").strip()
            out.append("=" * 60)
            out.append(f"BATTING — {side}   {inn.get('runs')}/{inn.get('wickets')}  "
                       f"({inn.get('overs_bowled')} ov)")
            out.append("-" * 60)
            out.append(f"{'#':>2} {'Batter':22}{'R':>4}{'B':>5}{'4s':>4}{'6s':>4}{'SR':>7}")
            batted = sorted((p for p in bats if (p.get("number") or _DNB) != _DNB),
                            key=lambda p: p.get("number") or _DNB)
            dnb = [p for p in bats if (p.get("number") or _DNB) == _DNB]
            for p in batted:
                did = p.get("dismissal_id")
                r, b = p.get("runs") or 0, p.get("balls") or 0
                sr = f"{r / b * 100:.1f}" if b else "-"
                star = "*" if did == _NOT_OUT else " "
                out.append(f"{p.get('number'):>2} {(p.get('player_name') or '')[:22]:22}"
                           f"{r:>4}{b:>5}{p.get('fours') or 0:>4}{p.get('sixes') or 0:>4}{sr:>7}{star}")
                how = "not out" if did == _NOT_OUT else (p.get("dismissal_text") or "")
                if how:
                    out.append(f"     {how}")
            fow = sorted((p for p in bats if p.get("fow_order")),
                         key=lambda p: p.get("fow_order"))
            if fow:
                out.append("   Fall: " + ", ".join(
                    f"{p.get('fow_order')}-{p.get('fow')} "
                    f"({(p.get('player_name') or '').split()[-1]})" for p in fow))
            if dnb:
                out.append(f"   {'Did not bat' if innings_closed else 'Yet to bat'}: "
                           + ", ".join(p.get("player_name") or "" for p in dnb))
            out.append(f"   Extras {inn.get('extras') or 0}  "
                       f"(nb {inn.get('no_balls') or 0}, wd {inn.get('wides') or 0}, "
                       f"b {inn.get('byes') or 0}, lb {inn.get('leg_byes') or 0})")
            out.append(f"   TOTAL {inn.get('runs')}/{inn.get('wickets')}  "
                       f"({inn.get('overs_bowled')} ov)")
            active = [p for p in bowls if p.get("overs")]
            if active:
                out.append("")
                out.append("BOWLING")
                out.append("-" * 60)
                out.append(f"{'Bowler':22}{'O':>5}{'M':>4}{'R':>5}{'W':>4}{'wd':>5}{'nb':>4}{'Econ':>7}")
                for p in active:
                    ov = p.get("overs")
                    try:
                        f = float(ov)
                        balls = int(f) * 6 + round((f - int(f)) * 10)
                    except (TypeError, ValueError):
                        balls = 0
                    rc = p.get("runs") or 0
                    econ = f"{rc / (balls / 6):.2f}" if balls else "-"
                    out.append(f"{(p.get('player_name') or '')[:22]:22}{str(ov):>5}"
                               f"{p.get('maidens') or 0:>4}{rc:>5}{p.get('wickets') or 0:>4}"
                               f"{p.get('wides') or 0:>5}{p.get('no_balls') or 0:>4}{econ:>7}")
            out.append("")
    return "\n".join(out) or "  (no innings has started yet)"


# ---------------------------------------------------------------------------
# --clips: live-highlight watch mode
# ---------------------------------------------------------------------------

def _clip_id(c):
    return fbe.find(c, "id", "match_stream_highlight_id", "highlight_id")


def _yt_actual_start(video_id):
    """Real-UTC unix of the YouTube broadcast's second-0 (actualStartTime), or
    None. Lets us convert a clip's skewed RV dt_utc into a real event time:
    real = actualStartTime + (dt_utc - recording_started_utc). Needs
    YOUTUBE_API_KEY; degrades to None (first-seen-only) without it."""
    key = os.environ.get("YOUTUBE_API_KEY")
    if not key or not video_id:
        return None
    try:
        url = ("https://www.googleapis.com/youtube/v3/videos"
               f"?part=liveStreamingDetails&id={video_id}&key={key}")
        with urllib.request.urlopen(url, timeout=15) as r:
            items = json.loads(r.read().decode()).get("items") or []
        st = items[0].get("liveStreamingDetails", {}).get("actualStartTime") if items else None
        if st:
            return datetime.fromisoformat(st.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None
    return None


def _probe_m3u8(url):
    """GET the clip playlist; return (status, elapsed_ms). status is the HTTP
    code (or an error string), suffixed if the body isn't an HLS playlist."""
    t = time.time()
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "wendovercc-slides/probe_live",
            "Origin": "https://slides.wendovercc.org",
        })
        with urllib.request.urlopen(req, timeout=15) as r:
            head = r.read(64)
        ms = int((time.time() - t) * 1000)
        return (r.status if head.startswith(b"#EXTM3U") else f"{r.status}?not-m3u8"), ms
    except urllib.error.HTTPError as e:
        return e.code, int((time.time() - t) * 1000)
    except Exception as e:
        return f"ERR {type(e).__name__}", int((time.time() - t) * 1000)


def _report_new_clip(c, anchor, now):
    cid = _clip_id(c)
    typ = fbe.EVENT_TYPES.get(c.get("match_event_type_id"), "other")
    title = c.get("title") or ""
    ov, bl = c.get("over_no"), c.get("ball_no")
    url = c.get("embed_url") or c.get("highlight_url")
    lat = ""
    dt_unix, _ = fbe.parse_dt(c.get("dt_utc"))
    if anchor.get("rec") and anchor.get("yt") and dt_unix:
        real_event = anchor["yt"] + (dt_unix - anchor["rec"])
        lat = (f"  event≈{time.strftime('%H:%M:%S', time.localtime(real_event))}"
               f"  latency≈{now - real_event:.0f}s")
    print(f"  ★ NEW {typ.upper():6} clip {cid}  ov {ov}.{bl}  \"{title}\"{lat}")
    if url:
        st, ms = _probe_m3u8(url)
        print(f"      m3u8: {url[:104]}")
        print(f"      playable: HTTP {st} in {ms}ms")


def run_clip_watch(args):
    fbe.load_dotenv()
    interval = args.watch or 20
    seen = {pc: set() for pc in args.pc_ids}
    baselined = {pc: False for pc in args.pc_ids}
    anchors = {}
    print(f"Highlight watch: {len(args.pc_ids)} match(es), every {interval}s. "
          "Existing clips are baselined silently; new ones are flagged. Ctrl-C to stop.\n")
    while True:
        token = fbe.generate_token()
        for pc in args.pc_ids:
            try:
                rv = fbe.resolve_rv_match_id(pc, token)
                m = fbe.fetch_match(rv, token)
            except SystemExit as e:
                print(f"PC {pc}: {str(e).strip()}")
                continue
            except Exception as e:
                print(f"PC {pc}: error {e}")
                continue
            stream = fbe._first(m.get("matchStreams") or [])
            clips = stream.get("MatchStreamHighlights") or []
            # Recompute the anchor until the stream attaches: matches probed from
            # before their frogbox stream comes online start with rec=None, and a
            # once-only anchor would stay None all match, forfeiting real-time
            # latency. Retry while rec is unknown; lock in once it appears.
            cur = anchors.get(pc)
            if cur is None or cur.get("rec") is None:
                rec, _ = fbe.parse_dt(fbe.find(stream, "recording_started_utc", "recording_start_utc"))
                vid = fbe.find(stream, "video_id", "youtube_video_id", "videoId")
                if cur is None or rec is not None:
                    anchors[pc] = {"rec": rec, "vid": vid, "yt": _yt_actual_start(vid) if rec else None}
            anchor = anchors[pc]
            now = time.time()
            new = [c for c in clips if _clip_id(c) not in seen[pc]]
            print(f"[{time.strftime('%H:%M:%S')}] PC {pc}: is_live={m.get('is_live_score')} "
                  f"status_id={m.get('status_id')} break={m.get('match_break_desc') or '-'} "
                  f"clips={len(clips)} (+{len(new)}) score={m.get('score_text')!r}")
            if not baselined[pc]:
                seen[pc].update(_clip_id(c) for c in clips)
                baselined[pc] = True
                anchor_note = ("YouTube anchor OK — latency is real-time"
                               if anchor.get("yt") else
                               "no YouTube anchor — correlate 'first seen' time with your watch")
                print(f"    (baseline: {len(clips)} existing clips ignored; watching for new. {anchor_note})")
                continue
            for c in new:
                seen[pc].add(_clip_id(c))
                _report_new_clip(c, anchor, now)
        time.sleep(interval)


def main():
    ap = argparse.ArgumentParser(description="Poll the Results Vault live match feed.")
    ap.add_argument("pc_ids", nargs="+", type=int, help="Play-Cricket match id(s)")
    ap.add_argument("--watch", type=int, default=0, metavar="SECS",
                    help="poll every SECS seconds (0 = one shot)")
    ap.add_argument("--diff", action="store_true", help="only reprint a match when it changed")
    ap.add_argument("--raw", action="store_true", help="dump full RV JSON for the first id and exit")
    ap.add_argument("--scorecard", action="store_true",
                    help="render a batting+bowling card (order by batting position)")
    ap.add_argument("--clips", action="store_true",
                    help="live-highlight watch: flag each new clip + latency (loops)")
    args = ap.parse_args()

    if args.clips:
        return run_clip_watch(args)

    fbe.load_dotenv()

    last = {}
    while True:
        token = fbe.generate_token()
        for pc in args.pc_ids:
            try:
                if args.scorecard:
                    m = fbe.fetch_match(fbe.resolve_rv_match_id(pc, token), token)
                    text = render_scorecard(m)
                else:
                    text, m = snapshot(pc, token)
            except SystemExit as e:
                print(f"PC {pc}: {str(e).strip()}")
                continue
            except Exception as e:
                print(f"PC {pc}: error {e}")
                continue
            if args.raw:
                print(json.dumps(m, indent=1, default=str))
                return 0
            if args.diff and last.get(pc) == text:
                continue
            last[pc] = text
            print(time.strftime("[%H:%M:%S]"), text, "\n")
        if not args.watch:
            break
        time.sleep(args.watch)
    return 0


if __name__ == "__main__":
    sys.exit(main())
