#!/usr/bin/env python3
"""Fetch Fantasy Cricket league data at build time via headless browser.

Logs in to https://wendover.fantasyclubcricket.co.uk with FANTASY_USERNAME and
FANTASY_PASSWORD, then scrapes team standings, player standings, and team of the
week pages. Saves JSON to content/data/. Exits cleanly if credentials are absent.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent.parent
CONTENT = ROOT / "content"
BASE_URL = "https://wendover.fantasyclubcricket.co.uk"

PAGES = {
    "fantasy_team_standings": f"{BASE_URL}/team-standings",
    "fantasy_player_standings": f"{BASE_URL}/player-standings",
    "fantasy_team_of_week": f"{BASE_URL}/team-of-the-week",
}


def fetch_enabled(name):
    """Is this fetch switched on in content/config.json?

    Absent from the map (or no config at all) means ON — the map exists only to
    turn a source off, so a new fetch needs no entry. Honoured by the script
    itself rather than by the workflow, so the CI step stays listed in
    deploy.yml and one boolean covers CI and a local run alike.
    """
    cfg_path = CONTENT / "config.json"
    if not cfg_path.exists():
        return True
    try:
        cfg = json.loads(cfg_path.read_text())
    except json.JSONDecodeError as e:
        # A broken config must not silently disable every source.
        print(f"  WARNING: could not read {cfg_path.name} ({e}) — fetching anyway",
              file=sys.stderr)
        return True
    return cfg.get("fetches", {}).get(name, True)


def load_dotenv():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def login(page, username, password):
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    print("  Navigating to home page...")
    page.goto(BASE_URL + "/")
    page.wait_for_load_state("networkidle")

    # Click the login button — try link then button by text
    print("  Clicking login...")
    try:
        page.get_by_role("link", name="Login").first.click()
    except Exception:
        try:
            page.get_by_role("button", name="Login").first.click()
        except Exception:
            page.locator("text=Login").first.click()

    # Wait for the email field inside the popup/modal.
    # The site uses Ant Design which renders email fields as input[placeholder="Email"],
    # not input[type="email"].
    print("  Waiting for login form...")
    email_input = page.locator('input[placeholder="Email"]')
    try:
        email_input.wait_for(state="visible", timeout=10_000)
    except PlaywrightTimeout:
        _dump_debug(page, "login_form_timeout")
        raise RuntimeError("Login form did not appear within 10 s — check selector or site availability")

    email_input.fill(username)
    page.locator('input[placeholder="Password"]').fill(password)

    # Submit by pressing Enter (works regardless of exact submit button label)
    page.keyboard.press("Enter")

    # Wait for the authenticated state — look for a logout link or profile element
    print("  Waiting for login confirmation...")
    try:
        page.wait_for_function(
            "() => document.body.innerText.includes('Logout') || "
            "      document.body.innerText.includes('Log out') || "
            "      document.body.innerText.includes('Sign out') || "
            "      document.body.innerText.includes('My Team') || "
            "      document.body.innerText.includes('My Account') || "
            "      document.body.innerText.includes('Profile') || "
            "      !document.body.innerText.includes('Login')",
            timeout=15_000,
        )
    except PlaywrightTimeout:
        _dump_debug(page, "login_confirmation_timeout")
        raise RuntimeError(
            "Login did not complete within 15 s. "
            "Check credentials or update the login confirmation check in this script."
        )
    print("  Logged in.")


def extract_table(page, root_selector=None, keep_blank_headers=False):
    """Extract table data, handling Ant Design's split header/body table pattern.

    Ant Design renders the column headers in one <table> and the data rows in a
    second <table> inside a scrollable container. We gather headers from whichever
    table has a <thead> and rows from whichever table has non-hidden <tbody> rows.

    root_selector: optional CSS selector to scope the search (e.g. active tab pane).
    keep_blank_headers: keep unnamed columns in `headers` so its indices line up
        with each row's cells (see the note in the JS).
    """
    return page.evaluate("""({rootSelector, keepBlank}) => {
        const root = rootSelector ? document.querySelector(rootSelector) : document;
        if (!root) return null;

        const tables = [...root.querySelectorAll('table')];
        if (!tables.length) return null;

        // Headers come from the table that has a thead
        const headerTable = tables.find(t => t.querySelector('thead')) || tables[0];
        // `keepBlank` preserves unnamed columns as '' so header index == cell
        // index. Player standings leads with an unheadered rank cell; dropping it
        // shifts every lookup by one and silently mis-reads the whole table.
        const allHeaders = [...headerTable.querySelectorAll('thead th, thead td')]
            .map(el => el.innerText.trim());
        const headers = keepBlank ? allHeaders : allHeaders.filter(h => h !== '');

        // Rows come from the table that has real (non-aria-hidden) tbody rows
        const bodyTable = tables.find(t =>
            t.querySelectorAll('tbody tr:not([aria-hidden])').length > 0
        ) || tables[0];

        const rows = [...bodyTable.querySelectorAll('tbody tr:not([aria-hidden])')]
            .map(tr => [...tr.querySelectorAll('td, th')].map(td => {
                const text = td.innerText.trim();
                if (text) return text;
                // Fall back to img src for icon-only cells
                const img = td.querySelector('img');
                return img ? (img.getAttribute('src') || '') : '';
            }))
            .filter(row => row.some(cell => cell !== ''));

        return { headers, rows };
    }""", {"rootSelector": root_selector, "keepBlank": keep_blank_headers})


def extract_page_title(page):
    """Try to extract a gameweek/round heading from the page."""
    return page.evaluate("""() => {
        const candidates = [
            document.querySelector('h1'),
            document.querySelector('h2'),
            document.querySelector('[class*="gameweek"]'),
            document.querySelector('[class*="round"]'),
            document.querySelector('[class*="week"]'),
        ].filter(Boolean);
        return candidates.length ? candidates[0].innerText.trim() : null;
    }""")


def scrape_page(page, key, url):
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    print(f"  Fetching {url} ...")
    page.goto(url)
    page.wait_for_load_state("networkidle")

    # Wait for the table skeleton, then wait for at least one real data row.
    # Ant Design inserts an aria-hidden measurement row before real rows — exclude it.
    try:
        page.wait_for_selector("table", timeout=15_000)
    except PlaywrightTimeout:
        print(f"  WARNING: no <table> found on {url} — saving empty data", file=sys.stderr)
        _dump_debug(page, key)
        return {"headers": [], "rows": [], "page_title": None}

    try:
        page.wait_for_selector("tbody tr:not([aria-hidden])", timeout=15_000)
    except PlaywrightTimeout:
        print(f"  WARNING: table found but no rows appeared on {url}", file=sys.stderr)
        _dump_debug(page, key)

    table = extract_table(page)
    page_title = extract_page_title(page)

    if table:
        print(f"    → {len(table['rows'])} rows, {len(table['headers'])} columns")
    else:
        print(f"  WARNING: table element present but extraction returned nothing", file=sys.stderr)
        table = {"headers": [], "rows": []}

    return {**table, "page_title": page_title}


def select_year(page, year):
    """Switch a standings page to a previous season via its "Previous Years" links.

    The selector is client-side — the URL never changes — so this clicks and then
    waits for the table to actually swap rather than for navigation. Only the two
    standings pages carry it; team of the week has no year archive at all, which
    is why a final Team of the Week cannot be recovered once the season turns.
    """
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    first_before = page.evaluate(
        """() => {const t=[...document.querySelectorAll('table')]
             .find(t=>t.querySelectorAll('tbody tr:not([aria-hidden])').length);
           return t ? t.querySelector('tbody tr:not([aria-hidden])').innerText : ''}"""
    )
    page.get_by_text(str(year), exact=True).first.click()
    try:
        page.wait_for_function(
            """(before) => {const t=[...document.querySelectorAll('table')]
                 .find(t=>t.querySelectorAll('tbody tr:not([aria-hidden])').length);
               return t && t.querySelector('tbody tr:not([aria-hidden])').innerText !== before}""",
            arg=first_before, timeout=15_000,
        )
    except PlaywrightTimeout:
        # Same top row before and after is plausible (a player can lead two
        # seasons), so this is a warning rather than a failure.
        print(f"    WARNING: table did not visibly change after selecting {year}",
              file=sys.stderr)
    print(f"    Year: {year}")


def _maximise_page_size(page):
    """Put the table on its largest page size, so most seasons need one pass."""
    try:
        opts = page.locator(".ant-pagination-options .ant-select")
        if not opts.count():
            return
        opts.first.click()
        page.wait_for_selector(".ant-select-item-option", timeout=5_000)
        page.locator(".ant-select-item-option").last.click()
        page.wait_for_timeout(1_000)
    except Exception as e:
        # Only a speed optimisation — pagination below still collects every row.
        print(f"    (could not change page size: {e})", file=sys.stderr)


# Player-standings columns, as {output key: header names we accept}. The site has
# renamed these before ("Runs Against" → "Runs Ag", "Stumpings" → "Stmpgs"), and a
# lookup that misses simply produced a blank column rather than an error — so both
# spellings stay listed, and `_col` reports anything it cannot find.
PLAYER_COLUMNS = {
    "name":      ["name"],
    "value":     ["value"],
    "runs":      ["runs scored", "runs"],
    "catches":   ["catches", "ct"],
    "run_outs":  ["run outs", "run out", "ro"],
    "stumpings": ["stmpgs", "stumpings", "stumping", "st"],
    "wickets":   ["wickets", "wicket", "wkts"],
    "runs_ag":   ["runs ag", "runs against"],
    "week":      ["week points", "week"],
    "total":     ["total points", "total"],
}


def _col(headers, names):
    """Index of the first header matching `names` — exact first, then substring.

    Exact-before-substring matters: "Runs" and "Runs Ag" are both substrings of
    each other's neighbourhood, and a plain `in` test binds "runs" to whichever
    column happens to come first.
    """
    lowered = [h.strip().lower() for h in headers]
    for want in names:
        if want in lowered:
            return lowered.index(want)
    for want in names:
        for i, h in enumerate(lowered):
            if want in h:
                return i
    return None


def scrape_player_standings(page, year=None):
    """Scrape the player standings table, paging through it.

    This page used to be four role-filtered tabs holding the same player list,
    which this function clicked through and de-duplicated. **It has no tabs any
    more** — it is one table, paginated, and the tab loop quietly collected
    nothing: `Found tabs: []`, zero rows, a build-green empty panel. The failure
    was silent because an empty standings table is also what the off-season looks
    like, so nothing downstream could tell the two apart.

    Two traps live in the table's shape:
      * the first column is an unheadered rank cell, so headers must be read with
        `keep_blank_headers` or every column lookup is off by one;
      * `Runs` and `Runs Ag` are distinct columns — see `_col`.
    """
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    url = PAGES["fantasy_player_standings"]
    print(f"  Fetching {url} ...")
    page.goto(url)
    page.wait_for_load_state("networkidle")

    try:
        page.wait_for_selector("tbody tr:not([aria-hidden])", timeout=15_000)
    except PlaywrightTimeout:
        print(f"  WARNING: no rows appeared on {url}", file=sys.stderr)
        _dump_debug(page, "fantasy_player_standings")
        return {"headers": [], "rows": [], "page_title": extract_page_title(page)}

    if year:
        select_year(page, year)
    _maximise_page_size(page)

    headers, seen, rows = [], set(), []
    while True:
        data = extract_table(page, keep_blank_headers=True) or {"headers": [], "rows": []}
        if not headers and data["headers"]:
            headers = data["headers"]
        new = 0
        for row in data["rows"]:
            key = row[_col(headers, PLAYER_COLUMNS["name"]) or 1] if headers else (row[1] if len(row) > 1 else "")
            if key and key not in seen:
                seen.add(key)
                rows.append(row)
                new += 1
        nxt = page.locator("li.ant-pagination-next:not(.ant-pagination-disabled)")
        if not new or not nxt.count():
            break
        nxt.first.click()
        page.wait_for_timeout(1_200)

    idx = {k: _col(headers, names) for k, names in PLAYER_COLUMNS.items()}
    missing = [k for k, v in idx.items() if v is None]
    if missing:
        print(f"    WARNING: no column found for {', '.join(missing)} "
              f"— headers were {headers}", file=sys.stderr)

    print(f"    → {len(rows)} players, {len(headers)} columns")

    def cell(row, key, default=""):
        i = idx[key]
        return row[i] if i is not None and i < len(row) else default

    # Output shape is fixed and the slide template indexes it positionally — do
    # not reorder without changing templates/slides/fantasy-league.html.
    out_headers = ["Name", "Value", "Runs", "Ct", "RO", "St", "Bowling", "Week Points", "Total Points"]

    def build_row(r):
        return [
            cell(r, "name"),
            cell(r, "value"),
            cell(r, "runs", "0"),
            cell(r, "catches", "0"),
            cell(r, "run_outs", "0"),
            cell(r, "stumpings", "0"),
            f"{cell(r, 'wickets', '0')}/{cell(r, 'runs_ag', '0')}",
            cell(r, "week", "0"),
            cell(r, "total", "0"),
        ]

    def sort_key(row):
        try:
            return int(cell(row, "total", "0") or 0)
        except ValueError:
            return 0

    rows.sort(key=sort_key, reverse=True)
    return {"headers": out_headers, "rows": [build_row(r) for r in rows],
            "page_title": extract_page_title(page)}


CATEGORY_MAP = {
    "/images/1.svg": "Batter",
    "/images/2.svg": "Bowler",
    "/images/3.svg": "All Rounder",
    "/images/4.svg": "Keeper",
}


# Category icon, Name, Value, Week Points — the shape every real row arrives in.
TOTW_ROW_WIDTH = 4


def post_process_team_of_week(data):
    """Replace image src in first cell with human-readable category name.

    Rows narrower than a full row are dropped: between gameweeks the table
    renders Ant Design's single-cell "No Data" placeholder, which is otherwise
    carried through as a row and blows up consumers indexing by column.
    """
    out_rows = []
    for row in data["rows"]:
        if len(row) < TOTW_ROW_WIDTH:
            continue
        category = CATEGORY_MAP.get(row[0], row[0])
        out_rows.append([category] + list(row[1:]))

    # Update headers: give the first column a name if it was empty/unnamed
    headers = list(data.get("headers", []))
    if not headers or headers[0] in CATEGORY_MAP.values() or headers[0] == "":
        headers = ["Category"] + headers
    data["headers"] = headers
    data["rows"] = out_rows
    return data


def _dump_debug(page, label):
    """Save a screenshot and HTML snapshot for debugging selector issues."""
    debug_dir = ROOT / "debug"
    debug_dir.mkdir(exist_ok=True)
    try:
        page.screenshot(path=str(debug_dir / f"{label}.png"), full_page=True)
        (debug_dir / f"{label}.html").write_text(page.content())
        print(f"  Debug snapshot saved to debug/{label}.*", file=sys.stderr)
    except Exception as e:
        print(f"  Could not save debug snapshot: {e}", file=sys.stderr)


# A season snapshot freezes the two panels that are a *record* of a finished
# season. Team of the week is a weekly award with no year archive on the site at
# all, and the Teams panel is next week's fixtures — neither means anything once
# the season is over, so neither is captured. See docs/design-conventions.md.
SNAPSHOT_PAGES = ["fantasy_player_standings", "fantasy_team_standings"]


def snapshot(page, year, fetched_at, source_year=None):
    """Write a committed copy of a finished season's standings.

    Unlike `content/data/fetched/` — gitignored, rebuilt nightly — this lands in
    `content/data/fantasy-<year>/` and is committed, because the point of it is to
    outlive the source. The league goes read-only over the winter and the site
    keeps only a couple of previous years.

    `source_year` picks a past season from the page's "Previous Years" control;
    omit it for the season the site currently calls "Current".
    """
    out_dir = CONTENT / "data" / f"fantasy-{year}"
    out_dir.mkdir(parents=True, exist_ok=True)

    for key in SNAPSHOT_PAGES:
        if key == "fantasy_player_standings":
            data = scrape_player_standings(page, year=source_year)
        else:
            page.goto(PAGES[key])
            page.wait_for_load_state("networkidle")
            page.wait_for_selector("tbody tr:not([aria-hidden])", timeout=15_000)
            if source_year:
                select_year(page, source_year)
            data = extract_table(page) or {"headers": [], "rows": []}
            data["page_title"] = extract_page_title(page)
            print(f"    → {len(data['rows'])} rows")

        if not data["rows"]:
            raise RuntimeError(
                f"{key} came back empty — refusing to write an empty snapshot. "
                "A frozen empty panel is permanent; check the season is complete "
                "and the scrape still matches the page."
            )

        data["season"] = year
        data["fetched_at"] = fetched_at
        out_path = out_dir / f"{key}.json"
        out_path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        print(f"    → {out_path.relative_to(ROOT)}")


def main(snapshot_year=None, source_year=None):
    # A snapshot is an explicit, deliberate one-off — the off switch is about the
    # nightly build, so it must not stand in the way of capturing a final table.
    if not snapshot_year and not fetch_enabled("fantasy_cricket"):
        print("fantasy_cricket is switched off in content/config.json — skipping "
              "(existing content/data/fetched/fantasy_*.json left as they are)")
        sys.exit(0)

    username = os.environ.get("FANTASY_USERNAME")
    password = os.environ.get("FANTASY_PASSWORD")

    if not username or not password:
        print("FANTASY_USERNAME / FANTASY_PASSWORD not set — skipping Fantasy Cricket fetch")
        sys.exit(0)

    from playwright.sync_api import sync_playwright

    data_dir = CONTENT / "data" / "fetched"
    data_dir.mkdir(parents=True, exist_ok=True)

    fetched_at = datetime.now(timezone.utc).isoformat()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        page = context.new_page()

        try:
            login(page, username, password)

            if snapshot_year:
                snapshot(page, snapshot_year, fetched_at, source_year)
                browser.close()
                return

            for key, url in PAGES.items():
                if key == "fantasy_player_standings":
                    data = scrape_player_standings(page)
                else:
                    data = scrape_page(page, key, url)

                if key == "fantasy_team_of_week":
                    data = post_process_team_of_week(data)

                data["fetched_at"] = fetched_at

                out_path = data_dir / f"{key}.json"
                out_path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
                print(f"    → {out_path.relative_to(ROOT)}")

        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            browser.close()
            sys.exit(1)

        browser.close()


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--snapshot", metavar="YEAR", help=(
        "write a committed season snapshot to content/data/fantasy-YEAR/ "
        "instead of the nightly fetched/ data"))
    ap.add_argument("--year", metavar="YEAR", help=(
        "scrape this season from the page's \"Previous Years\" control; omit for "
        "the season the site currently shows"))
    args = ap.parse_args()

    load_dotenv()
    if args.snapshot:
        print(f"Snapshotting Fantasy Cricket {args.snapshot}...")
    else:
        print("Fetching Fantasy Cricket data...")
    main(snapshot_year=args.snapshot, source_year=args.year)
