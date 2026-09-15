import { parseXlsxFile, toISOTimestamp, toNumber, toText, toIdText } from "./parseWorkbook";

// Backoffice player report -> players. One row per player, lifetime totals.
// Two spellings of the first-deposit column ship in the wild: the export
// carried "fist deposit date" for months and was corrected later, and Marcos
// still holds files of both vintages, so both map to the same field.
const HEADER_MAP = {
  "player id": "id",
  "email": "email",
  "username": "username",
  "date of birth": "date_of_birth",
  "country": "country",
  "currency": "currency",
  "registration date": "registered_at",
  "last login date": "last_login_at",
  "fist deposit date": "first_deposit_date",
  "first deposit date": "first_deposit_date",
  "first deposit amount": "first_deposit_amount",
  "deposit count": "total_deposit_count",
  "total deposit amount": "total_deposit_amount",
  "last deposit date": "last_deposit_date",
  "withdrawal count": "total_withdrawal_count",
  "total withdrawal amount": "total_withdrawal_amount",
  "last withdrawal date": "last_withdrawal_date",
  "sports bets": "report_sports_bets",
  "sports wins": "report_sports_wins",
  "sports ggr": "report_sports_ggr",
  "cashed out bets": "cashed_out_bets",
  "cashed out count": "cashed_out_count",
  "cashback": "cashback",
  "sports bonus bets": "sports_bonus_bets",
  "sports bonus wins": "sports_bonus_wins",
  "bonus to cash": "bonus_to_cash",
};

const REQUIRED_FIELDS = ["id", "registered_at"];

// Generated from the platform database in UTC. Confirmed by anchoring each
// player's first Altenar bet against their registration timestamp: read as UTC,
// no player bets before they exist and the fastest do so within a minute.
export const PLAYER_REPORT_TIMEZONE = "UTC";

const EXPECTED_CURRENCY = "DOP";

/**
 * The report is a lifetime snapshot, not a period extract: every total in it is
 * "since the player registered", regardless of the date range in the filename.
 * That makes it authoritative for who a player is and when they last acted, and
 * useless for how much moved in a given week — which is what the payments
 * report covers.
 */
export async function parsePlayerReportFile(file) {
  const { rows, matchedHeaders, unmatchedHeaders } = await parseXlsxFile(file, HEADER_MAP);

  const missing = REQUIRED_FIELDS.filter(f => !matchedHeaders.some(h => HEADER_MAP[h] === f));
  if (missing.length) {
    throw new Error(
      `Missing required column(s) in player report: ${missing.join(", ")}. ` +
      `Columns found: ${[...matchedHeaders, ...unmatchedHeaders].join(", ") || "none"}. ` +
      `Check this is the per-player report, one row per player.`
    );
  }

  const now = new Date().toISOString();
  const byId = new Map();
  const currencies = new Set();
  let registeredFrom = null;
  let registeredTo = null;
  let lastActivity = null;
  let depositors = 0;
  let ftdKnown = 0;
  let ftdDateMissing = 0;

  for (const r of rows) {
    const id = toIdText(r.id);
    const registeredAt = toISOTimestamp(r.registered_at, PLAYER_REPORT_TIMEZONE);
    if (!id || !registeredAt) continue;

    const currency = toText(r.currency);
    if (currency) currencies.add(currency);

    if (!registeredFrom || registeredAt < registeredFrom) registeredFrom = registeredAt;
    if (!registeredTo || registeredAt > registeredTo) registeredTo = registeredAt;

    const lastLoginAt = toISOTimestamp(r.last_login_at, PLAYER_REPORT_TIMEZONE);
    const lastDepositDate = toISOTimestamp(r.last_deposit_date, PLAYER_REPORT_TIMEZONE);
    for (const t of [lastLoginAt, lastDepositDate]) {
      if (t && (!lastActivity || t > lastActivity)) lastActivity = t;
    }

    const depositCount = toNumber(r.total_deposit_count) ?? 0;
    let firstDepositDate = toISOTimestamp(r.first_deposit_date, PLAYER_REPORT_TIMEZONE);

    if (depositCount > 0) {
      depositors += 1;
      // A handful of accounts carry deposits with no first-deposit date — the
      // field was added after they deposited. When the player has deposited
      // exactly once, the last deposit *is* the first, so the FTD is recoverable
      // rather than lost; with two or more there is nothing to infer from.
      if (!firstDepositDate && depositCount === 1 && lastDepositDate) {
        firstDepositDate = lastDepositDate;
      }
      if (firstDepositDate) ftdKnown += 1;
      else ftdDateMissing += 1;
    }

    byId.set(id, {
      id,
      username: toText(r.username),
      name: toText(r.username),
      email: toText(r.email),
      country: toText(r.country),
      currency,
      date_of_birth: toDateOnly(r.date_of_birth),
      registered_at: registeredAt,
      last_login_at: lastLoginAt,
      first_deposit_date: firstDepositDate,
      first_deposit_amount: toNumber(r.first_deposit_amount),
      total_deposit_count: depositCount,
      total_deposit_amount: toNumber(r.total_deposit_amount) ?? 0,
      last_deposit_date: lastDepositDate,
      total_withdrawal_count: toNumber(r.total_withdrawal_count) ?? 0,
      total_withdrawal_amount: toNumber(r.total_withdrawal_amount) ?? 0,
      last_withdrawal_date: toISOTimestamp(r.last_withdrawal_date, PLAYER_REPORT_TIMEZONE),
      report_sports_bets: toNumber(r.report_sports_bets),
      report_sports_wins: toNumber(r.report_sports_wins),
      report_sports_ggr: toNumber(r.report_sports_ggr),
      cashed_out_bets: toNumber(r.cashed_out_bets),
      cashed_out_count: toNumber(r.cashed_out_count),
      cashback: toNumber(r.cashback),
      sports_bonus_bets: toNumber(r.sports_bonus_bets),
      sports_bonus_wins: toNumber(r.sports_bonus_wins),
      bonus_to_cash: toNumber(r.bonus_to_cash),
      imported_at: now,
    });
  }

  return {
    players: [...byId.values()],
    unmatchedHeaders,
    unexpectedCurrencies: [...currencies].filter(c => c !== EXPECTED_CURRENCY),
    expectedCurrency: EXPECTED_CURRENCY,
    summary: { depositors, ftdKnown, ftdDateMissing },
    // `end` is the newest thing the file knows about, not the range in its
    // filename — a report labelled as last week's can stop days earlier, and
    // that gap is what makes login and deposit recency stale.
    coverage: { start: registeredFrom, end: lastActivity ?? registeredTo },
  };
}

// Date of birth is a calendar date, not an instant: shifting it by a timezone
// can move someone's birthday a day and change their age at the boundary.
function toDateOnly(rawValue) {
  const iso = toISOTimestamp(rawValue, "UTC");
  return iso ? iso.slice(0, 10) : null;
}
