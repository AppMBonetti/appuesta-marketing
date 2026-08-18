function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function startOfWeek(d) {
  // Monday-start week
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/**
 * Returns { current: {start, end}, previous: {start, end} | null } as ISO date strings.
 * `end` is exclusive (start of the day after the last included day) for clean timestamptz range queries.
 */
export function getPeriodRange(period, customStart, customEnd) {
  const now = new Date();

  if (period === "week") {
    const start = startOfWeek(now);
    const end = new Date(start); end.setDate(start.getDate() + 7);
    const prevStart = new Date(start); prevStart.setDate(start.getDate() - 7);
    return {
      current: { start: toISODate(start), end: toISODate(end) },
      previous: { start: toISODate(prevStart), end: toISODate(start) },
    };
  }

  if (period === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return {
      current: { start: toISODate(start), end: toISODate(end) },
      previous: { start: toISODate(prevStart), end: toISODate(start) },
    };
  }

  // custom
  const start = customStart;
  const endExclusive = customEnd ? toISODate(new Date(new Date(customEnd).getTime() + 86400000)) : customStart;
  return {
    current: { start, end: endExclusive },
    previous: null,
  };
}

/**
 * Monday-start week key (YYYY-MM-DD) for a date string, computed in UTC so a
 * date-only value never slides into the previous week in a negative-offset
 * timezone (Santo Domingo is UTC-4).
 */
export function weekStartOf(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() + ((day === 0 ? -6 : 1) - day));
  return dt.toISOString().slice(0, 10);
}

/** Budgets are tracked from August 2026 onward — nothing earlier was planned in this tool. */
export const BUDGET_START_MONTH = "2026-08-01";

/** First-of-month ISO dates from `start` up to `aheadMonths` past the current month. */
export function monthOptions(start = BUDGET_START_MONTH, aheadMonths = 6) {
  const [sy, sm] = start.split("-").map(Number);
  const now = new Date();
  const last = Date.UTC(now.getFullYear(), now.getMonth() + aheadMonths, 1);
  const out = [];
  let cur = Date.UTC(sy, sm - 1, 1);
  while (cur <= last) {
    const dt = new Date(cur);
    out.push(dt.toISOString().slice(0, 10));
    cur = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1);
  }
  return out;
}

/** The month to preselect: the current one, or the first tracked month if we're before it. */
export function currentBudgetMonth() {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  return thisMonth < BUDGET_START_MONTH ? BUDGET_START_MONTH : thisMonth;
}

export function formatMonth(isoMonth, lang) {
  const [y, m] = isoMonth.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(lang === "es" ? "es-DO" : "en-US", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
}

/** Short axis label for a week bucket, e.g. "11 ago". */
export function formatWeek(isoDate, lang) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(lang === "es" ? "es-DO" : "en-US", {
    day: "numeric", month: "short", timeZone: "UTC",
  });
}

/**
 * The Mondays that fall inside a given month. Matches how the weekly report is
 * laid out: a week belongs to the month its Monday falls in, so a week
 * straddling month end is not double-counted.
 */
export function weeksInMonth(monthISO) {
  const [y, m] = monthISO.split("-").map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, 1));
  while (cursor.getUTCDay() !== 1) cursor.setUTCDate(cursor.getUTCDate() + 1);
  const out = [];
  while (cursor.getUTCMonth() === m - 1) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return out;
}

export function previousWeek(weekISO) {
  const [y, m, d] = weekISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 7);
  return dt.toISOString().slice(0, 10);
}

/** "17/8 - 23/8" (es) or "8/17 - 8/23" (en) — the column header for a week. */
export function weekRangeLabel(weekISO, lang) {
  const [y, m, d] = weekISO.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 6));
  const fmt = dt => (lang === "es"
    ? `${dt.getUTCDate()}/${dt.getUTCMonth() + 1}`
    : `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`);
  return `${fmt(start)} - ${fmt(end)}`;
}
