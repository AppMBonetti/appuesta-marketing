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

export async function parseAltenarFile(file) {
  const { rows, matchedHeaders, unmatchedHeaders } = await parseXlsxFile(file, HEADER_MAP);

  const missingRequired = REQUIRED_FIELDS.filter(f => !matchedHeaders.some(h => HEADER_MAP[h] === f));
  if (missingRequired.length) {
    throw new Error(`Missing required column(s) in Altenar file: ${missingRequired.join(", ")}`);
  }

  const now = new Date().toISOString();
  const bets = [];
  let earliestBet = null;
  let latestBet = null;
  for (const r of rows) {
    const betId = toIdText(r.bet_id);
    if (!betId) continue;

    const betDate = toISOTimestamp(r.bet_date);
    if (betDate) {
      if (!earliestBet || betDate < earliestBet) earliestBet = betDate;
      if (!latestBet || betDate > latestBet) latestBet = betDate;
    }

    bets.push({
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
      status: toText(r.status),
      bonus: toNumber(r.bonus) ?? 0,
      imported_at: now,
    });
  }

  return {
    bets,
    unmatchedHeaders,
    coverage: { start: earliestBet, end: latestBet },
  };
}
