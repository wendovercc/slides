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


def extract_table(page, root_selector=None):
    """Extract table data, handling Ant Design's split header/body table pattern.

    Ant Design renders the column headers in one <table> and the data rows in a
    second <table> inside a scrollable container. We gather headers from whichever
    table has a <thead> and rows from whichever table has non-hidden <tbody> rows.

    root_selector: optional CSS selector to scope the search (e.g. active tab pane).
    """
    return page.evaluate("""(rootSelector) => {
        const root = rootSelector ? document.querySelector(rootSelector) : document;
        if (!root) return null;

        const tables = [...root.querySelectorAll('table')];
        if (!tables.length) return null;

        // Headers come from the table that has a thead
        const headerTable = tables.find(t => t.querySelector('thead')) || tables[0];
        const headers = [...headerTable.querySelectorAll('thead th, thead td')]
            .map(el => el.innerText.trim())
            .filter(h => h !== '');

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
    }""", root_selector)


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


def scrape_player_standings(page):
    """Scrape player standings by combining all four tabs.

    All tabs contain the same player list with identical stats — each tab is just
    a different role filter. We combine them, deduplicate by name, sort by Total
    Points descending, and keep only the columns useful for display.
    """
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    url = PAGES["fantasy_player_standings"]
    print(f"  Fetching {url} (tabbed) ...")
    page.goto(url)
    page.wait_for_load_state("networkidle")

    tab_labels = page.evaluate("""() =>
        [...document.querySelectorAll('[role="tab"]')].map(t => t.innerText.trim())
    """)
    print(f"    Found tabs: {tab_labels}")

    seen_names = set()
    combined_rows = []
    headers = []

    for label in tab_labels:
        if not label:
            continue
        page.get_by_role("tab", name=label).click()
        # Wait for the active tab pane to contain real rows. Ant Design sets
        # aria-hidden="true" on inactive panes, so scope to the visible pane to
        # avoid picking up rows from other tabs that remain in the DOM.
        active_pane_sel = '[role="tabpanel"]:not([aria-hidden="true"])'
        try:
            page.wait_for_selector(
                f'{active_pane_sel} tbody tr:not([aria-hidden])', timeout=10_000
            )
        except PlaywrightTimeout:
            print(f"    WARNING: no rows in tab '{label}'", file=sys.stderr)
            continue

        data = extract_table(page, root_selector=active_pane_sel) or {"headers": [], "rows": []}
        if not headers and data["headers"]:
            headers = data["headers"]

        for row in data["rows"]:
            name = row[0] if row else ""
            if name and name not in seen_names:
                seen_names.add(name)
                combined_rows.append(row)

    print(f"    Combined: {len(combined_rows)} unique players across {len(tab_labels)} tabs")

    # Find column indices by header name
    def col(keyword):
        try:
            return next(i for i, h in enumerate(headers) if keyword.lower() in h.lower())
        except StopIteration:
            return None

    name_idx    = 0
    value_idx   = col("value")
    runs_idx    = col("runs scored")
    catches_idx = col("catches")
    ro_idx      = col("run out")
    st_idx      = col("stumping")
    wkts_idx    = col("wicket")
    runs_ag_idx = col("runs against")
    week_idx    = col("week")
    total_idx   = col("total") if col("total") is not None else len(headers) - 1

    # Sort by Total Points descending
    def sort_key(row):
        try:
            return int(row[total_idx])
        except (ValueError, IndexError):
            return 0

    combined_rows.sort(key=sort_key, reverse=True)

    # Build output: Name, Value, Runs, Catches, Run Outs, Stumpings, Bowling, GW Pts, Total
    out_headers = ["Name", "Value", "Runs", "Ct", "RO", "St", "Bowling", "Week Points", "Total Points"]

    def build_row(r):
        bowling = (
            f"{r[wkts_idx]}/{r[runs_ag_idx]}"
            if wkts_idx is not None and runs_ag_idx is not None
            else ""
        )
        return [
            r[name_idx],
            r[value_idx]   if value_idx   is not None else "",
            r[runs_idx]    if runs_idx    is not None else "",
            r[catches_idx] if catches_idx is not None else "",
            r[ro_idx]      if ro_idx      is not None else "",
            r[st_idx]      if st_idx      is not None else "",
            bowling,
            r[week_idx]    if week_idx    is not None else "",
            r[total_idx],
        ]

    out_rows = [build_row(r) for r in combined_rows]

    page_title = extract_page_title(page)
    return {"headers": out_headers, "rows": out_rows, "page_title": page_title}


CATEGORY_MAP = {
    "/images/1.svg": "Batter",
    "/images/2.svg": "Bowler",
    "/images/3.svg": "All Rounder",
    "/images/4.svg": "Keeper",
}


def post_process_team_of_week(data):
    """Replace image src in first cell with human-readable category name."""
    out_rows = []
    for row in data["rows"]:
        if not row:
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


def main():
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
    load_dotenv()
    print("Fetching Fantasy Cricket data...")
    main()
