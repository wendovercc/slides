#!/usr/bin/env python3
"""Download and trim video clips for slides at build time.

Scans content/slides/*.json for `video` fields (template == 'video'), downloads
each unique clip using yt-dlp + ffmpeg, and stores the result in
content/data/videos/{fingerprint}.mp4 with a .json sidecar containing the
clip's actual duration from ffprobe.

Clips are fingerprinted by SHA-256(url:start-end) so changing any parameter
forces a re-download. The directory persists across GitHub Actions runs via
cache, so unchanged clips are never re-downloaded.

Always exits 0 — a failed clip download never fails the build. Templates
render a branded fallback card when _video_src is None.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
CONTENT = ROOT / "content"
VIDEOS_DIR = CONTENT / "data" / "fetched" / "videos"


def load_dotenv():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def fingerprint(url: str, start, end) -> str:
    key = f"{url}:{start if start is not None else 0}-{end if end is not None else ''}"
    return hashlib.sha256(key.encode()).hexdigest()[:12]


def collect_clips() -> list:
    """Return a deduplicated list of {url, start, end, fp} dicts from all video slides."""
    seen = set()
    clips = []
    for path in sorted((CONTENT / "slides").glob("*.json")):
        try:
            slide = json.loads(path.read_text())
        except Exception:
            continue
        if slide.get("template") != "video":
            continue

        for v in slide.get("videos", []):
            url = v.get("url", "")
            if url:
                start = v.get("start")
                end = v.get("end")
                fp = fingerprint(url, start, end)
                if fp not in seen:
                    seen.add(fp)
                    clips.append({"url": url, "start": start, "end": end, "fp": fp})

    return clips


def download_clip(clip: dict) -> bool:
    fp = clip["fp"]
    url = clip["url"]
    start = clip["start"]
    end = clip["end"]
    out_mp4 = VIDEOS_DIR / f"{fp}.mp4"
    tmp_mp4 = VIDEOS_DIR / f"tmp_{fp}.mp4"

    sections = None
    if start is not None and end is not None:
        sections = f"*{start}-{end}"
    elif start is not None:
        sections = f"*{start}-"

    print(f"  Downloading {fp} ({url}, {start}-{end})")
    try:
        node = shutil.which("node")
        cookies_file = os.environ.get("YOUTUBE_COOKIES_FILE")
        ytdlp_cmd = ["yt-dlp"]
        if node:
            ytdlp_cmd += ["--js-runtimes", f"node:{node}", "--remote-components", "ejs:github"]
        if cookies_file and os.path.exists(cookies_file):
            ytdlp_cmd += ["--cookies", cookies_file]
        ytdlp_cmd += [
            "-f", "bestvideo[height<=720]+bestaudio",
            "--merge-output-format", "mp4",
            "-o", str(tmp_mp4),
        ]
        if sections:
            ytdlp_cmd += ["--download-sections", sections, "--force-keyframes-at-cuts"]
        ytdlp_cmd.append(url)

        result = subprocess.run(ytdlp_cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"  yt-dlp failed for {fp}: {result.stderr[:400]}")
            return False

        # Re-encode: ensure consistent H.264/AAC MP4 with faststart moov atom
        ffmpeg_cmd = [
            "ffmpeg", "-y", "-i", str(tmp_mp4),
            "-c:v", "libx264", "-crf", "23", "-preset", "fast",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            str(out_mp4),
        ]
        result = subprocess.run(ffmpeg_cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"  ffmpeg failed for {fp}: {result.stderr[:400]}")
            if out_mp4.exists():
                out_mp4.unlink()
            return False

        # Probe actual duration (yt-dlp keyframe cuts can differ slightly from requested)
        probe = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(out_mp4)],
            capture_output=True, text=True,
        )
        fallback = float((end or 0) - (start or 0)) or 30.0
        duration = fallback
        if probe.returncode == 0:
            try:
                duration = float(json.loads(probe.stdout)["format"]["duration"])
            except Exception:
                pass

        (VIDEOS_DIR / f"{fp}.json").write_text(json.dumps({
            "fingerprint": fp,
            "url": url,
            "start": start,
            "end": end,
            "duration": duration,
        }, indent=2))
        print(f"  {fp}: {duration:.1f}s")
        return True

    finally:
        if tmp_mp4.exists():
            tmp_mp4.unlink()


def main():
    load_dotenv()
    VIDEOS_DIR.mkdir(parents=True, exist_ok=True)

    clips = collect_clips()
    if not clips:
        print("  No video clips configured — skipping")
        return 0

    downloaded = skipped = failed = 0
    for clip in clips:
        fp = clip["fp"]
        if (VIDEOS_DIR / f"{fp}.mp4").exists() and (VIDEOS_DIR / f"{fp}.json").exists():
            print(f"  {fp} already cached — skipping")
            skipped += 1
            continue
        try:
            if download_clip(clip):
                downloaded += 1
            else:
                failed += 1
        except Exception as e:
            print(f"  {fp} failed ({e}) — skipping")
            failed += 1

    print(f"  fetch_videos: {downloaded} downloaded, {skipped} cached, {failed} failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
