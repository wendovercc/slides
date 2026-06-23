# Scheduling & Intelligence Layer — Design

## Problem

Displays currently show static, hardcoded slideshows. The goal is for each screen to show
contextually relevant content based on **time + location**, without requiring a separate
slideshow to be curated for every combination of team, screen location and activity type.

---

## Three-Level Filtering

Content visibility is controlled at three independent levels:

| Level | Where | Controls |
|-------|-------|----------|
| **Slide** | `content/slides/{slug}.json` | Global kill switch (`active: false`), expiry date, `panel_duration` |
| **Slideshow** | `content/slideshows/{slug}.json` | Sequencing, audience predicates per slide entry |
| **Runtime** | Player JS + context calendar | Current activity type, phase, section, teams |

The universal slideshow (`pavilion-auto`) contains all slides with audience predicates on
each entry. The player evaluates the current context against those predicates and skips
slides that don't match. Curated slideshows (e.g. for a specific event) can be used
instead of the default — at that point audience predicates are optional since the slide
list is already hand-picked.

Slide-level properties control global, unconditional visibility (`active`, `expires`).
Audience predicates live on the **slideshow entry**, not the slide definition, so the
same slide can appear under different conditions in different slideshows.

---

## Activity Types

| Type | Source | Notes |
|------|--------|-------|
| `match` | `fixtures.json` | Home matches at our screen locations only |
| `training` | `cs365_training.json` | Actual sessions fetched from ClubSports365 |
| `club_event` | `events.json` | Whole-club event — all sections |
| `section_event` | `events.json` | Targets a specific section (e.g. Junior Awards Night) |
| `hire` | `events.json` | Third-party occupancy of the facility |
| `idle` | Computed | No covering activity — enables countdown/teaser slides |

`idle` is not stored in the calendar. The player reaches it when no calendar entry
covers the current time. It is a first-class context state: slideshow entries can be
predicated on `idle` to show content like a countdown to the next activity window.
To support this, the player scans forward in the calendar to find the next upcoming
activity at the current location.

---

## Time Phases

Each calendar entry has three named phases with pre-computed absolute times:

| Phase | Description |
|-------|-------------|
| `warm_up` | Pre-activity arrival window |
| `main` | Core activity in progress |
| `wind_down` | Post-activity wind-down/departure |

Phase durations are policy — they live in `config.json` and are applied by `build.py`
when generating the calendar. Individual entries in `events.json` can override the
defaults for that specific event.

```json
"activity_phases": {
  "match":    { "warm_up_mins": 120, "main_duration_mins": 210, "wind_down_mins": 180 },
  "training": { "warm_up_mins": 15,  "wind_down_mins": 30 },
  "hire":     { "warm_up_mins": 60,  "wind_down_mins": 60 }
}
```

For training and events, `main` spans the declared start–end time. For matches, Play
Cricket provides `match_time` (start) but not end time, so `main_duration_mins` fills
the gap.

---

## Audience Model

Each calendar entry declares its audience. The audience is the primary input to
slideshow entry predicates.

```json
"audience": {
  "section": "senior",       // "senior" | "junior" | "all"
  "teams": ["1st-xi"],       // specific team IDs involved; empty for non-cricket events
  "label": null              // free text for hire/third-party identity
}
```

The player evaluates entries in priority order and uses the **first match** — the first
entry whose phase window covers the current time. Priority within a date:
`club_event` > `section_event` > `match` > `training` > `hire`.

If no entry covers the current time, the player falls back to the location's `default`
entry — the idle context. This is defined once per location in the calendar rather than
repeated on every date.

---

## Context Calendar

### Role

A single build-time output. The player fetches it once on load and re-evaluates the
current context against the clock. It covers all screen locations and all dates for which
schedule data is available.

### Inputs → Output

```
content/data/fixtures.json          ─┐
content/data/cs365_training.json    ─┤
content/events.json  (manual)       ─┼─→ build.py → site/context_calendar.json
content/config.json  (phase policy) ─┘
```

### Schema

Keyed by `location_id → { default, dates → date → [entries] }`. The `default` entry
is the idle fallback for that location — used whenever no dated entry covers the
current time. Entries within a date are ordered by priority (highest first) so the
player can take the first match.

```json
{
  "generated_at": "2026-05-11",
  "entries": {
    "the-witchell": {
      "default": {
        "type": "idle",
        "audience": { "section": "all", "teams": [], "label": null },
        "detail": {}
      },
      "dates": {
        "2026-05-10": [
          {
            "type": "match",
            "audience": { "section": "senior", "teams": ["1st-xi"], "label": null },
            "phases": {
              "warm_up":   { "start": "09:00", "end": "11:00" },
              "main":      { "start": "11:00", "end": "14:30" },
              "wind_down": { "start": "14:30", "end": "17:30" }
            },
            "detail": { "competition": "TVL Div 6C", "opposition": "Denham CC", "is_home": true }
          },
          {
            "type": "training",
            "audience": { "section": "junior", "teams": ["u11-incredibles", "u11-invincibles"], "label": null },
            "phases": {
              "warm_up":   { "start": "17:45", "end": "18:00" },
              "main":      { "start": "18:00", "end": "19:30" },
              "wind_down": { "start": "19:30", "end": "20:00" }
            },
            "detail": {}
          }
        ]
      }
    }
  }
}
```

The `default` entry also provides the anchor for idle countdown slides: the player
looks ahead in `dates` for the next entry at this location.

---

## Universal Slideshow: `pavilion-auto`

Both pavilion screens point here by default. It contains all slides, each with an
optional `show_when` audience predicate. The player shows a slide if:

1. The slide is globally active (not `active: false`, not past `expires`)
2. The `show_when` predicate on the slideshow entry matches the current context,
   or `show_when` is absent (slide always shows)

`show_when` is an **array of condition objects** evaluated as OR — the slide shows if
any condition is satisfied. Within a condition object, all fields must match (AND).
Field values that are arrays allow multiple options for that field (OR within field).

```json
{
  "title": "Pavilion Auto",
  "refresh_interval_seconds": 300,
  "slides": [
    { "slug": "club-photo" },
    { "slug": "sponsors" },
    { "slug": "batting-leaderboard-1st-xi",
      "show_when": [{ "section": ["senior"] }] },
    { "slug": "batting-leaderboard-2nd-xi",
      "show_when": [{ "section": ["senior"] }] },
    { "slug": "league-table-u11-incredibles",
      "show_when": [{ "section": ["junior"] }] },
    { "slug": "junior-camp",                 "expires": "2026-08-08" },
    { "slug": "next-activity",
      "show_when": [
        { "type": ["idle"] },
        { "type": ["match"], "teams": ["1st-xi"], "phase": ["warm_up"] }
      ] }
  ]
}
```

Slideshow entries carry no timing: each slide's duration is derived by the build
from its `panel_duration` (see `design-conventions.md`) and written into
`data.json`. The last entry illustrates OR: "show when idle, or when it is the
warm-up phase of a 1st XI match." `NOT` predicates are explicitly deferred.

Curated event slideshows remain supported. A screen can be pointed at a specific
slideshow for the duration of an event, bypassing `pavilion-auto` entirely.

---

## Screen Identity and Routing

Each screen bookmarks its location URL: `/screen/{location-id}/`
e.g. `/screen/the-witchell/` — same pattern as current `/slideshow/pavilion-1/`

Current screen locations (`screen: true` in `locations.json`): `the-witchell`, `tring-road`.

Migration: `/slideshow/pavilion-1/` remains live; migration to `/screen/the-witchell/`
can happen gradually once the smart player is built.

### Full routing path

```
Pi boots → opens /screen/the-witchell/
  → player.html loads; extracts locationId from URL
  → fetches context_calendar.json + locations.json
  → resolves context:
      scan calendar[locationId].dates[today] in priority order
      → first entry whose phase window covers now → active context
      → no match → idle; read default_context from locations[locationId]
  → determines slideshow:
      active calendar entry has slideshow override? → use that (curated event)
      else → use locations[locationId].slideshow ("pavilion-auto")
  → fetches slideshow data
  → filters slides by show_when predicates against active context
  → runs player
```

`locations.json` for a screen location carries the default slideshow and idle context:

```json
{
  "id": "the-witchell",
  "name": "The Witchell",
  "screen": true,
  "slideshow": "pavilion-auto",
  "default_context": { "section": "all" },
  "aliases": [...]
}
```

The `slideshow` override on a calendar entry only applies to curated events
(`club_event`, `section_event`). It originates in `events.json` and is embedded into
the calendar entry at build time, so the player fetches exactly two files at runtime:
`context_calendar.json` and `locations.json`.

---

## Smart Player

`templates/screen/player.html` fetches `context_calendar.json`, resolves the current
context, then filters the slideshow's entries against that context.

```javascript
async function init() {
    const [calendar, locations] = await Promise.all([
        fetch('/context_calendar.json').then(r => r.json()),
        fetch('/locations.json').then(r => r.json()),
    ]);
    const location = locations.locations.find(l => l.id === locationId);
    const { context, slideshowSlug } = resolveContext(calendar, location);
    const show = await fetch(`/slideshow/${slideshowSlug}/data.json`).then(r => r.json());
    const slides = show.slides.filter(s => matchesContext(s, context));
    runPlayer(slides);
    setTimeout(() => location.reload(), show.refresh_interval_seconds * 1000);
}

function resolveContext(calendar, location) {
    const today = new Date().toISOString().slice(0, 10);
    const timeNow = new Date().toTimeString().slice(0, 5);
    const entries = calendar.entries[location.id]?.dates?.[today] ?? [];

    for (const entry of entries)
        for (const [phase, window] of Object.entries(entry.phases))
            if (timeNow >= window.start && timeNow < window.end)
                return {
                    context: { type: entry.type, phase, audience: entry.audience, detail: entry.detail },
                    slideshowSlug: entry.slideshow ?? location.slideshow,
                };

    // No match — idle
    return {
        context: { type: 'idle', audience: location.default_context, next: findNext(calendar, location.id) },
        slideshowSlug: location.slideshow,
    };
}
```

The `runPlayer` / `showSlide` / `advance` logic is lifted from the existing `player.html`.

---

## Architecture

### Static site, no backend

All scheduling logic runs client-side. `build.py` pre-computes `context_calendar.json`
from fetched data sources and manual config. No per-screen schedule files; no server.

### Build steps

```
fetch_play_cricket.py   → content/data/league_table_*.json
fetch_player_stats.py   → content/data/player_stats_this_season.json
fetch_fixtures.py       → content/data/fixtures.json             ✓ done
fetch_cs365_training.py → content/data/cs365_training.json       ✓ done
build.py                → site/slide/{slug}/index.html           ✓ done
                        → site/slideshow/{slug}/index.html       ✓ done
                        → site/context_calendar.json             in progress
                        → site/screen/{id}/index.html            not started
```

---

## What Has Been Built

### Data pipeline (complete)

`scripts/fetch_fixtures.py` → `content/data/fixtures.json`

For each team in `teams.json`, fetches the next upcoming match plus the full future
schedule. Output keyed by `team_id`:

```json
{
  "generated_at": "...",
  "season": 2026,
  "fixtures":     { "1st-xi": { /* next match with opposition intelligence */ } },
  "all_fixtures": { "1st-xi": [ { /* slim future fixture records */ } ] }
}
```

`scripts/fetch_cs365_training.py` → `content/data/cs365_training.json`

Fetches actual sessions from ClubSports365 via Playwright for the next 8 weeks.
Each session has resolved `team_ids` and `location_id`:

```json
{
  "fetched_at": "...",
  "sessions": [
    {
      "date": "2026-05-08", "time_start": "18:00", "time_end": "19:30",
      "location_id": "the-witchell",
      "team_ids": ["u11-invincibles", "u11-incredibles"]
    }
  ]
}
```

### `content/locations.json` (partially complete)

Includes `screen: true` flag and `aliases` array for case-insensitive ground name
matching against CS365 and Play Cricket strings.

**Still needed** on screen locations: `slideshow` (default slideshow slug) and
`default_context` (idle audience — e.g. `{ "section": "all" }`).

### `content/teams.json` (partially complete)

All 18 teams have `play_cricket_team_id` and `cs365_team_name`.
**Still needed:** `home_location` and `section` per team.

### Existing slideshows (interim)

`pavilion-1.json` and `pavilion-2.json` — hand-curated, currently live. Will be
superseded by `pavilion-auto` once the smart player is built.

### CI / `deploy.yml` (complete)

Daily cron at `0 2 * * *` (02:00 UTC ≈ 03:00 BST). No further CI changes needed —
`context_calendar.json` is generated by `build.py`, which already runs in CI.

### Open questions (resolved)

- **Play Cricket `match_time`**: present in the API response.
- **Junior team Play Cricket IDs**: all 18 teams mapped in `teams.json`.
- **Multiple simultaneous activities**: union of audiences — less filtering, more slides.
- **Per-screen schedule files**: superseded by single `context_calendar.json`.
- **`slideshow_map.json`**: superseded by `show_when` predicates on slideshow entries.
- **Multiple activity-type slideshows**: superseded by single `pavilion-auto` slideshow.
- **Slide URL param parameterisation**: superseded by slideshow-entry predicates.
- **Migration path**: `/slideshow/pavilion-1/` stays live; `/screen/the-witchell/` added alongside.

---

## Files to Create / Modify

| File | Action | Status |
|------|--------|--------|
| `content/locations.json` | Add `slideshow` + `default_context` to screen locations | Partially done |
| `content/data/fixtures.json` | Generated by `fetch_fixtures.py` | ✓ Done |
| `content/data/cs365_training.json` | Generated by `fetch_cs365_training.py` | ✓ Done |
| `content/config.json` | Add `activity_phases` block | Not started |
| `content/events.json` | New — manual one-off events | Not started |
| `content/teams.json` | Add `home_location`, `section` per team | Not started |
| `content/slideshows/pavilion-auto.json` | New — universal slideshow with `show_when` predicates | Not started |
| `scripts/build.py` | Add `build_context_calendar()` | In progress |
| `templates/screen/player.html` | New — smart player | Not started |
| `site/context_calendar.json` | Generated output | Not started |
| `site/screen/{id}/index.html` | Generated screen pages | Not started |

---

## Open Questions

- **`show_when` predicate schema**: structure is agreed — array of condition objects
  (OR), fields within a condition AND'd, field values are arrays (OR within field).
  Supported fields (`type`, `section`, `teams`, `phase`) and exact matching semantics
  against the single active context still TBD.
- **Multiple simultaneous activities**: first-match-wins by priority order
  (`club_event` > `section_event` > `match` > `training` > `hire`). Union of audiences
  explicitly dropped.
- **`NOT` predicates**: deferred. Useful future addition (e.g. show this slide only
  when there is *not* a match in progress).
- **Match `main.end`**: derived from `match_time + main_duration_mins` (config). Is
  a configurable default per section sufficient, or do we need per-competition overrides?
- **Tring Road audience**: which teams call Tring Road home? Requires `home_location`
  on relevant teams before the calendar is meaningful for that screen.
- **`section` derivation**: can be heuristically inferred from team ID prefix (`u` →
  junior) until `teams.json` is updated with explicit `section` fields.
