import { weekStartOf } from "./period";

/**
 * `players` only ever holds current cumulative totals, so a per-week figure is
 * the difference between consecutive daily snapshots. The earliest week has no
 * predecessor to subtract, so it is dropped rather than reported as if the whole
 * running total had been deposited that week.
 */
export function weeklyFromSnapshots(dailyTotals, field) {
  const byWeek = new Map();
  for (const row of [...dailyTotals].sort((a, b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)))) {
    byWeek.set(weekStartOf(row.snapshot_date), Number(row[field]) || 0);
  }
  const weeks = [...byWeek.keys()].sort();
  const out = [];
  let previous = null;
  for (const week of weeks) {
    const cumulative = byWeek.get(week);
    if (previous != null) out.push({ week, value: Math.max(0, cumulative - previous) });
    previous = cumulative;
  }
  return out;
}

/** Rolls daily GA4 rows into one row per channel for the selected period. */
export function aggregateByChannel(rows) {
  const m = new Map();
  for (const r of rows) {
    const g = m.get(r.channel) || { channel: r.channel, sessions: 0, active_users: 0, engagedSessions: 0, conversions: 0 };
    g.sessions += r.sessions || 0;
    g.active_users += r.active_users || 0;
    // Engagement rate is a per-row ratio, so it is re-weighted by sessions —
    // averaging the daily rates directly would over-weight low-traffic days.
    g.engagedSessions += (r.engagement_rate || 0) * (r.sessions || 0);
    g.conversions += r.conversions || 0;
    m.set(r.channel, g);
  }
  return [...m.values()]
    .map(g => ({ ...g, engagement_rate: g.sessions > 0 ? g.engagedSessions / g.sessions : 0 }))
    .sort((a, b) => b.sessions - a.sessions);
}

/** Daily sessions pivoted into one series per channel, for the stacked area chart. */
export function pivotSessionsByDate(rows) {
  const dates = [...new Set(rows.map(r => r.date))].sort();
  const channels = [...new Set(rows.map(r => r.channel))];
  const byKey = new Map(rows.map(r => [`${r.date}|${r.channel}`, r.sessions || 0]));
  return dates.map(date => {
    const row = { date };
    channels.forEach(ch => { row[ch] = byKey.get(`${date}|${ch}`) || 0; });
    return row;
  });
}
