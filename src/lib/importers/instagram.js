import { parseXlsxFile, toISODateOnly, toNumber, toText } from "./parseWorkbook";

// Supermetrics Instagram Insights export headers -> social_daily columns.
// normalizeHeader() collapses camelCase, so the API field ids and the display
// names Supermetrics writes by default both land on the same key.
const HEADER_MAP = {
  "date": "date",
  "day": "date",
  "profile reach": "reach",
  "reach": "reach",
  "profile views": "profile_views",
  "profile view": "profile_views",
  "new followers": "new_followers",
  "follower count": "new_followers",
  "profile followers": "followers_total",
  "followers count": "followers_total",
  "username": "account",
  "name": "account",
};

const REQUIRED_FIELDS = ["date"];

export async function parseInstagramFile(file) {
  const { rows, matchedHeaders, unmatchedHeaders } = await parseXlsxFile(file, HEADER_MAP);

  const missingRequired = REQUIRED_FIELDS.filter(f => !matchedHeaders.some(h => HEADER_MAP[h] === f));
  if (missingRequired.length) {
    throw new Error(`Missing required column(s) in Instagram file: ${missingRequired.join(", ")}`);
  }
  if (!matchedHeaders.some(h => ["reach", "profile_views", "new_followers", "followers_total"].includes(HEADER_MAP[h]))) {
    throw new Error("Instagram file has no recognisable metric column (reach, profile views or new followers)");
  }

  // A date can repeat when the export carried an extra dimension the dashboard
  // doesn't store; sum those rather than letting the last row win.
  const merged = new Map();
  let earliest = null;
  let latest = null;

  for (const r of rows) {
    const date = toISODateOnly(r.date);
    if (!date) continue;
    if (!earliest || date < earliest) earliest = date;
    if (!latest || date > latest) latest = date;

    const round = v => (v == null ? null : Math.round(toNumber(v) ?? 0));
    const prev = merged.get(date);
    const next = {
      date,
      platform: "Instagram",
      account: toText(r.account) ?? prev?.account ?? null,
      reach: round(r.reach),
      profile_views: round(r.profile_views),
      new_followers: round(r.new_followers),
      // A running total, not a daily count — the latest value wins.
      followers_total: round(r.followers_total),
    };

    if (!prev) { merged.set(date, next); continue; }
    const add = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
    prev.reach = add(prev.reach, next.reach);
    prev.profile_views = add(prev.profile_views, next.profile_views);
    prev.new_followers = add(prev.new_followers, next.new_followers);
    if (next.followers_total != null) prev.followers_total = next.followers_total;
    if (next.account) prev.account = next.account;
  }

  return {
    rows: [...merged.values()],
    unmatchedHeaders,
    coverage: { start: earliest, end: latest },
  };
}
