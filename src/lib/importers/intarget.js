import { parseXlsxFile, toISOTimestamp, toNumber, toText, toIdText } from "./parseWorkbook";

// Normalized (trimmed, lowercased, whitespace-collapsed) InTarget export headers -> players columns
const HEADER_MAP = {
  "id": "id",
  "player id": "id",
  "name": "name",
  "registered at": "registered_at",
  "age": "age",
  "average deposit amount": "avg_deposit_amount",
  "average sportsbook bet amount": "avg_sportsbook_bet_amount",
  "email": "email",
  "first deposit date": "first_deposit_date",
  "last deposit date": "last_deposit_date",
  "last withdrawal date": "last_withdrawal_date",
  "total deposit amount": "total_deposit_amount",
  "total deposit count": "total_deposit_count",
  "total ggr sportsbook": "total_ggr_sportsbook",
  "total withdrawal amount": "total_withdrawal_amount",
};

const REQUIRED_FIELDS = ["id"];

export async function parseIntargetFile(file) {
  const { rows, matchedHeaders, unmatchedHeaders } = await parseXlsxFile(file, HEADER_MAP);

  const missingRequired = REQUIRED_FIELDS.filter(f => !matchedHeaders.some(h => HEADER_MAP[h] === f));
  if (missingRequired.length) {
    throw new Error(`Missing required column(s) in InTarget file: ${missingRequired.join(", ")}`);
  }

  const now = new Date().toISOString();
  const players = [];
  let earliestRegistration = null;
  let latestRegistration = null;
  for (const r of rows) {
    const id = toIdText(r.id);
    if (!id) continue;

    const registeredAt = toISOTimestamp(r.registered_at);
    const firstDepositDate = toISOTimestamp(r.first_deposit_date);
    const depositCount = r.total_deposit_count != null ? Math.round(toNumber(r.total_deposit_count) ?? 0) : null;

    if (registeredAt) {
      if (!earliestRegistration || registeredAt < earliestRegistration) earliestRegistration = registeredAt;
      if (!latestRegistration || registeredAt > latestRegistration) latestRegistration = registeredAt;
    }

    const player = {
      id,
      name: toText(r.name),
      email: toText(r.email),
      age: r.age != null ? Math.round(toNumber(r.age) ?? NaN) || null : null,
      registered_at: registeredAt,
      first_deposit_date: firstDepositDate,
      last_deposit_date: toISOTimestamp(r.last_deposit_date),
      last_withdrawal_date: toISOTimestamp(r.last_withdrawal_date),
      avg_deposit_amount: toNumber(r.avg_deposit_amount),
      avg_sportsbook_bet_amount: toNumber(r.avg_sportsbook_bet_amount),
      total_deposit_amount: toNumber(r.total_deposit_amount),
      total_deposit_count: depositCount,
      total_ggr_sportsbook: toNumber(r.total_ggr_sportsbook),
      total_withdrawal_amount: toNumber(r.total_withdrawal_amount),
      // is_ftd is a generated column (total_deposit_count > 0) — never write it.
      imported_at: now,
    };

    if (registeredAt && firstDepositDate) {
      player.days_to_ftd = (new Date(firstDepositDate) - new Date(registeredAt)) / 86400000;
    }

    players.push(player);
  }

  return {
    players,
    unmatchedHeaders,
    coverage: { start: earliestRegistration, end: latestRegistration },
  };
}
