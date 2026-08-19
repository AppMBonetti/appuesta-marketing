import { parseXlsxFile, toISODateOnly, toNumber, toText } from "./parseWorkbook";

// Normalized headers from a Supermetrics GA4 export -> ga4_channel_daily columns.
// normalizeHeader() collapses camelCase, so the API field ids Supermetrics can
// emit ("sessionDefaultChannelGrouping") and the display names it uses by
// default ("Session default channel grouping") both land on the same key.
const HEADER_MAP = {
  "date": "date",
  "day": "date",
  "session default channel grouping": "channel",
  "default channel grouping": "channel",
  "first user default channel grouping": "channel",
  "channel grouping": "channel",
  "channel": "channel",
  "sessions": "sessions",
  "active users": "active_users",
  "total users": "active_users",
  "users": "active_users",
  "engagement rate": "engagement_rate",
  "conversions": "conversions",
  "conversions float": "conversions",
  "key events": "conversions",
};

const REQUIRED_FIELDS = ["date", "channel"];

/**
 * GA4 reports engagement rate as a 0–1 fraction, but a spreadsheet export may
 * carry it already multiplied out ("76.52%" or 76.52). A rate can never exceed
 * 1, so anything above that is a percentage and gets scaled back down.
 */
function toEngagementRate(rawValue) {
  const n = toNumber(rawValue);
  if (n == null) return null;
  const looksLikePercent = n > 1 || /%/.test(String(rawValue ?? ""));
  return looksLikePercent ? n / 100 : n;
}

export async function parseGa4File(file) {
  const { rows, matchedHeaders, unmatchedHeaders } = await parseXlsxFile(file, HEADER_MAP);

  const missingRequired = REQUIRED_FIELDS.filter(f => !matchedHeaders.some(h => HEADER_MAP[h] === f));
  if (missingRequired.length) {
    throw new Error(`Missing required column(s) in GA4 file: ${missingRequired.join(", ")}`);
  }

  // A Supermetrics export can repeat a (date, channel) pair when the query
  // carried an extra dimension the dashboard doesn't store — sum those rows
  // rather than letting the last one win, and keep the upsert key unique.
  const merged = new Map();
  let earliest = null;
  let latest = null;

  for (const r of rows) {
    const date = toISODateOnly(r.date);
    const channel = toText(r.channel);
    if (!date || !channel) continue;

    if (!earliest || date < earliest) earliest = date;
    if (!latest || date > latest) latest = date;

    const key = `${date}|${channel}`;
    const prev = merged.get(key);
    const sessions = Math.round(toNumber(r.sessions) ?? 0);
    const activeUsers = r.active_users != null ? Math.round(toNumber(r.active_users) ?? 0) : null;
    const conversions = r.conversions != null ? Math.round(toNumber(r.conversions) ?? 0) : null;
    const engagementRate = toEngagementRate(r.engagement_rate);

    if (!prev) {
      merged.set(key, {
        date, channel, sessions,
        active_users: activeUsers,
        engagement_rate: engagementRate,
        conversions,
      });
      continue;
    }

    // Sessions and users are additive; engagement rate is a ratio, so it is
    // re-weighted by sessions instead of being summed or overwritten.
    const totalSessions = prev.sessions + sessions;
    if (prev.engagement_rate != null || engagementRate != null) {
      prev.engagement_rate = totalSessions > 0
        ? ((prev.engagement_rate ?? 0) * prev.sessions + (engagementRate ?? 0) * sessions) / totalSessions
        : null;
    }
    prev.sessions = totalSessions;
    if (activeUsers != null) prev.active_users = (prev.active_users ?? 0) + activeUsers;
    if (conversions != null) prev.conversions = (prev.conversions ?? 0) + conversions;
  }

  return {
    rows: [...merged.values()],
    unmatchedHeaders,
    coverage: { start: earliest, end: latest },
  };
}
