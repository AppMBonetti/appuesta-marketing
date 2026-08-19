import { parseXlsxFile, toISOTimestamp, toNumber, toText, toIdText } from "./parseWorkbook";

// Normalized (trimmed, lowercased, whitespace-collapsed) Altenar export headers -> bets columns.
// Columns not present in the `bets` schema (Skin, Affiliate, Client IP, Player limit group,
// Product, Market types, Price, No Events, Frontend type, Color, Streaming bet, Is locked,
// Bonus stake, Bonus winnings, HasPartialCashout) are intentionally not mapped/stored.
const HEADER_MAP = {
  "no": "bet_id",
  "player": "player_username",
  "player id": "player_id",
  "external user id": "external_user_id",
  "sport": "sport",
  "category": "category",
  "champ name": "champ_name",
  "event name": "event_name",
  "bet date": "bet_date",
  "event date": "event_date",
  "settlement date": "settlement_date",
  "bet type": "bet_type",
  "stake": "stake",
  "winnings": "winnings",
  "currency": "currency",
  "status": "status",
  "bonus": "bonus",
};

const REQUIRED_FIELDS = ["bet_id"];

// Statuses seen in real exports. A bet whose stake is handed back never counted
// as wagering, so it is excluded from GGR and from VIP tier qualification —
// this mirrors what Altenar itself leaves out of its "Totals of report" sheet.
const RETURNED_STAKE_STATUSES = ["Void", "VoidCashout", "Rejected"];
const SETTLED_STATUSES = ["Win", "Lost", "Open", "Cashout"];
const KNOWN_STATUSES = [...RETURNED_STAKE_STATUSES, ...SETTLED_STATUSES];

export async function parseAltenarFile(file) {
  const { rows, matchedHeaders, unmatchedHeaders } = await parseXlsxFile(file, HEADER_MAP);

  const missingRequired = REQUIRED_FIELDS.filter(f => !matchedHeaders.some(h => HEADER_MAP[h] === f));
  if (missingRequired.length) {
    throw new Error(`Missing required column(s) in Altenar file: ${missingRequired.join(", ")}`);
  }

  const now = new Date().toISOString();
  // Keyed by bet_id: the table's primary key is bet_id, and Postgres rejects an
  // upsert whose batch touches the same row twice ("ON CONFLICT DO UPDATE
  // command cannot affect row a second time"). A single export repeating a bet
  // would otherwise fail the whole import, so the last occurrence wins — that
  // is the most recently settled version of the bet.
  const betsById = new Map();
  const seenStatuses = new Set();
  let earliestBet = null;
  let latestBet = null;
  for (const r of rows) {
    const betId = toIdText(r.bet_id);
    if (!betId) continue;

    const status = toText(r.status);
    if (status) seenStatuses.add(status);

    const betDate = toISOTimestamp(r.bet_date);
    if (betDate) {
      if (!earliestBet || betDate < earliestBet) earliestBet = betDate;
      if (!latestBet || betDate > latestBet) latestBet = betDate;
    }

    betsById.set(betId, {
      bet_id: betId,
      player_username: toText(r.player_username),
      player_id: toIdText(r.player_id),
      external_user_id: toIdText(r.external_user_id),
      sport: toText(r.sport),
      category: toText(r.category),
      champ_name: toText(r.champ_name),
      event_name: toText(r.event_name),
      bet_date: betDate,
      event_date: toISOTimestamp(r.event_date),
      settlement_date: toISOTimestamp(r.settlement_date),
      bet_type: toText(r.bet_type),
      stake: toNumber(r.stake),
      winnings: toNumber(r.winnings),
      currency: toText(r.currency),
      status,
      bonus: toNumber(r.bonus) ?? 0,
      imported_at: now,
    });
  }

  // A status nobody has classified yet would silently land in GGR and in tier
  // qualification, so it is reported back for a human to rule on.
  const unknownStatuses = [...seenStatuses].filter(st => !KNOWN_STATUSES.includes(st));
  const bets = [...betsById.values()];

  return {
    bets,
    unmatchedHeaders,
    unknownStatuses,
    coverage: { start: earliestBet, end: latestBet },
  };
}
