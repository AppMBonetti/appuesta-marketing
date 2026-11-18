import { parseXlsxFile, toISODateOnly, toNumber, toText } from "./parseWorkbook.js";

// Normalized headers from a GA4 traffic export -> the columns of the two tables
// this file feeds. normalizeHeader() collapses camelCase, so the API field ids
// ("sessionDefaultChannelGrouping", "sessionSourceMedium") and the display
// names the GA4 interface uses ("Session default channel grouping", "Session
// source / medium") both land on the same key.
//
// Two dimensions, two destinations:
//
//   channel        -> ga4_channel_daily       (what the chart has always shown)
//   source/medium  -> ga4_source_medium_daily (new; the finer grain underneath)
//
// A file may carry either or both. GA4's channel grouping is derived from
// source/medium, so an export with both is self-consistent and fills both
// tables from one upload; an export with only one fills only that one.
// A GA4 interface export is in whatever language the property is set to, and
// this one is Dominican, so the Spanish labels are here beside the English.
// They are best-effort: Google's own Spanish wording for the channel grouping
// appears as "grupo de canales predeterminado", "agrupación de canales
// predeterminados" and "agrupación de canales predeterminada" depending on
// where you read it, so several spellings of the same dimension are mapped
// rather than one guess. If a real file still misses, the error below names
// the headers it did find, which turns a failed import into one message rather
// than a round of guessing. normalizeHeader() does not strip accents, so the
// accented form is the key that matters.
const HEADER_MAP = {
  "date": "date",
  "day": "date",
  "fecha": "date",
  "día": "date",
  "dia": "date",

  "session default channel grouping": "channel",
  "default channel grouping": "channel",
  "first user default channel grouping": "channel",
  "session primary channel group": "channel",
  "primary channel group": "channel",
  "channel grouping": "channel",
  "channel": "channel",
  "grupo de canales predeterminado de la sesión": "channel",
  "grupo de canales predeterminado de la sesion": "channel",
  "grupo de canales principal de la sesión": "channel",
  "grupo de canales principal de la sesion": "channel",
  "grupo de canales predeterminado": "channel",
  "agrupación de canales predeterminados de la sesión": "channel",
  "agrupacion de canales predeterminados de la sesion": "channel",
  "agrupación de canales predeterminada de sesión": "channel",
  "agrupacion de canales predeterminada de sesion": "channel",
  "agrupación de canales": "channel",
  "canal": "channel",

  // The pair as one string, which is how every GA4 export gives it.
  "session source / medium": "source_medium",
  "session source medium": "source_medium",
  "first user source / medium": "source_medium",
  "first user source medium": "source_medium",
  "source / medium": "source_medium",
  "source medium": "source_medium",
  "fuente / medio de la sesión": "source_medium",
  "fuente / medio de la sesion": "source_medium",
  "fuente/medio de la sesión": "source_medium",
  "fuente/medio de la sesion": "source_medium",
  "fuente / medio": "source_medium",
  "fuente/medio": "source_medium",
  "origen / medio": "source_medium",
  "origen/medio": "source_medium",

  // The halves, for an export that was built with them as separate dimensions.
  "session source": "source",
  "first user source": "source",
  "source": "source",
  "fuente de la sesión": "source",
  "fuente de la sesion": "source",
  "fuente": "source",
  "origen": "source",
  "session medium": "medium",
  "first user medium": "medium",
  "medium": "medium",
  "medio de la sesión": "medium",
  "medio de la sesion": "medium",
  "medio": "medium",

  "sessions": "sessions",
  "sesiones": "sessions",
  "active users": "active_users",
  "total users": "active_users",
  "users": "active_users",
  "usuarios activos": "active_users",
  "usuarios totales": "active_users",
  "total de usuarios": "active_users",
  "usuarios": "active_users",
  "new users": "new_users",
  "usuarios nuevos": "new_users",
  "nuevos usuarios": "new_users",
  "engagement rate": "engagement_rate",
  "tasa de interacciones": "engagement_rate",
  "tasa de interacción": "engagement_rate",
  "tasa de interaccion": "engagement_rate",
  "tasa de participación": "engagement_rate",
  "tasa de participacion": "engagement_rate",
  "porcentaje de interacción": "engagement_rate",
  "porcentaje de interaccion": "engagement_rate",
  "conversions": "conversions",
  "conversions float": "conversions",
  "key events": "conversions",
  "conversiones": "conversions",
  "eventos clave": "conversions",
};

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

const intOrNull = v => (v == null || v === "" ? null : Math.round(toNumber(v) ?? 0));

/**
 * One canonical "source / medium" string, however the export spelled it.
 *
 * GA4 writes the pair with spaces around the slash ("google / organic") in the
 * interface and without them in some API exports ("google/organic"). Both are
 * the same traffic, and the string is the primary key of
 * `ga4_source_medium_daily`, so they have to collapse to one value or the same
 * week lands twice under two spellings.
 */
export function normalizeSourceMedium(row) {
  const pair = toText(row.source_medium);
  if (pair) {
    const parts = pair.split("/").map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) return { source_medium: `${parts[0]} / ${parts[1]}`, source: parts[0], medium: parts[1] };
    // "(direct)" with no medium beside it is still a usable key.
    return { source_medium: parts[0] ?? pair.trim(), source: parts[0] ?? pair.trim(), medium: null };
  }

  const source = toText(row.source);
  const medium = toText(row.medium);
  if (!source && !medium) return null;
  // A half-present pair is named rather than dropped: "(not set)" is what GA4
  // itself writes for the missing half, so the row still ties to the export.
  const s = source || "(not set)";
  const m = medium || "(not set)";
  return { source_medium: `${s} / ${m}`, source: s, medium: m };
}

/**
 * Turns already-parsed rows into the two row sets the import writes.
 *
 * Separate from parseGa4File so it can be exercised under plain Node: the
 * parsing half needs a browser `File` and exceljs, this half is where every
 * decision that could be wrong actually lives. scripts/verify-ga4-import.mjs
 * imports it directly.
 */
export function buildGa4Rows(rows) {
  // A GA4 export repeats a (date, channel) pair whenever the query carried an
  // extra dimension the destination table doesn't store — which is exactly what
  // happens when one file carries both channel and source/medium. Sum those
  // rows rather than letting the last one win, and keep the upsert key unique.
  const byChannel = new Map();
  const bySourceMedium = new Map();
  let earliest = null;
  let latest = null;

  const accumulate = (map, key, seed) => {
    const prev = map.get(key);
    if (!prev) { map.set(key, seed); return; }

    // Sessions and users are additive; engagement rate is a ratio, so it is
    // re-weighted by sessions instead of being summed or overwritten.
    const totalSessions = prev.sessions + seed.sessions;
    if (prev.engagement_rate != null || seed.engagement_rate != null) {
      prev.engagement_rate = totalSessions > 0
        ? ((prev.engagement_rate ?? 0) * prev.sessions + (seed.engagement_rate ?? 0) * seed.sessions) / totalSessions
        : null;
    }
    prev.sessions = totalSessions;
    for (const col of ["active_users", "new_users", "conversions"]) {
      if (seed[col] != null) prev[col] = (prev[col] ?? 0) + seed[col];
    }
    // One source/medium belongs to one GA4 channel, so this only ever fills a
    // gap left by a row that had no channel value.
    if (prev.channel == null && seed.channel != null) prev.channel = seed.channel;
  };

  for (const r of rows) {
    const date = toISODateOnly(r.date);
    if (!date) continue;

    const channel = toText(r.channel);
    const pair = normalizeSourceMedium(r);
    if (!channel && !pair) continue;

    if (!earliest || date < earliest) earliest = date;
    if (!latest || date > latest) latest = date;

    const metrics = {
      sessions: Math.round(toNumber(r.sessions) ?? 0),
      active_users: intOrNull(r.active_users),
      new_users: intOrNull(r.new_users),
      conversions: intOrNull(r.conversions),
      engagement_rate: toEngagementRate(r.engagement_rate),
    };

    if (channel) {
      accumulate(byChannel, `${date}|${channel}`, { date, channel, ...metrics });
    }
    if (pair) {
      accumulate(bySourceMedium, `${date}|${pair.source_medium}`, {
        date,
        source_medium: pair.source_medium,
        source: pair.source,
        medium: pair.medium,
        channel: channel || null,
        ...metrics,
      });
    }
  }

  return {
    channelRows: [...byChannel.values()],
    sourceMediumRows: [...bySourceMedium.values()],
    coverage: { start: earliest, end: latest },
  };
}

export async function parseGa4File(file) {
  const { rows, matchedHeaders, unmatchedHeaders } = await parseXlsxFile(file, HEADER_MAP);

  const matched = new Set(matchedHeaders.map(h => HEADER_MAP[h]));

  // A GA4 export in an unexpected language fails here, and the only useful
  // thing to say is which headers the file actually had: the fix is a line in
  // HEADER_MAP, and naming them is the difference between one message and a
  // round of guessing.
  const found = unmatchedHeaders.length
    ? ` Columns found but not recognized: ${unmatchedHeaders.join(", ")}.`
    : "";

  if (!matched.has("date")) {
    throw new Error(`Missing required column in GA4 file: date.${found}`);
  }
  // Either dimension is enough on its own, but a file with neither is a GA4
  // export of something that isn't traffic, and summing it by date alone would
  // quietly write one unattributed row per day.
  const hasChannel = matched.has("channel");
  const hasSourceMedium = matched.has("source_medium") || matched.has("source") || matched.has("medium");
  if (!hasChannel && !hasSourceMedium) {
    throw new Error(`Missing required column(s) in GA4 file: channel, or source / medium.${found}`);
  }

  const { channelRows, sourceMediumRows, coverage } = buildGa4Rows(rows);

  return { channelRows, sourceMediumRows, unmatchedHeaders, coverage };
}
