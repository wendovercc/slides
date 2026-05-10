# Scheduling & Intelligence Layer — Design

## Problem

Displays currently show static, hardcoded slideshows. The goal is for each screen to show
contextually relevant content based on **time + location**, with the system computing what's
happening (match, training, event, idle) and personalising the slideshow accordingly —
including filtering stats slides to the relevant team/competition.

## Algorithm

**Inputs:** time + location  
**Outputs:** context object → slideshow selection + slide parameterisation

### Context Object

| Field | Values | Notes |
|-------|--------|-------|
| `activity_type` | `match` \| `training` \| `event` \| `idle` | Primary output |
| `section` | `senior` \| `junior` | From team/session config |
| `teams` | `["1st-xi"]` | Team IDs involved |
| `competition_id` | Play Cricket ID | Matches only |
| `competition_name` | e.g. "TVL Div 6C" | Matches only |
| `opposition` | e.g. "Denham CC" | Matches only |
| `is_home` | boolean | Matches only |
| `group_label` | e.g. "U11s" | Training only |
| `event_label` | e.g. "Club Day" | Events only |

**Priority:** Event > Match > Training > Idle

### Screen Identity

Each screen/device bookmarks its own URL: `/screen/{location-id}/`
e.g. `/screen/the-witchell/` — same pattern as current `/slideshow/pavilion-1/`

---

## What Has Been Built

### Data pipeline (complete)

`scripts/fetch_fixtures.py` → `content/data/fixtures.json`

Runs in CI. For each team in `teams.json`, fetches the next upcoming match plus the
full future schedule for the season. Output is a dict keyed by `team_id`, not an array:

```json
{
  "generated_at": "...",
  "season": 2026,
  "fixtures": {
    "1st-xi": {
      "match_date": "10/05/2026",
      "match_time": "13:00",
      "ground_name": "Witchell Ground, Wendover",
      "competition_id": "135855",
      "competition_name": "Thames Valley Cricket League...",
      "is_home": true,
      "opposition_name": "...",
      "opposition_club_name": "...",
      "opposition_team_id": "...",
      "opposition_site_id": "...",
      "opposition_form": ["W", "L", "W", "W", "D"],
      "opposition_players": { "batting": [...], "bowling": [...] }
    }
  },
  "all_fixtures": {
    "1st-xi": [
      { "match_date": "10/05/2026", "match_time": "13:00", "ground_name": "...",
        "competition_name": "...", "is_home": true,
        "opposition_club_name": "...", "opposition_team_name": "..." }
    ]
  }
}
```

Note: `fixtures` (next match per team, with opposition intelligence) and `all_fixtures`
(full future schedule per team, slim records) are separate. The `match_time` field is
present in Play Cricket data (open question resolved).

`scripts/fetch_cs365_training.py` → `content/data/cs365_training.json`

This replaces the original design's `content/training.json` (hardcoded recurring rules).
Instead, actual sessions are fetched from ClubSports365 via Playwright for the next 8
weeks. Each session record includes resolved `team_ids` and `location_id`:

```json
{
  "fetched_at": "...",
  "sessions": [
    {
      "title": "Under 11s Outdoor training",
      "teams_raw": "U11 Invincibles, U11 Incredibles, U11 squad",
      "date": "2026-05-08",
      "time_start": "18:00",
      "time_end": "19:30",
      "location": "Witchell Ground, Wendover",
      "session_id": "09004A60800C39F8",
      "team_ids": ["u11-invincibles", "u11-incredibles"],
      "location_id": "the-witchell"
    }
  ]
}
```

### `content/locations.json` (built, extended beyond original design)

The original design only had `id` and `name`. The actual file adds:
- `screen: true` — flags which locations have physical displays
- `aliases` — array of alternate spellings used by CS365 and Play Cricket, used for
  location matching during build (case-insensitive lookup)

Current screen locations: `the-witchell`, `tring-road`.

### `content/teams.json` (partially updated)

All teams now have `play_cricket_team_id` and `cs365_team_name` — this solved the open
question about junior team IDs. All 18 senior and junior teams are mapped.

**Still needed:** `home_location` and `section` per team entry (required by the smart player).

### Schedule slides (`templates/slides/schedule.html`, built)

`build.py` already generates schedule slides showing upcoming training + matches. Slides
can be scoped by `team`, a list of `teams`, or `location`. The schedule slide for
`schedule-the-witchell.json` (mode: location) shows all events at The Witchell —
home matches + training sessions for all teams who use that ground.

This gives a human-readable view of the location's upcoming schedule, and demonstrates
that the data pipeline is working end-to-end.

### CI / `deploy.yml` (complete)

`fetch_fixtures.py` and `fetch_cs365_training.py` are both wired up. Daily cron runs
at `0 2 * * *` (02:00 UTC). Original design proposed 06:00 BST — 02:00 UTC achieves
the same effect.

### Open questions (resolved)

- **Play Cricket `match_time`**: present in the API response (may be null for some fixtures; defaults apply).
- **Junior team Play Cricket IDs**: all 18 teams are now mapped in `teams.json`.
- **Next-fixture slides**: built — `next-match-*.json` slides for every team.
- **Migration path**: `/slideshow/pavilion-1/` remains live; migration to `/screen/the-witchell/` can be gradual.

---

## Architecture

### Static site, no backend

All scheduling logic runs **client-side in JavaScript**. The build pipeline pre-computes
a `schedule.json` per screen location that the player fetches and evaluates against the
current clock.

### Build steps

```
fetch_play_cricket.py        → content/data/league_table_*.json
fetch_player_stats.py        → content/data/player_stats_this_season.json
fetch_fixtures.py            → content/data/fixtures.json          ✓ done
fetch_cs365_training.py      → content/data/cs365_training.json    ✓ done
generate_screen_schedules.py → content/screens/{id}.json  (per screen, gitignored)
build.py (extended)          → site/screen/{id}/index.html + schedule.json
```

### Smart player template

`templates/screen/player.html` — fetches `./schedule.json`, evaluates context from
current time, selects slideshow, builds iframes with URL params.

---

## Remaining Config Files

### `content/events.json` (not yet created)
One-off special events. Each event specifies its own slideshow directly.
```json
{
  "events": [
    {
      "id": "club-day-2026",
      "label": "Club Day",
      "location": "the-witchell",
      "date": "2026-07-12",
      "start_time": "11:00",
      "end_time": "20:00",
      "activity_type": "club_event",
      "slideshow": "event-club-day",
      "affects_all_sections": true
    }
  ]
}
```

### `content/slideshow_map.json` (not yet created)
Maps `activity_type.section` to a slideshow slug (events use their own `slideshow` field instead).
```json
{
  "match.senior": "match-day-senior",
  "match.junior": "match-day-junior",
  "training.senior": "training-senior",
  "training.junior": "training-junior",
  "idle.senior": "default-senior",
  "idle.junior": "default-junior",
  "idle": "default"
}
```

### Extend `content/teams.json`
Add `home_location` and `section` to each team entry:
```json
{
  "id": "1st-xi",
  "home_location": "the-witchell",
  "section": "senior",
  "...": "...existing fields..."
}
```

### `content/slideshows/` — new slideshow configs needed
Minimal set (all use existing JSON schema):
- `default-senior.json`
- `default-junior.json`
- `match-day-senior.json`
- `match-day-junior.json`
- `training-senior.json`
- `training-junior.json`

---

## New Scripts

### `scripts/generate_screen_schedules.py`

For each location in `content/locations.json` where `screen: true`, combines
`content/data/fixtures.json` + `content/data/cs365_training.json` + `content/events.json`,
resolves slideshow slugs via `content/slideshow_map.json`, and inlines the relevant
slideshow configs. Outputs `content/screens/{location_id}.json`.

Key difference from original design: training comes from `cs365_training.json` (fetched
actual sessions) rather than recurring weekly rules. The generator reads the fetched JSON
directly — no need to re-evaluate weekday/date rules client-side.

Per-screen schedule.json structure:
```json
{
  "screen_id": "the-witchell",
  "screen_name": "The Witchell",
  "generated_at": "...",
  "default_slideshow": "default-senior",
  "slideshows": {
    "default-senior": {
      "refresh_interval_seconds": 300,
      "slides": [
        { "slug": "batting-leaderboard-1st-xi", "duration": 20, "context_params": ["team", "competition_id"] },
        { "slug": "league-table-1st-xi", "duration": 20 },
        { "slug": "sponsors", "duration": 15 }
      ]
    },
    "match-day-senior": {
      "refresh_interval_seconds": 60,
      "slides": ["..."]
    }
  },
  "fixtures": [
    {
      "match_date": "2026-05-10",
      "window_start": "11:00",
      "window_end": "21:00",
      "slideshow": "match-day-senior",
      "context": {
        "activity_type": "match", "section": "senior",
        "teams": ["1st-xi"], "competition_id": "135855",
        "competition_name": "Thames Valley Cricket League Div 6C",
        "opposition": "Denham CC", "is_home": true
      }
    }
  ],
  "training": [
    {
      "date": "2026-05-08",
      "start_time": "18:00",
      "end_time": "19:30",
      "slideshow": "training-junior",
      "context": {
        "activity_type": "training", "section": "junior",
        "teams": ["u11-invincibles", "u11-incredibles"],
        "group_label": "U11s"
      }
    }
  ],
  "events": [
    {
      "date": "2026-07-12", "start_time": "11:00", "end_time": "20:00",
      "slideshow": "event-club-day",
      "context": { "activity_type": "club_event", "event_label": "Club Day" }
    }
  ]
}
```

Note: `training` entries are now concrete dated sessions (from CS365), not recurring
weekly rules. The client-side player can do simple date/time string comparisons with
no weekday arithmetic.

---

## Smart Player: `templates/screen/player.html`

Client-side scheduling logic. All comparisons use `"YYYY-MM-DD"` ISO strings:

```javascript
async function init() {
    const schedule = await fetch('./schedule.json').then(r => r.json());
    const { slideshowSlug, context } = resolveContext(schedule);
    const show = schedule.slideshows[slideshowSlug];
    buildIframes(show, context);
    runPlayer(show);
    setTimeout(() => location.reload(), show.refresh_interval_seconds * 1000);
}

function resolveContext(schedule) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);   // "YYYY-MM-DD"
    const timeNow = now.toTimeString().slice(0, 5);  // "HH:MM"

    for (const ev of schedule.events)
        if (ev.date === today && timeNow >= ev.start_time && timeNow <= ev.end_time)
            return { slideshowSlug: ev.slideshow, context: ev.context };

    for (const fx of schedule.fixtures)
        if (fx.match_date === today && timeNow >= fx.window_start && timeNow <= fx.window_end)
            return { slideshowSlug: fx.slideshow, context: fx.context };

    for (const tr of schedule.training)
        if (tr.date === today && timeNow >= tr.start_time && timeNow <= tr.end_time)
            return { slideshowSlug: tr.slideshow, context: tr.context };

    return { slideshowSlug: schedule.default_slideshow, context: { activity_type: 'idle' } };
}

function buildIframes(show, context) {
    show.slides.forEach((slide, i) => {
        const params = new URLSearchParams();
        (slide.context_params || []).forEach(key => {
            const val = key === 'team' ? (context.teams || [])[0] : context[key];
            if (val) params.set(key, val);
        });
        const qs = params.toString() ? '?' + params.toString() : '';
        const iframe = document.createElement('iframe');
        iframe.src = `/slide/${slide.slug}/${qs}`;
        iframe.id = `frame-${i}`;
        document.body.appendChild(iframe);
    });
}
```

Note: the training loop no longer needs weekday arithmetic — entries are dated concrete
sessions from CS365, so a simple `tr.date === today` comparison suffices.

The `runPlayer` / `showSlide` / `advance` logic is lifted from the existing `player.html`.

---

## Slide Parameterisation

Slides that declare `context_params` receive URL query params from the player,
e.g. `/slide/batting-leaderboard/?team=1st-xi&competition_id=135855`.

The slide templates (leaderboards, league-table) need a small JS addition that re-filters
the already-baked data if params are present. Slides without params work unchanged.
Existing standalone slide URLs remain valid.

---

## CI Changes: `.github/workflows/deploy.yml`

Already updated. Current state:

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
  schedule:
    - cron: '0 2 * * *'   # 02:00 UTC daily (≈ 03:00 BST) — picks up newly published fixtures

# Already present:
- run: python scripts/fetch_fixtures.py
  env:
    PLAY_CRICKET_API_TOKEN: ${{ secrets.PLAY_CRICKET_API_TOKEN }}
    PLAY_CRICKET_SITE_ID: ${{ secrets.PLAY_CRICKET_SITE_ID }}

- run: python scripts/fetch_cs365_training.py
  env:
    CS365_USERNAME: ${{ secrets.CS365_USERNAME }}
    CS365_PASSWORD: ${{ secrets.CS365_PASSWORD }}

# Still to add:
- run: python scripts/generate_screen_schedules.py
```

---

## Files to Create / Modify

| File | Action | Status |
|------|--------|--------|
| `content/locations.json` | New (with aliases + screen flag) | ✓ Done |
| `content/data/fixtures.json` | Generated by fetch_fixtures.py | ✓ Done |
| `content/data/cs365_training.json` | Generated by fetch_cs365_training.py | ✓ Done |
| `content/events.json` | New | Not started |
| `content/slideshow_map.json` | New | Not started |
| `content/teams.json` | Add `home_location`, `section` per team | Not started |
| `scripts/generate_screen_schedules.py` | New | Not started |
| `scripts/build.py` | Add `build_screens()`, call in `main()` | Not started |
| `templates/screen/player.html` | New — smart player | Not started |
| `templates/slides/batting-leaderboard.html` | Add URL param filtering | Not started |
| `templates/slides/bowling-leaderboard.html` | Add URL param filtering | Not started |
| `templates/slides/league-table.html` | Add URL param filtering | Not started |
| `.github/workflows/deploy.yml` | Add `generate_screen_schedules` step | Not started |
| `.gitignore` | Add `content/screens/` | Not started |
| `content/slideshows/default-senior.json` | New | Not started |
| `content/slideshows/default-junior.json` | New | Not started |
| `content/slideshows/match-day-senior.json` | New | Not started |
| `content/slideshows/match-day-junior.json` | New | Not started |
| `content/slideshows/training-senior.json` | New | Not started |
| `content/slideshows/training-junior.json` | New | Not started |

Note: `content/training.json` (hardcoded recurring rules) is **not needed** — replaced
by the fetched `content/data/cs365_training.json`.

---

## Open Questions

- **Multiple simultaneous activities**: if seniors are playing a match and juniors are
  training at The Witchell at the same time, which context wins? Current priority is
  Event > Match > Training — but should the screen cycle between both contexts?
- **Training with mixed age groups**: CS365 sessions often include multiple teams
  (`U11 Invincibles, U11 Incredibles`). The `section` for a mixed-section screen
  defaults to `junior` if any junior team is present; otherwise `senior`.
- **Match window defaults**: seniors `match_time − 2h` to `match_time + 8h`; juniors
  `match_time − 1h` to `match_time + 5h`. Configurable in `config.json` under `"defaults"`.
- **Tring Road screen**: second screen location. Does it show junior-only content?
  Needs `home_location` populated on the relevant teams.
