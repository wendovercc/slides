#!/usr/bin/env python3
"""Fetch training schedule data from ClubSports365 at build time.

Logs in to https://www.clubsports365.com with CS365_USERNAME and CS365_PASSWORD,
then fetches weekly training sessions for the current week plus the following
WEEKS_AHEAD weeks. Saves JSON to content/data/cs365_training.json.

IMPORTANT: This script is strictly read-only. It never clicks edit/delete
controls or submits any form other than the login form.

Exits cleanly (code 0) if credentials are absent.
"""

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from bs4 import BeautifulSoup

ROOT = Path(__file__).parent.parent
CONTENT = ROOT / "content"

BASE_URL = "https://www.clubsports365.com"
CLUB_SLUG = "wendover-cricket-club"
TRAINING_URL = f"{BASE_URL}/clubs/{CLUB_SLUG}/clubadmin/training"

WEEKS_AHEAD = 8


def load_dotenv():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def build_team_lookup():
    """Return {cs365_team_name: team_id} from content/teams.json."""
    teams = json.loads((CONTENT / "teams.json").read_text())["teams"]
    return {
        t["cs365_team_name"]: t["id"]
        for t in teams
        if "cs365_team_name" in t
    }


def build_location_lookup():
    """Return {alias (lower): location_id} from content/locations.json."""
    locations = json.loads((CONTENT / "locations.json").read_text())["locations"]
    lookup = {}
    for loc in locations:
        for alias in loc["aliases"]:
            lookup[alias.lower()] = loc["id"]
    return lookup


def login(page, username, password):
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    print("  Navigating to login page...")
    page.goto(f"{BASE_URL}/login")
    page.wait_for_load_state("networkidle")

    page.fill("#Email", username)
    page.fill("#Password", password)
    page.click('button[type="submit"]')

    try:
        page.wait_for_url(f"{BASE_URL}/clubs/**", timeout=15_000)
    except PlaywrightTimeout:
        _dump_debug(page, "cs365_login_timeout")
        raise RuntimeError(
            "Login did not complete within 15 s — check credentials or site availability."
        )
    print("  Logged in.")


def fetch_week_html(page, week_start):
    """POST for a week's training HTML. Returns response body text."""
    response = page.request.post(
        TRAINING_URL,
        form={
            "isWeeklyView": "true",
            "selectedYear": str(week_start.year),
            "selectedDate": week_start.isoformat(),
            "searchText": "",
            "isInitialLoad": "false",
        },
    )
    if not response.ok:
        raise RuntimeError(f"Training POST returned HTTP {response.status} for {week_start}")
    return response.text()


def parse_sessions(html, week_start, team_lookup, location_lookup):
    """Parse session cards from a weekly training HTML fragment."""
    soup = BeautifulSoup(html, "html.parser")
    sessions = []

    for card in soup.select(".single-card"):
        s = {}

        title_el = card.select_one(".text-purple")
        if title_el:
            s["title"] = title_el.get_text(strip=True)

        for p in card.select("p.small.text-muted"):
            text = p.get_text(strip=True)
            if "Teams -" in text:
                s["teams_raw"] = text.replace("Teams -", "").strip()

        for span in card.select("p.small.mb-0 span"):
            text = span.get_text(strip=True)
            if any(d in text for d in ["Monday", "Tuesday", "Wednesday", "Thursday",
                                        "Friday", "Saturday", "Sunday"]):
                s["date_str"] = text
            elif "-" in text and ":" in text:
                s["time_raw"] = text

        loc_el = card.select_one(".bi-geo-alt")
        if loc_el and loc_el.parent:
            s["location"] = loc_el.parent.get_text(strip=True)

        view_link = card.select_one('a[href*="/training/view/"]')
        if view_link:
            s["session_id"] = view_link["href"].split("/")[-1]

        # Parse date to ISO format
        if "date_str" in s:
            try:
                s["date"] = datetime.strptime(s["date_str"], "%A, %d %B %Y").date().isoformat()
            except ValueError:
                s["date"] = None
        else:
            s["date"] = None

        # Parse start/end times from "HH:MM - HH:MM"
        time_raw = s.pop("time_raw", None)
        if time_raw and " - " in time_raw:
            parts = time_raw.split(" - ", 1)
            s["time_start"] = parts[0].strip()
            s["time_end"] = parts[1].strip()
        else:
            s["time_start"] = None
            s["time_end"] = None

        # Map team names to teams.json ids; drop squads and unknowns
        teams_raw = s.get("teams_raw", "")
        team_ids = []
        if teams_raw:
            for name in [n.strip() for n in teams_raw.split(",")]:
                if name in team_lookup:
                    team_ids.append(team_lookup[name])
        s["team_ids"] = team_ids

        # Match location to locations.json id via alias lookup (case-insensitive)
        location = s.get("location", "")
        s["location_id"] = location_lookup.get(location.lower())

        sessions.append(s)

    return sessions


def _dump_debug(page, label):
    debug_dir = ROOT / "debug"
    debug_dir.mkdir(exist_ok=True)
    try:
        page.screenshot(path=str(debug_dir / f"{label}.png"), full_page=True)
        (debug_dir / f"{label}.html").write_text(page.content())
        print(f"  Debug snapshot saved to debug/{label}.*", file=sys.stderr)
    except Exception as e:
        print(f"  Could not save debug snapshot: {e}", file=sys.stderr)


def main():
    username = os.environ.get("CS365_USERNAME")
    password = os.environ.get("CS365_PASSWORD")

    if not username or not password:
        print("CS365_USERNAME / CS365_PASSWORD not set — skipping CS365 training fetch")
        sys.exit(0)

    from playwright.sync_api import sync_playwright

    team_lookup = build_team_lookup()
    location_lookup = build_location_lookup()
    data_dir = CONTENT / "data"
    data_dir.mkdir(exist_ok=True)

    today = date.today()
    # Start from the Monday of the current week
    monday = today - timedelta(days=today.weekday())

    all_sessions = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        page = context.new_page()

        try:
            login(page, username, password)

            # Navigate to training page once to establish session context
            page.goto(TRAINING_URL)
            page.wait_for_load_state("networkidle")

            for week_offset in range(WEEKS_AHEAD + 1):
                week_start = monday + timedelta(weeks=week_offset)
                week_end = week_start + timedelta(days=6)
                print(f"  Fetching week {week_start} – {week_end}...")

                html = fetch_week_html(page, week_start)
                sessions = parse_sessions(html, week_start, team_lookup, location_lookup)
                all_sessions.extend(sessions)
                print(f"    → {len(sessions)} sessions")

        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            browser.close()
            sys.exit(1)

        browser.close()

    output = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "sessions": all_sessions,
    }

    out_path = data_dir / "cs365_training.json"
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False))
    print(f"  → {out_path.relative_to(ROOT)} ({len(all_sessions)} sessions total)")


if __name__ == "__main__":
    load_dotenv()
    print("Fetching CS365 training schedule...")
    main()
