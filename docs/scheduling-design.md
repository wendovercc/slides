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
e.g. `/screen/ground1/` — same pattern as current `/slideshow/pavilion-1/`

---

## Architecture

### Static site, no backend

All scheduling logic runs **client-side in JavaScript**. The build pipeline pre-computes
a `schedule.json` per location that the player fetches and evaluates against the current clock.

### New build steps

```
fetch_fixtures.py            → content/data/fixtures.json
generate_screen_schedules.py → content/screens/{id}.json  (per location, gitignored)
build.py (extended)          → site/screen/{id}/index.html + schedule.json
```

### New player template

`templates/screen/player.html` — smart player that:
1. Fetches `./schedule.json`
2. Evaluates context from current time (events → fixtures → training → idle)
3. Selects the matching slideshow
4. Builds iframes, appending URL params (`?team=1st-xi&competition_id=135855`) to slides
   that declare `context_params`
5. Reloads on `refresh_interval_seconds` to re-evaluate context

---

## New Config Files

### `content/locations.json`
```json
{
  "locations": [
    { "id": "ground1", "name": "Main Ground", "default_section": "senior" },
    { "id": "ground2", "name": "Second Ground", "default_section": "senior" }
  ]
}
```

### `content/training.json`
Recurring weekly sessions. Times are local (UK). Weekday uses ISO numbering (Mon=1, Sun=7).
```json
{
  "sessions": [
    {
      "id": "seniors-tuesday",
      "label": "Senior Training",
      "location": "ground1",
      "section": "senior",
      "weekday": 2,
      "start_time": "18:00",
      "end_time": "20:30",
      "valid_from": "2026-04-01",
      "valid_until": "2026-09-30"
    }
  ]
}
```

### `content/events.json`
One-off special events. Each event specifies its own slideshow directly.
```json
{
  "events": [
    {
      "id": "club-day-2026",
      "label": "Club Day",
      "location": "ground1",
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

### `content/slideshow_map.json`
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
  "home_location": "ground1",
  "section": "senior",
  "...": "...existing fields..."
}
```

---

## New Scripts

### `scripts/fetch_fixtures.py`

Calls `matches.json?site_id=X&season=Y` (same endpoint as `fetch_player_stats.py`).
For each fixture involving our teams, resolves: is_home, location (from team's `home_location`),
match window (`match_time − 2h` to `match_time + 8h`). Defaults: seniors `11:00`, juniors `10:00`
(configurable in `config.json` under `"defaults"`).

Output `content/data/fixtures.json`:
```json
{
  "generated_at": "...",
  "season": 2026,
  "fixtures": [
    {
      "match_id": "...",
      "match_date": "2026-05-10",
      "match_time": "13:00",
      "window_start": "11:00",
      "window_end": "21:00",
      "location": "ground1",
      "is_home": true,
      "section": "senior",
      "teams": ["1st-xi"],
      "competition_id": "135855",
      "competition_name": "Thames Valley Cricket League Div 6C",
      "opposition": "Denham CC"
    }
  ]
}
```

### `scripts/generate_screen_schedules.py`

For each location in `content/locations.json`, combines fixtures + training + events,
resolves slideshow slugs via `content/slideshow_map.json`, and inlines the relevant
slideshow configs. Outputs `content/screens/{location_id}.json`.

Per-screen schedule.json structure:
```json
{
  "screen_id": "ground1",
  "screen_name": "Main Ground",
  "generated_at": "...",
  "default_slideshow": "default-senior",
  "slideshows": {
    "default-senior": {
      "refresh_interval_seconds": 300,
      "slides": [
        { "slug": "batting-leaderboard", "duration": 20, "context_params": ["team", "competition_id"] },
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
      "weekday": 2, "start_time": "18:00", "end_time": "20:30",
      "valid_from": "2026-04-01", "valid_until": "2026-09-30",
      "slideshow": "training-senior",
      "context": { "activity_type": "training", "section": "senior" }
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

---

## Smart Player: `templates/screen/player.html`

Client-side scheduling logic:

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
    const weekday = now.getDay() || 7;               // ISO: Mon=1, Sun=7

    for (const ev of schedule.events)
        if (ev.date === today && timeNow >= ev.start_time && timeNow <= ev.end_time)
            return { slideshowSlug: ev.slideshow, context: ev.context };

    for (const fx of schedule.fixtures)
        if (fx.match_date === today && timeNow >= fx.window_start && timeNow <= fx.window_end)
            return { slideshowSlug: fx.slideshow, context: fx.context };

    for (const tr of schedule.training)
        if (tr.valid_from <= today && today <= tr.valid_until
                && tr.weekday === weekday
                && timeNow >= tr.start_time && timeNow <= tr.end_time)
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

The `runPlayer` / `showSlide` / `advance` logic is lifted verbatim from the existing `player.html`.

---

## Slide Parameterisation

Slides that declare `context_params` receive URL query params from the player,
e.g. `/slide/batting-leaderboard/?team=1st-xi&competition_id=135855`.

The slide templates (leaderboards, league-table) need a small JS addition that re-filters
the already-baked data if params are present. Slides without params work unchanged.
Existing standalone slide URLs remain valid.

---

## CI Changes: `.github/workflows/deploy.yml`

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
  schedule:
    - cron: '0 5 * * *'   # 06:00 BST daily — picks up newly published fixtures

# New steps (after existing fetch_player_stats step):
- run: python scripts/fetch_fixtures.py
  env:
    PLAY_CRICKET_API_TOKEN: ${{ secrets.PLAY_CRICKET_API_TOKEN }}
    PLAY_CRICKET_SITE_ID: ${{ secrets.PLAY_CRICKET_SITE_ID }}

- run: python scripts/generate_screen_schedules.py
```

---

## Files to Create / Modify

| File | Action |
|------|--------|
| `content/locations.json` | New |
| `content/training.json` | New |
| `content/events.json` | New |
| `content/slideshow_map.json` | New |
| `content/teams.json` | Extend: add `home_location`, `section` per team |
| `scripts/fetch_fixtures.py` | New |
| `scripts/generate_screen_schedules.py` | New |
| `scripts/build.py` | Add `build_screens()`, call in `main()` |
| `templates/screen/player.html` | New — smart player |
| `templates/slides/batting-leaderboard.html` | Add URL param filtering |
| `templates/slides/bowling-leaderboard.html` | Add URL param filtering |
| `templates/slides/league-table.html` | Add URL param filtering |
| `.github/workflows/deploy.yml` | Add cron trigger + 2 new steps |
| `.gitignore` | Add `content/screens/`, `content/data/fixtures.json` |

## New Slideshow Configs Needed

Minimal set (all use existing JSON schema in `content/slideshows/`):
- `default-senior.json`
- `default-junior.json`
- `match-day-senior.json`
- `match-day-junior.json`
- `training-senior.json`
- `training-junior.json`

---

## Open Questions

- Does Play Cricket's `matches.json` include `match_time`? If not, defaults apply.
- Junior teams in Play Cricket — need their `play_cricket_team_id` values to detect junior match days.
- Should there be a "next fixture" slide that shows upcoming matches outside match-day windows?
- The existing `/slideshow/pavilion-1/` URL can remain working; migration to `/screen/ground1/` can be gradual.
