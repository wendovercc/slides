#!/usr/bin/env python3
"""Sync YouTube video clips to Cloudflare R2.

Run locally whenever you add, change, or remove video clips from slides.
Downloads and trims new/changed clips via yt-dlp + ffmpeg, uploads to R2,
removes clips no longer referenced by any slide, and updates
content/data/video_manifest.json (committed to the repo).

Pass --dry-run (or -n) to print the reconcile plan (what would upload / delete)
without downloading, uploading, deleting, or writing the manifest.

Required in .env:
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
    R2_BUCKET, R2_BASE_URL
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import boto3

import ball_events

ROOT    = Path(__file__).parent.parent
CONTENT = ROOT / "content"
CACHE   = CONTENT / "data" / "fetched" / "videos"
MANIFEST_PATH = CONTENT / "data" / "video_manifest.json"


def load_dotenv():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def r2_client():
    account_id = os.environ["R2_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def fingerprint(url: str, start, end) -> str:
    key = f"{url}:{start if start is not None else 0}-{end if end is not None else ''}"
    return hashlib.sha256(key.encode()).hexdigest()[:12]


def collect_clips() -> list:
    """Return deduplicated {url, start, end, fp} clips referenced anywhere.

    Two sources, unioned and de-duplicated on fingerprint: hand-authored ``video``
    slide configs in ``content/slides``, and the curated match reels from
    ``ball_events.collect_curated_clips()`` (each at its pad-widened bounds). This
    is the referenced set the sync uploads and prunes R2 against.
    """
    seen = set()
    clips = []
    def add(url, start, end):
        if not url:
            return
        fp = fingerprint(url, start, end)
        if fp not in seen:
            seen.add(fp)
            clips.append({"url": url, "start": start, "end": end, "fp": fp})

    for path in sorted((CONTENT / "slides").glob("*.json")):
        try:
            slide = json.loads(path.read_text())
        except Exception:
            continue
        if slide.get("template") != "video":
            continue
        for v in slide.get("videos", []):
            if "url" not in v:
                continue
            add(v["url"], v.get("start"), v.get("end"))

    for c in ball_events.collect_curated_clips():
        add(c["url"], c["start"], c["end"])

    return clips


def is_fingerprint(name: str) -> bool:
    """True if name looks like a 12-char hex fingerprint (auto-managed clip)."""
    return len(name) == 12 and all(c in "0123456789abcdef" for c in name)


def list_r2_fps(client, bucket: str) -> set:
    """Return fingerprints of auto-managed clips in R2 (ignores manually uploaded files)."""
    fps = set()
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith(".mp4"):
                stem = key[:-4]
                if is_fingerprint(stem):
                    fps.add(stem)
    return fps


def download_clip(clip: dict) -> Path:
    """Download, trim and re-encode clip to local cache. Returns Path or None."""
    fp    = clip["fp"]
    url   = clip["url"]
    start = clip["start"]
    end   = clip["end"]
    out   = CACHE / f"{fp}.mp4"
    tmp   = CACHE / f"tmp_{fp}.mp4"

    if out.exists():
        print(f"  {fp}: already cached locally")
        return out

    sections = None
    if start is not None and end is not None:
        sections = f"*{start}-{end}"
    elif start is not None:
        sections = f"*{start}-"

    print(f"  {fp}: downloading {url} ({start}–{end})")
    try:
        node = shutil.which("node")
        cmd  = ["yt-dlp"]
        if node:
            cmd += ["--js-runtimes", f"node:{node}", "--remote-components", "ejs:github"]
        cookies = os.environ.get("YOUTUBE_COOKIES_FILE")
        if cookies and os.path.exists(cookies):
            cmd += ["--cookies", cookies]
        cmd += ["-f", "bestvideo[height<=720]+bestaudio", "--merge-output-format", "mp4", "-o", str(tmp)]
        if sections:
            cmd += ["--download-sections", sections, "--force-keyframes-at-cuts"]
        cmd.append(url)

        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"  {fp}: yt-dlp failed — {r.stderr[:400]}")
            return None

        r = subprocess.run(
            ["ffmpeg", "-y", "-i", str(tmp),
             "-c:v", "libx264", "-crf", "23", "-preset", "fast",
             "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
             str(out)],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            print(f"  {fp}: ffmpeg failed — {r.stderr[:400]}")
            return None

        return out
    except Exception as e:
        print(f"  {fp}: error — {e}")
        return None
    finally:
        if tmp.exists():
            tmp.unlink()


def probe_duration(path: Path, fallback: float) -> float:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(path)],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            return float(json.loads(r.stdout)["format"]["duration"])
    except Exception:
        pass
    return fallback


def main():
    dry_run = "--dry-run" in sys.argv or "-n" in sys.argv
    load_dotenv()
    CACHE.mkdir(parents=True, exist_ok=True)

    bucket   = os.environ["R2_BUCKET"]
    base_url = os.environ["R2_BASE_URL"].rstrip("/")
    client   = r2_client()

    clips          = collect_clips()
    referenced_fps = {c["fp"] for c in clips}
    r2_fps         = list_r2_fps(client, bucket)

    print(f"  {len(clips)} clip(s) referenced in slides, {len(r2_fps)} in R2")

    to_upload = referenced_fps - r2_fps
    to_delete = r2_fps - referenced_fps

    # Dry run: report the reconcile plan (what would upload / delete) using only the
    # read-only R2 listing above — no download, upload, delete, or manifest write.
    if dry_run:
        print("\n  DRY RUN — no changes will be made\n")
        print(f"  would upload {len(to_upload)}:")
        for c in sorted(clips, key=lambda c: c["fp"]):
            if c["fp"] in to_upload:
                print(f"    + {c['fp']}  {c['url']}  {c['start']}–{c['end']}")
        print(f"  would delete {len(to_delete)} (in R2, no longer referenced):")
        for fp in sorted(to_delete):
            print(f"    - {fp}.mp4")
        print(f"\n  {len(to_upload)} to upload, "
              f"{len(referenced_fps) - len(to_upload)} already in R2, {len(to_delete)} to remove")
        return 0

    # Load existing manifest so we preserve duration for clips already in R2
    manifest = {}
    if MANIFEST_PATH.exists():
        try:
            manifest = json.loads(MANIFEST_PATH.read_text())
        except Exception:
            pass

    uploaded = skipped = failed = deleted = 0

    for clip in clips:
        fp       = clip["fp"]
        r2_url   = f"{base_url}/{fp}.mp4"
        fallback = float((clip["end"] or 0) - (clip["start"] or 0)) or 30.0

        if fp not in to_upload:
            print(f"  {fp}: already in R2")
            if fp not in manifest:
                manifest[fp] = {"src": r2_url, "duration": fallback}
            skipped += 1
            continue

        path = download_clip(clip)
        if not path:
            failed += 1
            continue

        duration = probe_duration(path, fallback)
        print(f"  {fp}: uploading ({duration:.1f}s) → {r2_url}")
        try:
            client.upload_file(str(path), bucket, f"{fp}.mp4",
                               ExtraArgs={"ContentType": "video/mp4",
                                          "CacheControl": "public, max-age=31536000, immutable"})
            manifest[fp] = {"src": r2_url, "duration": duration}
            uploaded += 1
        except Exception as e:
            print(f"  {fp}: upload failed — {e}")
            failed += 1

    for fp in sorted(to_delete):
        print(f"  {fp}: removing from R2 (no longer referenced)")
        try:
            client.delete_object(Bucket=bucket, Key=f"{fp}.mp4")
            manifest.pop(fp, None)
            deleted += 1
        except Exception as e:
            print(f"  {fp}: delete failed — {e}")

    # Only write manifest entries for referenced clips
    manifest = {fp: manifest[fp] for fp in referenced_fps if fp in manifest}
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")

    print(f"\n  {uploaded} uploaded, {skipped} already in R2, {deleted} removed, {failed} failed")
    print(f"  manifest → {MANIFEST_PATH.relative_to(ROOT)}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
