"""Clip identity — the one definition of how a highlight clip is named and fetched.

Imported by `fetch_videos.py`, `sync_videos.py` and `build.py`, which previously
each carried their own copy of `fingerprint()`. They MUST agree: the build looks a
clip up in the video manifest by fingerprint, and the sync names the R2 object by
it, so a divergence silently breaks every reel.

**The fetch resolution is part of the fingerprint.** R2 objects are served
`immutable, max-age=31536000`, so re-uploading different bytes under the same key
would leave every client that has already cached a clip — wall browsers, and the
offline player's own clip cache — pinned to the old encode forever. Folding the
height into the key means a resolution change produces new names instead: new
objects upload, and `sync_videos.py`'s reference-counted delete prunes the old ones
because nothing references them any more.

Changing CLIP_MAX_HEIGHT therefore re-fetches and re-uploads every clip. That is
the intended behaviour, not a side effect — but it is not free, so change it
deliberately.
"""
import hashlib

# Frogbox streams the match at 1080p and YouTube keeps that rendition (format 137,
# ~1872k, against 994k for 720p). Fetching at 720 and upscaling in the compositor
# threw away half the detail — worst on the burned-in scoreboard and any text.
CLIP_MAX_HEIGHT = 1080

FORMAT_SPEC = f"bestvideo[height<={CLIP_MAX_HEIGHT}]+bestaudio"


def fingerprint(url: str, start, end) -> str:
    """Stable 12-hex id for (clip, trim, fetch resolution)."""
    key = (f"{url}:{start if start is not None else 0}-{end if end is not None else ''}"
           f"@{CLIP_MAX_HEIGHT}p")
    return hashlib.sha256(key.encode()).hexdigest()[:12]
