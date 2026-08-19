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

const ratio = (numerator, denominator) =>
  (numerator != null && denominator != null && Number(denominator) !== 0
    ? Number(numerator) / Number(denominator)
    : null);

const num = v => (v == null ? null : Number(v));

/**
 * Expands one weekly_kpis row into every figure the weekly report shows. Ratios
 * are derived here rather than in SQL so a null input propagates to "—" instead
 * of a misleading zero, and so each metric's formatting and direction stay
 * beside its definition.
 */
export function deriveWeeklyKpis(row) {
  const spend = num(row?.spend);
  const sessions = num(row?.sessions);
  const registrations = num(row?.registrations);
  const ftds = num(row?.ftds);
  const ftdRevenue = num(row?.ftd_revenue);
  // How many of the week's FTDs have a known first-deposit value. The average
  // must divide by that, not by every FTD, or an incomplete week reads low.
  const ftdRevenueKnown = num(row?.ftd_revenue_known);
  const depositCount = num(row?.deposit_count);
  const depositAmount = num(row?.deposit_amount);
  const depositors = num(row?.depositors);
  const ggr = num(row?.ggr);
  // Players who actually wagered that week — the correct denominator for ARPU.
  // Depositors was wrong twice over: it counted only people who topped up, and
  // it was divided into an all-time GGR figure.
  const activePlayers = num(row?.active_players);
  const arpuMedian = num(row?.median_ggr_per_player);

  return {
    spend, sessions, registrations, ftds, ftdRevenue, ftdRevenueKnown,
    depositCount, depositAmount, depositors, ggr, activePlayers, arpuMedian,
    ftdRevenueCoverage: ratio(ftdRevenueKnown, ftds),
    costPerSession: ratio(spend, sessions),
    costPerRegistration: ratio(spend, registrations),
    costPerAcquisition: ratio(spend, ftds),
    avgFtdValue: ratio(ftdRevenue, ftdRevenueKnown),
    roasDeposits: ratio(depositAmount, spend),
    roasGgr: ratio(ggr, spend),
    trafficToRegistration: ratio(registrations, sessions),
    registrationToDeposit: ratio(ftds, registrations),
    arpu: ratio(ggr, activePlayers),
  };
}

/**
 * Row definitions for the weekly report. `better` drives the red/green on the
 * week-over-week cell — spend has no inherent direction, and a cheaper cost per
 * acquisition is an improvement, so it cannot be inferred from the sign alone.
 */
export const WEEKLY_KPI_GROUPS = [
  {
    id: "traffic",
    rows: [
      { key: "spend", format: "money", better: null, editable: true },
      { key: "sessions", format: "int", better: "up" },
      { key: "registrations", format: "int", better: "up" },
      { key: "costPerSession", format: "money2", better: "down" },
    ],
  },
  {
    id: "revenue",
    rows: [
      { key: "ftds", format: "int", better: "up" },
      { key: "ftdRevenue", format: "money", better: "up", coverageOf: "ftds", coverageCount: "ftdRevenueKnown" },
      { key: "avgFtdValue", format: "money", better: "up" },
      { key: "depositCount", format: "int", better: "up" },
      { key: "depositAmount", format: "money", better: "up" },
      { key: "depositors", format: "int", better: "up" },
      { key: "ggr", format: "money", better: "up" },
      { key: "activePlayers", format: "int", better: "up" },
      { key: "arpu", format: "money", better: "up" },
      { key: "arpuMedian", format: "money", better: "up" },
    ],
  },
  {
    id: "business",
    rows: [
      { key: "costPerRegistration", format: "money2", better: "down" },
      { key: "costPerAcquisition", format: "money2", better: "down" },
      { key: "roasDeposits", format: "x", better: "up" },
      { key: "roasGgr", format: "x", better: "up" },
      { key: "trafficToRegistration", format: "pct", better: "up" },
      { key: "registrationToDeposit", format: "pct", better: "up" },
    ],
  },
];

/** Week-over-week change. Null when there is no comparable base to divide by. */
export function wowChange(current, previous) {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
