import { parseXlsxFile, toISOTimestamp, toNumber, toText, toIdText } from "./parseWorkbook";

// First-time-depositor export -> the first-deposit fields on players.
const HEADER_MAP = {
  "id": "id",
  "player id": "id",
  "username": "username",
  "ftd date": "first_deposit_date",
  "fist deposit date": "first_deposit_date",   // the export ships this typo
  "first deposit date": "first_deposit_date",
  "ftd amount": "first_deposit_amount",
  "first deposit amount": "first_deposit_amount",
  "registration date": "registered_at",
  "ftd payment provider": "ftd_provider",
  "ftd payment method": "ftd_method",
  "currency": "currency",
};

const REQUIRED_FIELDS = ["id", "first_deposit_date"];

// This export is generated from the platform database in UTC.
export const FTD_TIMEZONE = "UTC";

/**
 * The exact first deposit per player, which is otherwise unrecoverable: a
 * lifetime total cannot tell you what the first deposit was for anyone who
 * deposited more than once, and those are precisely the high-value players.
 */
export async function parseFtdListFile(file) {
  const { rows, matchedHeaders, unmatchedHeaders } = await parseXlsxFile(file, HEADER_MAP);

  const missing = REQUIRED_FIELDS.filter(f => !matchedHeaders.some(h => HEADER_MAP[h] === f));
  if (missing.length) {
    throw new Error(
      `Missing required column(s) in FTD file: ${missing.join(", ")}. ` +
      `Columns found: ${[...matchedHeaders, ...unmatchedHeaders].join(", ") || "none"}. ` +
      `Check this is the first-time-depositor list, one row per player.`
    );
  }

  const now = new Date().toISOString();
  const byId = new Map();
  let earliest = null;
  let latest = null;
  let amountKnown = 0;

  for (const r of rows) {
    const id = toIdText(r.id);
    const ftdDate = toISOTimestamp(r.first_deposit_date, FTD_TIMEZONE);
    if (!id || !ftdDate) continue;

    if (!earliest || ftdDate < earliest) earliest = ftdDate;
    if (!latest || ftdDate > latest) latest = ftdDate;

    // Amounts arrive as "1,000.00 DOP" — the currency suffix has to come off
    // before the number is read.
    const amount = toNumber(String(toText(r.first_deposit_amount) ?? "").replace(/[^0-9.,-]/g, ""));
    if (amount != null) amountKnown += 1;

    const registeredAt = toISOTimestamp(r.registered_at, FTD_TIMEZONE);

    byId.set(id, {
      id,
      first_deposit_date: ftdDate,
      first_deposit_amount: amount,
      // Carried so a player present here but missing from the registration
      // export still lands with a usable registration date.
      registered_at: registeredAt,
      imported_at: now,
    });
  }

  return {
    players: [...byId.values()],
    unmatchedHeaders,
    amountKnown,
    coverage: { start: earliest, end: latest },
  };
}
