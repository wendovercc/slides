#!/usr/bin/env python3
"""Exploration script: inspect CS365 membership reports page and attempt CSV download."""

import csv
import io
import os
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
BASE_URL = "https://www.clubsports365.com"
CLUB_SLUG = "wendover-cricket-club"
REPORTS_URL = f"{BASE_URL}/clubs/{CLUB_SLUG}/clubadmin/reports/memberships"


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
    print("  Navigating to login page...")
    page.goto(f"{BASE_URL}/login")
    page.wait_for_load_state("networkidle")
    page.fill("#Email", username)
    page.fill("#Password", password)
    page.click('button[type="submit"]')
    try:
        page.wait_for_url(f"{BASE_URL}/clubs/**", timeout=15_000)
    except PlaywrightTimeout:
        _dump_debug(page, "login_timeout")
        raise RuntimeError("Login timed out")
    print("  Logged in.")


def _dump_debug(page, label):
    debug_dir = ROOT / "debug"
    debug_dir.mkdir(exist_ok=True)
    page.screenshot(path=str(debug_dir / f"{label}.png"), full_page=True)
    (debug_dir / f"{label}.html").write_text(page.content())
    print(f"  Debug snapshot: debug/{label}.*")


def inspect_filters(page):
    """Print info about filter form elements."""
    print("\n--- Filter elements ---")
    elements = page.evaluate("""() => {
        const results = [];
        document.querySelectorAll('select, input[type=checkbox], input[type=radio]').forEach(el => {
            const info = {
                tag: el.tagName,
                type: el.type || null,
                name: el.name || null,
                id: el.id || null,
                class: el.className || null,
            };
            if (el.tagName === 'SELECT') {
                info.multiple = el.multiple;
                info.options = Array.from(el.options).map(o => ({value: o.value, text: o.text}));
            }
            results.push(info);
        });
        return results;
    }""")
    for el in elements:
        print(f"  {el}")

    print("\n--- Buttons ---")
    buttons = page.evaluate("""() => {
        return Array.from(document.querySelectorAll('button, input[type=submit], a')).map(el => ({
            tag: el.tagName,
            text: el.textContent?.trim().slice(0, 80),
            id: el.id || null,
            class: el.className?.slice(0, 60) || null,
            href: el.href || null,
        })).filter(b => b.text);
    }""")
    for b in buttons:
        if any(kw in (b.get('text') or '').lower() for kw in ['generate', 'download', 'report', 'export', 'csv']):
            print(f"  [RELEVANT] {b}")
        else:
            print(f"  {b}")


def fetch_report_via_dom(page, membership_type_value, status="Active"):
    """Set filters via DOM manipulation, click Generate Report, read the table from DOM."""
    from bs4 import BeautifulSoup

    print(f"\n  Setting filters via DOM (MembershipTypes={membership_type_value}, Status={status})...")

    # The MembershipTypes is a Select2 widget wrapping a native select.
    # Set the value directly on the underlying select and trigger Select2's change event.
    page.evaluate(f"""() => {{
        var sel = document.getElementById('MembershipTypes');
        // Clear existing
        for (var o of sel.options) o.selected = false;
        // Select our value
        for (var o of sel.options) {{
            if (o.value === '{membership_type_value}') o.selected = true;
        }}
        // Notify Select2
        if (window.$) $('#MembershipTypes').trigger('change');
    }}""")

    # Set Status
    page.evaluate(f"""() => {{
        var sel = document.getElementById('Status');
        sel.value = '{status}';
        if (window.$) $('#Status').trigger('change');
    }}""")

    # Click Generate Report button and wait for the table to appear in DOM
    print("  Clicking Generate Report...")
    with page.expect_response(
        lambda r: "reports/memberships" in r.url and r.request.method == "POST",
        timeout=20_000,
    ) as resp_info:
        page.click('button[onclick="GenerateReport()"]')

    resp = resp_info.value
    print(f"  Response: HTTP {resp.status}, {len(resp.body())} bytes")
    html = resp.text()
    (ROOT / "debug" / "reports_post_response.html").write_text(html)

    if not html or not html.strip():
        print("  WARNING: Empty result")
        _dump_debug(page, "reports_empty_result")
        return []

    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", {"id": "tblMembershipsData"})
    if not table:
        print("  WARNING: #tblMembershipsData not in response, trying any table...")
        table = soup.find("table")
    if not table:
        print(f"  No table found. HTML preview: {html[:300]}")
        return []

    headers = [th.get_text(strip=True) for th in table.select("thead th")]
    print(f"  Columns: {headers}")

    rows = []
    for tr in table.select("tbody tr"):
        cells = [td.get_text(strip=True) for td in tr.find_all("td")]
        if cells:
            rows.append(dict(zip(headers, cells)))

    print(f"  Rows: {len(rows)}")
    if rows:
        print(f"  First row: {rows[0]}")
    return rows


def main():
    username = os.environ.get("CS365_USERNAME")
    password = os.environ.get("CS365_PASSWORD")
    if not username or not password:
        print("CS365 credentials not set")
        sys.exit(1)

    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        page = context.new_page()

        try:
            login(page, username, password)

            print(f"\n  Navigating to reports page...")
            page.goto(REPORTS_URL)
            page.wait_for_load_state("networkidle")

            # Senior Player (£0.00) = value 913
            rows = fetch_report_via_dom(page, membership_type_value="913", status="Active")
            print(f"\n  Total active senior players: {len(rows)}")

        except Exception as e:
            print(f"\nERROR: {e}", file=sys.stderr)
            _dump_debug(page, "reports_error")
            browser.close()
            sys.exit(1)

        browser.close()


if __name__ == "__main__":
    load_dotenv()
    print("Exploring CS365 membership reports...")
    main()
