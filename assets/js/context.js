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

  // How much of an upcoming phase window is hidden by a higher-priority
  // overlapping entry on the same date. Entries within a date are ordered
  // highest-priority first, so any entry at a lower index outranks this one
  // and the live player would resolve to it instead. Returns null (fully
  // shown), or { level: 'full' | 'partial', types: [...] }.
  function phaseMask(dateEntries, item) {
    const s = item.start.getTime();
    const e = item.end.getTime();
    const segs = [];
    dateEntries.forEach((entry, idx) => {
      if (idx >= item.entryIdx) return;            // not higher priority
      for (const phase of ['warm_up', 'main', 'wind_down']) {
        const win = entry.phases?.[phase];
        if (!win) continue;
        const a = Math.max(s, parsePhaseTime(item.dateStr, win.start).getTime());
        const b = Math.min(e, parsePhaseTime(item.dateStr, win.end).getTime());
        if (b > a) segs.push({ a, b, type: entry.type });
      }
    });
    if (!segs.length) return null;
    segs.sort((x, y) => x.a - y.a);
    const types = [...new Set(segs.map(g => g.type))];
    // Sweep from the window start to see how far higher-priority windows
    // cover it contiguously; if they reach the end it is fully masked.
    let reach = s;
    for (const g of segs) {
      if (g.a > reach) break;                       // gap → some of the window is visible
      reach = Math.max(reach, g.b);
    }
    return { level: reach >= e ? 'full' : 'partial', types };
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
      locDates[dateStr].forEach((entry, entryIdx) => {
        for (const phase of ['warm_up', 'main', 'wind_down']) {
          const win = entry.phases?.[phase];
          if (!win) continue;
          if (dateStr === today && win.start <= timeNow) continue;
          upcoming.push({
            type: entry.type, phase, entry, dateStr, entryIdx,
            start: parsePhaseTime(dateStr, win.start),
            end: parsePhaseTime(dateStr, win.end),
          });
        }
      });
    }
    upcoming.sort((a, b) => a.start - b.start);

    // Annotate each window with whether a higher-priority overlap masks it.
    for (const item of upcoming) {
      item.masked = phaseMask(locDates[item.dateStr], item);
    }

    // Insert idle only where no window covers the gap. Track the furthest
    // covered point so overlapping windows don't open a phantom idle (e.g. a
    // short session nested inside a longer match).
    const results = [];
    let reach = null;
    for (const cur of upcoming) {
      if (reach && cur.start > reach) {
        results.push({ type: 'idle', start: reach, end: cur.start });
      }
      results.push(cur);
      if (!reach || cur.end > reach) reach = cur.end;
    }
    return results;
  }

  return { parsePhaseTime, resolveContext, ctxFromNext, findNextContexts };
})();
