import { parseXlsxFile, toIdText, toISOTimestamp, toNumber, toText } from "./parseWorkbook";
import { playerIdFromExternal } from "./paymentsReport";

// Backoffice "Reports" export filtered to one affiliate's code -> affiliate_players.
// One row per player the affiliate brought in, lifetime totals. The export has
// no column naming the affiliate, so the uploader states which one it is.
// The player report's own headers are accepted too, so a per-player report
// filtered the same way can be uploaded instead.
// The report's "name" column (the player's full name) is deliberately not
// mapped: the affiliate dashboards identify players by username only, which
// comes from the player report.
const HEADER_MAP = {
  "player id": "player",
  "registered at": "registered_at",
  "registration date": "registered_at",
  "first deposit date": "first_deposit_date",
  "fist deposit date": "first_deposit_date",
  "deposit count": "deposit_count",
  "total deposit amount": "deposit_amount",
  "total withdrawal amount": "withdrawal_amount",
  "total ggr sportsbook": "ggr",
  "sports ggr": "ggr",
};

// Columns that, when missing, are filled from the player report instead. Named
// in the preview so a changed export template is noticed before commission is
// quietly computed from older figures.
const OPTIONAL_FIELDS = ["registered_at", "deposit_amount", "ggr"];

/**
 * `playerId` here is the external id (222100001645): its last nine digits are
 * the backoffice player id, the same join the payments report uses. Timestamps
 * carry their own offset; offset-less values are read as UTC like the player
 * report's.
 */
export async function parseAffiliateReportFile(file) {
  const { rows, matchedHeaders, unmatchedHeaders } = await parseXlsxFile(file, HEADER_MAP);

  const fields = new Set(matchedHeaders.map(h => HEADER_MAP[h]));
  if (!fields.has("player")) {
    throw new Error(
      `Missing the player id column. Columns found: ${[...matchedHeaders, ...unmatchedHeaders].join(", ") || "none"}.`
    );
  }

  const byId = new Map();
  const unparsed = [];
  for (const r of rows) {
    const playerId = playerIdFromExternal(toIdText(r.player));
    if (!playerId) {
      if (toText(r.player)) unparsed.push(toText(r.player));
      continue;
    }
    // Only columns the file has are sent: an absent one stays null so the view
    // falls back to the player report rather than reading it as zero.
    byId.set(playerId, {
      player_id: playerId,
      registered_at: toISOTimestamp(r.registered_at, "UTC"),
      first_deposit_date: toISOTimestamp(r.first_deposit_date, "UTC"),
      deposit_count: fields.has("deposit_count") ? (toNumber(r.deposit_count) ?? 0) : null,
      deposit_amount: fields.has("deposit_amount") ? (toNumber(r.deposit_amount) ?? 0) : null,
      withdrawal_amount: fields.has("withdrawal_amount") ? (toNumber(r.withdrawal_amount) ?? 0) : null,
      ggr: fields.has("ggr") ? (toNumber(r.ggr) ?? 0) : null,
    });
  }

  const players = [...byId.values()];
  return {
    players,
    unparsed,
    missingFields: OPTIONAL_FIELDS.filter(f => !fields.has(f)),
    duplicates: rows.length - players.length - unparsed.length,
  };
}
