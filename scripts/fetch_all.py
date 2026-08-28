#!/usr/bin/env python3
"""Run every fetch, in dependency order — the local equivalent of a CI build.

`content/data/fetched/` is gitignored, so a publisher machine starts with none of
the data a build needs. This runs the same fetches the nightly workflow does, in
the same order, so a local build produces the same site:

    python3 scripts/fetch_all.py            # everything
    python3 scripts/fetch_all.py -n         # print the plan, run nothing
    python3 scripts/fetch_all.py --only ball_events fixtures
    python3 scripts/fetch_all.py --skip cs365_training
    python3 scripts/fetch_all.py --check-ci   # still in step with the workflow?

**The order is load-bearing.** CI lists the same fetches as discrete steps, on
purpose — a failure there should name itself in the Actions UI rather than hide
inside one wrapper. That means the order exists in two places, so
`--check-ci` compares this list against `.github/workflows/deploy.yml` and fails
if they have drifted. Run it after touching either. Two of the dependencies are
real:

- `fetch_ball_events` takes its match ids from `fixtures.json`, so it must follow
  `fetch_fixtures`;
- `fetch_league_fixtures` reads the same file to find today's competitions.

Each fetch loads `.env` itself, so credentials live in one place. A fetch with no
credentials configured fails; that is the script's own message, not this one's.

Stops at the first failure, because everything after it would build on missing
data. Pass `--keep-going` to run the rest anyway (useful when one source is down
and you want everything else fresh).
"""

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

# In the order CI runs them. The name is the script minus the `fetch_` prefix,
# which is what --only/--skip take.
FETCHES = [
    ("fantasy_cricket", "fantasy league tables and teams"),
    ("play_cricket", "club, teams and results"),
    ("player_stats", "per-player batting/bowling/fielding"),
    ("fixtures", "the fixture list — ball events and league fixtures read it"),
    ("league_fixtures", "today's other games in our competitions"),
    ("ball_events", "Frogbox ball-by-ball + clip metadata (needs fixtures)"),
    ("cs365_training", "training attendance"),
    ("youtube_live", "the club channel's live/latest videos"),
]

# Deliberately NOT here: fetch_videos.py and sync_videos.py. They download and
# upload the R2 clip files, are publisher-local by design (CI never runs them),
# and depend on a *committed* curation overlay — see docs/publisher-runbook.md.


def check_ci():
    """Compare this list against the workflow, which lists the same fetches itself.

    CI keeps them as discrete steps deliberately (a failed fetch should name
    itself in the Actions UI), so the order is written down twice and can drift.
    This is the cheap guard: no yaml dependency, just the run lines in order.
    """
    wf = ROOT / ".github" / "workflows" / "deploy.yml"
    if not wf.exists():
        raise SystemExit(f"no workflow at {wf}")
    in_ci = re.findall(r"run:\s*python3?\s+scripts/fetch_(\w+)\.py", wf.read_text())
    in_ci = [n for n in in_ci if n != "all"]
    mine = [n for n, _ in FETCHES]
    if in_ci == mine:
        print(f"  ok — {len(mine)} fetch(es), same order in both")
        return
    print("  ! fetch_all.py and deploy.yml disagree:", file=sys.stderr)
    print(f"      here: {', '.join(mine)}", file=sys.stderr)
    print(f"      CI  : {', '.join(in_ci)}", file=sys.stderr)
    for extra in [n for n in mine if n not in in_ci]:
        print(f"      only here: {extra}", file=sys.stderr)
    for extra in [n for n in in_ci if n not in mine]:
        print(f"      only in CI: {extra}", file=sys.stderr)
    raise SystemExit(1)


def run(name, extra_args, dry_run):
    script = HERE / f"fetch_{name}.py"
    if not script.exists():
        raise SystemExit(f"no such fetch: {name} ({script} missing)")
    cmd = [sys.executable, str(script), *extra_args]
    if dry_run:
        print(f"  would run: {' '.join(cmd)}")
        return True
    print(f"\n=== fetch_{name} " + "=" * max(0, 60 - len(name)), flush=True)
    t0 = time.time()
    ok = subprocess.run(cmd).returncode == 0
    print(f"=== fetch_{name}: {'ok' if ok else 'FAILED'} in {time.time() - t0:.1f}s",
          flush=True)
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="+", metavar="NAME",
                    help="run only these (names as listed by --list)")
    ap.add_argument("--skip", nargs="+", metavar="NAME", default=[],
                    help="run everything except these")
    ap.add_argument("--keep-going", action="store_true",
                    help="carry on after a failure instead of stopping")
    ap.add_argument("-n", "--dry-run", action="store_true",
                    help="print what would run, run nothing")
    ap.add_argument("--list", action="store_true", help="list the fetches and exit")
    ap.add_argument("--check-ci", action="store_true",
                    help="check this list against .github/workflows/deploy.yml and exit")
    ap.add_argument("--match-id", help="passed through to fetch_ball_events")
    args = ap.parse_args()

    if args.list:
        for name, why in FETCHES:
            print(f"  {name:17} {why}")
        return
    if args.check_ci:
        check_ci()
        return

    names = [n for n, _ in FETCHES]
    unknown = set((args.only or []) + args.skip) - set(names)
    if unknown:
        raise SystemExit(f"unknown fetch(es): {', '.join(sorted(unknown))}\n"
                         f"known: {', '.join(names)}")
    todo = [n for n in names
            if (not args.only or n in args.only) and n not in args.skip]

    failed = []
    for name in todo:
        extra = ["--match-id", args.match_id] if (args.match_id and name == "ball_events") else []
        if not run(name, extra, args.dry_run):
            failed.append(name)
            if not args.keep_going:
                print(f"\nStopped at fetch_{name}. Everything after it would build on "
                      f"missing data;\nfix it and re-run, or pass --keep-going.",
                      file=sys.stderr)
                raise SystemExit(1)

    if args.dry_run:
        return
    print(f"\n{len(todo) - len(failed)}/{len(todo)} fetch(es) ok"
          + (f" — FAILED: {', '.join(failed)}" if failed else ""))
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
