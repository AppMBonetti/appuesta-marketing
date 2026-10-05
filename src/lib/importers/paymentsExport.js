import { parseXlsxFile, toISOTimestamp, toNumber, toText, SOURCE_TIMEZONE } from "./parseWorkbook";
import { playerIdFromExternal, readReportPeriod } from "./paymentsReport";

// Backoffice "Payments export": one row per payment attempt. Distinct from the
// "Payments Report", which is the same money grouped by player over a date range
// with no day attached. Both are accepted; this one is strictly richer.
const HEADER_MAP = {
  "id": "tx_id",
  "external id": "external_id",
  "skin": "skin",
  "created": "created_at",
  "completed": "completed_at",
  "username": "username",
  "player id": "external_player_id",
  "provider": "provider",
  "method": "method",
  "type": "type",
  "amount": "amount",
  "currency": "currency",
  "status": "status",
};

const REQUIRED_FIELDS = ["tx_id", "created_at", "external_player_id", "type", "amount", "status"];

const EXPECTED_CURRENCY = "DOP";

/**
 * The export's timestamps are the backoffice's own wall clock, which is local
 * Dominican time — NOT UTC, unlike the player report. Checked against
 * first_deposit_date across 28 players: none matched when read as UTC, and the
 * exact matches all landed when read as local. Reading these as UTC would push
 * every deposit four hours late and move anything after 20:00 onto the next day,
 * which is precisely the figure this file exists to produce.
 */
export const PAYMENTS_EXPORT_TIMEZONE = SOURCE_TIMEZONE;

// The export writes "-" where a value is absent rather than leaving the cell empty.
function blankDash(value) {
  const text = toText(value);
  return !text || text === "-" ? null : text;
}

export async function parsePaymentsExportFile(file) {
  const period = await readReportPeriod(file);
  const { rows, matchedHeaders, unmatchedHeaders } = await parseXlsxFile(file, HEADER_MAP);

  const missing = REQUIRED_FIELDS.filter(f => !matchedHeaders.some(h => HEADER_MAP[h] === f));
  if (missing.length) {
    throw new Error(
      `Missing required column(s) in payments export: ${missing.join(", ")}. ` +
      `Columns found: ${[...matchedHeaders, ...unmatchedHeaders].join(", ") || "none"}. ` +
      `Check this is the transaction-level payments export, not the grouped payments report.`
    );
  }

  const now = new Date().toISOString();
  const byId = new Map();
  const currencies = new Set();
  const unparsedPlayers = [];
  const byStatus = {};
  const byType = {};
  let depositCount = 0;
  let depositAmount = 0;
  let failedCount = 0;
  let failedAmount = 0;

  for (const r of rows) {
    const txId = blankDash(r.tx_id);
    if (!txId) continue;

    const playerId = playerIdFromExternal(r.external_player_id);
    if (!playerId) {
      unparsedPlayers.push(toText(r.external_player_id) ?? "");
      continue;
    }

    const type = toText(r.type) ?? "";
    const status = toText(r.status) ?? "";
    const amount = toNumber(r.amount) ?? 0;
    const currency = toText(r.currency);
    if (currency) currencies.add(currency);

    byStatus[status] = (byStatus[status] ?? 0) + 1;
    byType[type] = (byType[type] ?? 0) + 1;

    const isDeposit = type === "Deposit" || type === "Manual deposit" || type === "Offline deposit";
    if (isDeposit && status === "Completed") {
      depositCount += 1;
      depositAmount += amount;
    }
    if (isDeposit && (status === "Canceled" || status === "Rejected" || status === "Failed")) {
      failedCount += 1;
      failedAmount += amount;
    }

    // One row per transaction id; a re-export of an overlapping range restates
    // the same attempts, and a pending one may since have completed, so the
    // later reading replaces the earlier rather than being added to it.
    byId.set(txId, {
      id: txId,
      external_id: blankDash(r.external_id),
      skin: toText(r.skin),
      created_at: toISOTimestamp(r.created_at, PAYMENTS_EXPORT_TIMEZONE),
      completed_at: blankDash(r.completed_at)
        ? toISOTimestamp(r.completed_at, PAYMENTS_EXPORT_TIMEZONE)
        : null,
      username: toText(r.username),
      player_id: playerId,
      external_player_id: toText(r.external_player_id),
      provider: toText(r.provider),
      method: toText(r.method),
      type,
      amount,
      currency,
      status,
      imported_at: now,
    });
  }

  const transactions = [...byId.values()].filter(t => t.created_at);

  return {
    transactions,
    period,
    unmatchedHeaders,
    unparsedPlayers,
    unexpectedCurrencies: [...currencies].filter(c => c !== EXPECTED_CURRENCY),
    expectedCurrency: EXPECTED_CURRENCY,
    summary: {
      rows: transactions.length,
      depositCount,
      depositAmount,
      failedCount,
      failedAmount,
      byStatus,
      byType,
      successPct: depositCount + failedCount > 0
        ? (100 * depositCount) / (depositCount + failedCount)
        : null,
    },
  };
}
