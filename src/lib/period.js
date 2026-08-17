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
