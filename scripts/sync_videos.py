#!/usr/bin/env python3
"""Sync YouTube video clips to Cloudflare R2.

Run locally whenever you add, change, or remove video clips from slides.
Downloads and trims new/changed clips via yt-dlp + ffmpeg, uploads to R2,
removes clips no longer referenced by any slide, and updates
content/data/video_manifest.json (committed to the repo).

Pass --dry-run (or -n) to print the reconcile plan (what would upload / delete)
without downloading, uploading, deleting, or writing the manifest.

Safety guard: a curated match ({id}.curation.json) whose fetched ball-events file
is missing has its reel clips absent from the referenced set — so a sync would not
only skip uploading them but PRUNE any already in R2. The run aborts before any
upload/delete if such a match is found, naming the fetch command to run first.
Pass --allow-missing-fetch to override (e.g. a curation for a match with no stream).

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
import clip_ids

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
    """R2 object name for a clip — see scripts/clip_ids.py (shared with the build)."""
    return clip_ids.fingerprint(url, start, end)


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
        cmd += ["-f", clip_ids.FORMAT_SPEC, "--merge-output-format", "mp4", "-o", str(tmp)]
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

        # A clip with no video stream is a silent failure worth catching here.
        # yt-dlp can come back with audio only (a format briefly unavailable, a
        # throttled retry), ffmpeg re-encodes that quite happily, and the result
        # uploads to R2 looking like any other clip — until the compositor hits
        # it and dies with "Stream specifier ':v' matches no streams". Verifying
        # once, locally, is far cheaper than finding out mid-render.
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(out)],
            capture_output=True, text=True)
        if "video" not in probe.stdout:
            print(f"  {fp}: downloaded file has NO video stream — discarding")
            out.unlink(missing_ok=True)
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


def curated_without_fetch():
    """Curated matches (a committed {id}.curation.json) whose fetched ball-events
    file is absent. Their reel clips resolve from the merged fetched+overlay data,
    so with no fetched file they drop out of the referenced set entirely — which
    both skips their upload and marks any already in R2 for deletion. Always an
    oversight (run fetch_ball_events first), never intentional. Returns sorted ids."""
    suffix = ".curation.json"
    curated = {p.name[:-len(suffix)] for p in ball_events.CURATION_DIR.glob(f"*{suffix}")}
    fetched = {p.stem for p in ball_events.FETCHED_MATCHES.glob("*.json")}
    return sorted(cid for cid in curated - fetched if cid.isdigit())


def main():
    dry_run = "--dry-run" in sys.argv or "-n" in sys.argv
    allow_missing = "--allow-missing-fetch" in sys.argv
    load_dotenv()
    CACHE.mkdir(parents=True, exist_ok=True)

    # Guard against the deletion footgun, before touching R2: a curated match with no
    # fetched events has its reel clips absent from the referenced set, so a sync would
    # skip uploading them AND prune any already in R2. Warn always; on a real run abort
    # before any R2 work unless explicitly overridden. Purely local, so it fails fast.
    missing = curated_without_fetch()
    if missing:
        print("  ⚠ Curated match(es) with NO fetched ball-events "
              "(their reel clips are unreferenced):")
        for cid in missing:
            print(f"      {cid} — run: python3 scripts/fetch_ball_events.py --match-id {cid}")
        print("    A sync would skip uploading those clips AND delete any already in R2.")
        if not dry_run and not allow_missing:
            print("\n  Aborting before any R2 upload/delete. Fetch the match(es) above and "
                  "re-run,\n  or pass --allow-missing-fetch to override.\n")
            return 1
        print("")

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

    # Never prune while uploads are failing. The delete pass exists to reclaim
    # clips nothing references any more, which assumes the upload pass did its job;
    # if it didn't, the two halves combine into an outage — R2 emptied of the old
    # clips with nothing put back. That is not hypothetical: a run where `yt-dlp`
    # was missing from PATH failed all 111 downloads and deleted all 111 objects.
    # The clips are re-derivable, so this is recoverable, but only by noticing.
    if failed and to_delete:
        print(f"\n  ⚠ {failed} clip(s) failed to upload — skipping the removal of "
              f"{len(to_delete)} unreferenced object(s).")
        print("    Fix the failures and re-run; nothing is pruned until a clean pass.")
        to_delete = set()

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
