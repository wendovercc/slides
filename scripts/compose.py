#!/usr/bin/env python3
"""Render a deck to MP4 — Phase 2 of docs/narrated-decks.md.

Deterministic assembly from separate assets, not a screen recording: each beat of
a timeline becomes its own encoded segment, and the segments are joined. Static
beats are headless-Chrome screenshots of the slide itself; clip beats are cut from
the R2 files; card beats are the clip's pad footage with the card composited over
it as a transparent PNG.

    python scripts/compose.py match-denham-cc                  # → build/compose/match-denham-cc.mp4
    python scripts/compose.py match-denham-cc --limit 6        # first six beats, for a quick look
    python scripts/compose.py --timeline tl.json -o out.mp4    # a timeline made earlier

With no timeline given, one is derived from the built deck (scripts/timeline.py),
which is the silent render: no narrator, no microphone, and every duration already
known at build time. A recorded timeline (phase 6) drops into the same pipeline —
`duration` longer than the media it names holds the last frame, shorter truncates
it, which is the audio-is-master rule the doc sets out.

Needs a built `site/` (run scripts/build.py first), ffmpeg, and Playwright's
chromium (`python -m playwright install chromium`).
"""

import argparse
import functools
import json
import shutil
import subprocess
import sys
import threading
import urllib.request
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import timeline as timeline_mod

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
# fetch_videos.py keeps every synced clip here, named by the same fingerprint as
# its R2 object, so a publisher (who runs the sync) already has the media locally.
LOCAL_VIDEOS = ROOT / "content" / "data" / "fetched" / "videos"

# One encoding profile for every segment, so the joins are cheap and the
# concatenated stream is uniform.
W, H, FPS = 1920, 1080, 30
RATE = 48000
# Quality over encode speed: this is a master handed to YouTube, which re-encodes
# it, so anything lost here is lost twice. `veryfast`/crf 20 measured 2.4 Mbps at
# 1080p30 — under a third of YouTube's recommended 8 Mbps — and starved encoding
# shows up worst on exactly what half this video is: static slides of text, where
# sharp edges and flat fills are the first things to smear.
V_ARGS = ["-c:v", "libx264", "-preset", "medium", "-crf", "18",
          "-pix_fmt", "yuv420p", "-r", str(FPS)]
# Intermediate segments carry PCM, not AAC, and live in .mov (mp4 won't hold PCM).
#
# This is not fussiness: every AAC stream begins with priming samples the decoder
# discards, so concatenating N AAC files with `-c copy` loses that much audio N
# times over. A 29-clip reel measured 157.348s of stamped audio but decoded to
# 155.947s — each clip's sound landing ~48ms early, compounding into 1.4s of
# audio running ahead of the picture by the end of the reel. PCM has no priming,
# so the joins are sample-exact and AAC is encoded exactly once, at the master.
SEG_EXT = ".mov"
A_SEG = ["-c:a", "pcm_s16le", "-ar", str(RATE), "-ac", "2"]
A_ARGS = ["-c:a", "aac", "-b:a", "128k", "-ar", str(RATE), "-ac", "2"]
SILENCE = f"anullsrc=r={RATE}:cl=stereo"
# Slides render for the wall by default and for a standalone video under
# ?ctx=archive (see slide-bridge.js): no "Last Match" heading, and the fixture's
# date and venue on the reel tag. A render is always watched out of context, so
# archive is the default here; --ctx wall reproduces the on-screen wording.
DEFAULT_CTX = "archive"


def frame_align(seconds):
    """Snap a beat to the frame grid, so its streams are exactly the same length.

    Video is quantised to whole frames whatever we ask for, and audio is not:
    a 6.016s beat gave 6.000s of video against 6.016s of audio, and that gap
    accumulates across a reel just as the AAC priming does. At 30fps and 48kHz a
    frame is exactly 1600 samples, so a frame-aligned duration is also
    sample-aligned and the two streams land together.
    """
    return round(seconds * FPS) / FPS

# EBU R128 target. The R2 clips carry real audio but at wildly inconsistent levels
# (measured: 14 dB of spread in mean, 18 dB in peak), so every clip is normalised
# here rather than at fetch time — the R2 files stay a faithful source.
LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11"
DUCK_DB = -12    # `duck` with no narration to duck under = a quieter bed
# Sample ceiling on the finished master. `level=disabled` matters: alimiter's
# auto-level is ON by default and *raises* the signal to meet the limit, which
# pushed a -16 LUFS render to -12.9 and its true peak above 0 dBFS. Limiting
# only, at 0.7, lands the true peak on loudnorm's -1.5 dBFS target once AAC
# inter-sample overshoot is counted, and leaves the loudness where it was
# (measured: -16.6 LUFS, -1.7 dBFS on a full match render).
LIMITER = "alimiter=limit=0.7:level=disabled"


def run(cmd, **kw):
    """Run a subprocess, raising with the tail of its output if it fails."""
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        tail = "\n".join((p.stderr or p.stdout or "").strip().splitlines()[-15:])
        raise SystemExit(f"command failed: {' '.join(str(c) for c in cmd[:6])} …\n{tail}")
    return p.stdout


def probe(path, stream, entry):
    """One ffprobe field, or None when the stream isn't there."""
    out = run(["ffprobe", "-v", "error", "-select_streams", stream,
               "-show_entries", f"stream={entry}" if stream != "format" else f"format={entry}",
               "-of", "default=nw=1:nk=1", str(path)]).strip()
    return out.splitlines()[0] if out else None


@functools.lru_cache(maxsize=None)
def has_audio(path):
    return probe(path, "a:0", "codec_type") == "audio"


def duration_of(path):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                      "-of", "default=nw=1:nk=1", str(path)]).strip())


# ── the site, served locally ──────────────────────────────────────────────────
# Slides reference /assets/… absolutely, so file:// won't do.

class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


@contextmanager
def serve(directory):
    handler = partial(_QuietHandler, directory=str(directory))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()


class Shooter:
    """Headless Chrome, sized to the design box.

    Slides lay out at a fixed 1920x1080 and the *player* scales them with --fit,
    so a slide opened on its own at that viewport is already the wall's frame:
    nothing to scale here.
    """

    def __init__(self, base_url, work, ctx=None):
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self.browser = self._pw.chromium.launch(headless=True)
        self.ctx = self.browser.new_context(
            viewport={"width": W, "height": H}, device_scale_factor=1)
        self.base_url = base_url
        self.work = work
        # Presentation context (slide-bridge.js). "archive" is the render default:
        # a published video is watched with none of the wall's surroundings, so the
        # slides drop wall-only wording ("Last Match") and show the fixture's date
        # and venue on the reel tag. Part of the cache key — the same slug renders
        # differently per context. (`slide_ctx`, not `ctx`: that's the browser
        # context above.)
        self.slide_ctx = ctx
        self._suffix = f"--{ctx}" if ctx else ""

    def close(self):
        self.browser.close()
        self._pw.stop()

    def _open(self, slug):
        page = self.ctx.new_page()
        query = f"?ctx={self.slide_ctx}" if self.slide_ctx else ""
        page.goto(f"{self.base_url}/slide/{slug}/{query}", wait_until="load")
        try:
            page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass  # a reel page keeps a connection open; the frame is still ready
        return page

    def slide(self, slug, panel):
        """A static atom: the slide showing `panel`, as a PNG."""
        out = self.work / "stills" / f"{slug}--p{panel}{self._suffix}.png"
        if out.exists():
            return out
        out.parent.mkdir(parents=True, exist_ok=True)
        page = self._open(slug)
        # Same commands the player sends: stop the slide's own rotation first, or
        # it may carousel away between the goto and the shutter.
        page.evaluate("""(i) => {
            window.postMessage({type: 'wcc-cmd', action: 'take-over'}, '*');
            window.postMessage({type: 'wcc-cmd', action: 'goto-panel', index: i}, '*');
        }""", panel)
        page.wait_for_timeout(900)  # panel transition + any entrance animation
        try:
            page.evaluate("document.fonts.ready")
        except Exception:
            pass
        page.screenshot(path=str(out))
        page.close()
        return out

    def overlay(self, slug, panel, at):
        """A clip beat's overlay layer — reel tag, caption and any card — with alpha.

        The footage itself comes from the R2 file, so the browser only has to draw
        what the wall draws *over* it. Shooting the whole layer in one pass (rather
        than the card alone) keeps the video faithful to the wall, including the
        top-left tag that conceals the Frogbox HIGHLIGHTS/QR artefact burned into
        every clip.

        Returns None for a video slide with no overlay layer at all.
        """
        out = self.work / "overlays" / f"{slug}--p{panel}--{at or 'plain'}{self._suffix}.png"
        if out.exists():
            return out
        out.parent.mkdir(parents=True, exist_ok=True)
        page = self._open(slug)
        dressed = page.evaluate("""([p, at]) =>
            !!(window.WccReel && window.WccReel.frame(p, at))""", [panel, at])
        if not dressed:
            page.close()
            return None
        page.add_style_tag(content="""
            html, body { background: transparent !important; }
            video, .clip, .video-wrap, .video-fallback, .slide-sidebar
                { visibility: hidden !important; }
            .reel-card, .reel-tag { transition: none !important; }
        """)
        page.wait_for_timeout(300)
        page.screenshot(path=str(out), omit_background=True)
        page.close()
        return out


# ── media ─────────────────────────────────────────────────────────────────────

def media_file(src, work):
    """The local file behind a clip URL — the synced copy if there is one.

    Publishers run sync_videos.py, so the R2 object is usually already on disk
    under the same fingerprint name. Otherwise it's fetched once into the work
    directory. Rendering from a file (never the YouTube embed) is the point: an
    embed captures black.
    """
    name = src.rsplit("/", 1)[-1]
    local = LOCAL_VIDEOS / name
    if local.exists():
        return local
    cached = work / "clips" / name
    if cached.exists():
        return cached
    cached.parent.mkdir(parents=True, exist_ok=True)
    print(f"    fetching {name}", flush=True)
    with urllib.request.urlopen(src, timeout=120) as r, open(cached, "wb") as f:
        shutil.copyfileobj(r, f)
    return cached


# ── one beat → one segment ────────────────────────────────────────────────────

def still_segment(png, seconds, out):
    run(["ffmpeg", "-y", "-loglevel", "error",
         "-loop", "1", "-framerate", str(FPS), "-t", f"{seconds:.5f}", "-i", str(png),
         "-f", "lavfi", "-t", f"{seconds:.5f}", "-i", SILENCE,
         "-vf", f"scale={W}:{H},format=yuv420p", *V_ARGS, *A_SEG,
         "-shortest", str(out)])


def clip_segment(src, t_in, t_out, seconds, overlay_png, clip_audio, out):
    """A clip beat: the [in, out] cut, the overlay layer over it, held or trimmed.

    `tpad=stop_mode=clone` is what makes a hold: the last frame is cloned for as
    long as the beat outruns its footage — a card the narrator sat on, or a
    mid-clip freeze. Audio is padded with silence over the held tail.
    """
    span = max(t_out - t_in, 0.0)
    hold = max(seconds - span, 0.0)

    inputs = ["-ss", f"{t_in:.3f}", "-to", f"{t_out:.3f}", "-i", str(src)]
    if overlay_png:
        inputs += ["-i", str(overlay_png)]
    if not has_audio(src):
        inputs += ["-f", "lavfi", "-t", f"{seconds:.5f}", "-i", SILENCE]

    v = (f"[0:v]scale={W}:{H}:force_original_aspect_ratio=decrease,"
         f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,fps={FPS},setpts=PTS-STARTPTS[base]")
    chain = [v]
    last = "base"
    if overlay_png:
        chain.append(f"[{last}][1:v]overlay=0:0:format=auto[dressed]")
        last = "dressed"
    if hold > 0.01:
        chain.append(f"[{last}]tpad=stop_mode=clone:stop_duration={hold:.3f}[held]")
        last = "held"
    chain.append(f"[{last}]format=yuv420p[v]")

    if not has_audio(src):
        a_in = f"[{2 if overlay_png else 1}:a]"
        chain.append(f"{a_in}asetpts=PTS-STARTPTS[a]")
    elif clip_audio == "mute":
        chain.append("[0:a]volume=0,asetpts=PTS-STARTPTS,apad[a]")
    else:
        gain = f",volume={DUCK_DB}dB" if clip_audio == "duck" else ""
        # `asetpts=N/SR/TB` after loudnorm is load-bearing, not tidying: loudnorm
        # runs a lookahead and re-stamps its output PTS, which pushes `apad`'s
        # padding past the `-t` cut. Without the reset the beat came out 84ms
        # short of its video every time a clip was normalised.
        chain.append(f"[0:a]asetpts=PTS-STARTPTS,aresample=async=1,{LOUDNORM}{gain},"
                     f"aresample={RATE},asetpts=N/SR/TB,apad[a]")

    run(["ffmpeg", "-y", "-loglevel", "error", *inputs,
         "-filter_complex", ";".join(chain), "-map", "[v]", "-map", "[a]",
         "-t", f"{seconds:.5f}", *V_ARGS, *A_SEG, str(out)])


# ── joining ───────────────────────────────────────────────────────────────────

def concat(segments, out):
    """Join same-profile segments without re-encoding (hard cuts)."""
    lst = out.with_suffix(".txt")
    lst.write_text("".join(f"file '{s.resolve()}'\n" for s in segments))
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(lst), "-c", "copy", str(out)])
    return out


def crossfade(parts, fade, out):
    """Chain `xfade`/`acrossfade` across the runs, in one pass.

    Each join eats `fade` seconds, so every offset is the running total so far
    minus the fades already spent. Parts shorter than the fade are left as hard
    cuts — crossfading a two-second clip into nothing looks like a glitch.
    """
    if len(parts) == 1:
        shutil.copy(parts[0], out)
        return out
    durs = [duration_of(p) for p in parts]
    inputs = [x for p in parts for x in ("-i", str(p))]
    chain, v_last, a_last, acc = [], "0:v", "0:a", durs[0]
    for i in range(1, len(parts)):
        f = min(fade, durs[i - 1] / 2, durs[i] / 2)
        vo, ao = f"v{i}", f"a{i}"
        if f < 0.05:
            chain.append(f"[{v_last}][{i}:v]concat=n=2:v=1:a=0[{vo}]")
            chain.append(f"[{a_last}][{i}:a]concat=n=2:v=0:a=1[{ao}]")
            acc += durs[i]
        else:
            chain.append(f"[{v_last}][{i}:v]xfade=transition=fade:duration={f:.3f}:"
                         f"offset={acc - f:.3f}[{vo}]")
            chain.append(f"[{a_last}][{i}:a]acrossfade=d={f:.3f}[{ao}]")
            acc += durs[i] - f
        v_last, a_last = vo, ao
    run(["ffmpeg", "-y", "-loglevel", "error", *inputs,
         "-filter_complex", ";".join(chain), "-map", f"[{v_last}]", "-map", f"[{a_last}]",
         *V_ARGS, *A_SEG, str(out)])
    return out


def master(src, out):
    """Final pass: cap the true peak. Video is copied, so this is audio-only.

    Single-pass loudnorm lands the level but is loose on true peak, and a
    crossfade briefly sums two beds — a limiter here keeps the finished file off
    0 dBFS for the upload without re-encoding a frame.
    """
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-af", LIMITER, "-c:v", "copy", *A_ARGS, str(out)])
    return out


def check_sync(path, expected):
    """Report the finished file's A/V alignment against the timeline.

    Decodes the audio rather than trusting the container's stamp, because the two
    drift bugs this guards against (AAC priming, frame quantisation) are invisible
    in the header — the reel that ran 1.4s out still *stamped* the right duration.
    Cheap enough to run every time, and the numbers are the first thing to look at
    when a render looks wrong.
    """
    v = float(probe(path, "v:0", "duration"))
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a",
                          "-f", "s16le", "-ac", "2", "-ar", str(RATE), "-"],
                         capture_output=True).stdout
    a = len(raw) / 4 / RATE
    print(f"  video {v:.3f}s · audio {a:.3f}s · timeline {expected:.3f}s")
    if abs(a - v) > 1.5 / FPS:
        print(f"  ! audio and video are {abs(a - v):.3f}s apart — the render will "
              f"drift {'ahead' if a < v else 'behind'}")
    return v, a


# ── the render ────────────────────────────────────────────────────────────────

def compose(tl, out_path, work, fade=0.5, limit=None, ctx=DEFAULT_CTX):
    beats = tl["beats"][:limit] if limit else tl["beats"]
    if not beats:
        raise SystemExit("timeline has no beats")
    clip_audio = tl.get("clip_audio", "keep")
    work.mkdir(parents=True, exist_ok=True)
    (work / "segments").mkdir(exist_ok=True)

    segments = []
    with serve(SITE) as base_url:
        shooter = Shooter(base_url, work, ctx=ctx)
        try:
            for i, beat in enumerate(beats):
                atom, secs = beat["atom"], frame_align(float(beat["duration"]))
                seg = work / "segments" / f"{i:04d}{SEG_EXT}"
                label = f"{atom['slide']} p{atom['panel']}" + (
                    f" {atom['card']}-card" if atom.get("card") else "")
                print(f"  [{i + 1}/{len(beats)}] {label} — {secs:.1f}s", flush=True)
                if secs <= 0.04:
                    print("      (zero-length — skipped)")
                    continue
                if not seg.exists():
                    if beat.get("media"):
                        m = beat["media"]
                        over = shooter.overlay(atom["slide"], atom["panel"], atom.get("card"))
                        if over is None and atom.get("card"):
                            print("      ! no overlay layer on this slide — footage only")
                        clip_segment(media_file(m["src"], work), float(m["in"]),
                                     float(m["out"]), secs, over, clip_audio, seg)
                    else:
                        still_segment(shooter.slide(atom["slide"], atom["panel"]), secs, seg)
                segments.append((atom["slide"], seg))
        finally:
            shooter.close()

    # Crossfade only where the wall crossfades: between slides. Panel and clip
    # steps within one slide are hard cuts there, and a montage of boundary fours
    # dissolving into each other would read as mush.
    runs, current, current_slide = [], [], None
    for slide, seg in segments:
        if current and slide != current_slide:
            runs.append(current)
            current = []
        current.append(seg)
        current_slide = slide
    if current:
        runs.append(current)

    print(f"  joining {len(segments)} segment(s) in {len(runs)} slide run(s)…", flush=True)
    joined = [concat(r, work / f"run{n:03d}{SEG_EXT}") if len(r) > 1 else r[0]
              for n, r in enumerate(runs)]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    full = work / f"joined{SEG_EXT}"
    if fade > 0:
        crossfade(joined, fade, full)
    else:
        concat(joined, full)
    master(full, out_path)
    check_sync(out_path, sum(frame_align(float(b["duration"])) for b in beats)
               - (len(runs) - 1) * fade)
    return out_path


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("deck", nargs="?", help="deck slug under site/slideshow/")
    ap.add_argument("--timeline", help="a timeline JSON, instead of deriving one")
    ap.add_argument("-o", "--out", help="output MP4 (default: build/compose/<deck>.mp4)")
    ap.add_argument("--work", help="scratch dir (default: build/compose/<deck>/); "
                                  "stills, overlays and segments are reused across runs")
    ap.add_argument("--fade", type=float, default=0.5,
                    help="crossfade seconds between slides (0 = hard cuts)")
    ap.add_argument("--clip-audio", choices=("keep", "duck", "mute"),
                    help="override the timeline's clip-audio treatment (segments are "
                         "cached, so pair a change with --fresh)")
    ap.add_argument("--ctx", default=DEFAULT_CTX,
                    help="presentation context passed to every slide as ?ctx= "
                         f"(default: {DEFAULT_CTX}; 'wall' for the on-screen wording)")
    ap.add_argument("--limit", type=int, help="render only the first N beats")
    ap.add_argument("--fresh", action="store_true",
                    help="discard cached stills/overlays/segments first")
    args = ap.parse_args()
    if not args.deck and not args.timeline:
        ap.error("give a deck slug or --timeline")
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg not found on PATH")

    if args.timeline:
        tl = json.loads(Path(args.timeline).read_text())
    else:
        tl = timeline_mod.derive_timeline(timeline_mod.load_deck(args.deck), slug=args.deck)
    if args.clip_audio:
        tl["clip_audio"] = args.clip_audio

    name = args.deck or (tl.get("deck") or "deck")
    work = Path(args.work) if args.work else ROOT / "build" / "compose" / name
    out = Path(args.out) if args.out else ROOT / "build" / "compose" / f"{name}.mp4"
    if args.fresh and work.exists():
        shutil.rmtree(work)

    print(f"Composing {name} ({len(tl['beats'])} beat(s), clip audio: "
          f"{tl.get('clip_audio', 'keep')})")
    compose(tl, out, work, fade=args.fade, limit=args.limit,
            ctx=None if args.ctx == "wall" else args.ctx)
    print(f"\n  → {out}  ({duration_of(out):.1f}s)")


if __name__ == "__main__":
    main()
