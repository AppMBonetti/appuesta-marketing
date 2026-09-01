import { parseXlsxFile, toISOTimestamp, toText, toIdText } from "./parseWorkbook";

// All-time registration export -> players. Semicolon-delimited; the delimiter
// is detected from the header line, so no special casing is needed here.
const HEADER_MAP = {
  "playerid": "id",
  "player id": "id",
  "id": "id",
  "name": "name",
  "email": "email",
  "registeredat": "registered_at",
  "registered at": "registered_at",
  "registration date": "registered_at",
};

const REQUIRED_FIELDS = ["id", "registered_at"];

/**
 * Registration timestamps in this export carry an explicit UTC offset
 * (`2026-08-27T19:33:57-04:00`), so they are unambiguous and no source timezone
 * has to be assumed — the offset in the value wins over any default.
 */
export async function parseRegistrationsFile(file) {
  const { rows, matchedHeaders, unmatchedHeaders } = await parseXlsxFile(file, HEADER_MAP);

  const missing = REQUIRED_FIELDS.filter(f => !matchedHeaders.some(h => HEADER_MAP[h] === f));
  if (missing.length) {
    throw new Error(`Missing required column(s) in registrations file: ${missing.join(", ")}`);
  }

  const now = new Date().toISOString();
  const byId = new Map();
  let earliest = null;
  let latest = null;

  for (const r of rows) {
    const id = toIdText(r.id);
    if (!id) continue;
    const registeredAt = toISOTimestamp(r.registered_at);
    if (registeredAt) {
      if (!earliest || registeredAt < earliest) earliest = registeredAt;
      if (!latest || registeredAt > latest) latest = registeredAt;
    }

    // Several accounts carry two addresses in one field; the first is the one
    // the player actually signed up with.
    const rawEmail = toText(r.email);
    const email = rawEmail ? rawEmail.split(",")[0].trim() || null : null;
    const name = toText(r.name);

    byId.set(id, {
      id,
      name: name && name !== "" ? name : null,
      email,
      registered_at: registeredAt,
      imported_at: now,
    });
  }

  return {
    players: [...byId.values()],
    unmatchedHeaders,
    coverage: { start: earliest, end: latest },
  };
}
