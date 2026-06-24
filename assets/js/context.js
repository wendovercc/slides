/* context.js — shared schedule/context resolution.
 *
 * Reads context_calendar.json (built daily) + a location object to work out
 * what a screen is showing now and what comes next. Used by the screen player
 * (slide selection + ?preview panel) and the home page (screen card summaries).
 */
window.WccContext = (function () {
  function parsePhaseTime(dateStr, timeStr) {
    if (timeStr === '24:00') {
      const d = new Date(`${dateStr}T00:00:00`);
      d.setDate(d.getDate() + 1);
      return d;
    }
    return new Date(`${dateStr}T${timeStr}:00`);
  }

  function resolveContext(calendar, loc) {
    const today = new Date().toISOString().slice(0, 10);
    const timeNow = new Date().toTimeString().slice(0, 5);
    const entries = calendar.entries?.[loc.id]?.dates?.[today] ?? [];

    for (const entry of entries) {
      for (const [phase, win] of Object.entries(entry.phases)) {
        if (timeNow >= win.start && timeNow < win.end) {
          return {
            context: { type: entry.type, phase, audience: entry.audience, detail: entry.detail },
            slideshowSlug: entry.slideshow ?? loc.slideshow,
            contextStart: win.start,
            contextEnd: parsePhaseTime(today, win.end),
          };
        }
      }
    }
    return {
      context: { type: 'idle', phase: null, audience: loc.default_context ?? { section: 'all' }, detail: {} },
      slideshowSlug: loc.slideshow,
      contextEnd: null,
    };
  }

  function ctxFromNext(nc, loc) {
    if (nc.type === 'idle') {
      return { type: 'idle', phase: null, audience: loc.default_context ?? { section: 'all' }, detail: {} };
    }
    return { type: nc.type, phase: nc.phase, audience: nc.entry.audience, detail: nc.entry.detail };
  }

  function findNextContexts(calendar, locId) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const timeNow = now.toTimeString().slice(0, 5);
    const cutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const locDates = calendar.entries?.[locId]?.dates ?? {};

    const upcoming = [];
    for (const dateStr of Object.keys(locDates).sort()) {
      if (dateStr < today || dateStr > cutoff) continue;
      for (const entry of locDates[dateStr]) {
        for (const phase of ['warm_up', 'main', 'wind_down']) {
          const win = entry.phases?.[phase];
          if (!win) continue;
          if (dateStr === today && win.start <= timeNow) continue;
          upcoming.push({
            type: entry.type, phase, entry, dateStr,
            start: parsePhaseTime(dateStr, win.start),
            end: parsePhaseTime(dateStr, win.end),
          });
        }
      }
    }
    upcoming.sort((a, b) => a.start - b.start);

    const results = [];
    for (let i = 0; i < upcoming.length; i++) {
      const prev = upcoming[i - 1];
      const cur = upcoming[i];
      if (prev && cur.start > prev.end) {
        results.push({ type: 'idle', start: prev.end, end: cur.start });
      }
      results.push(cur);
    }
    return results;
  }

  return { parsePhaseTime, resolveContext, ctxFromNext, findNextContexts };
})();
