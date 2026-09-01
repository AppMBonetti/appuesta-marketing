import { parseXlsxFile, toISOTimestamp, toNumber, toText, toIdText } from "./parseWorkbook";

// Backoffice payments export -> payment_transactions.
const HEADER_MAP = {
  "id": "transaction_id",
  "external id": "external_id",
  "player id": "player_id",
  "username": "username",
  "created": "created_at",
  "completed": "completed_at",
  "provider": "provider",
  "method": "method",
  "type": "type",
  "amount": "amount",
  "currency": "currency",
  "status": "status",
};

const REQUIRED_FIELDS = ["transaction_id", "created_at", "type", "amount", "status"];

// The export renders timestamps in UTC. Unlike the bet feed there is no
// ambiguity to resolve here — it is stated by the platform and confirmed by
// reconciling two separate windows against the backoffice.
export const PAYMENTS_TIMEZONE = "UTC";

const EXPECTED_CURRENCY = "DOP";

// Money the player actually sent. Everything else in `type` is either money
// going out or credit the house issued, and must not be counted as a deposit.
const DEPOSIT_TYPES = ["Deposit", "Manual deposit", "Offline deposit"];
const WITHDRAWAL_TYPES = ["Withdraw", "Manual withdraw", "Offline withdraw"];
const PROMO_TYPES = ["Cashback", "Bonus"];
const KNOWN_TYPES = [...DEPOSIT_TYPES, ...WITHDRAWAL_TYPES, ...PROMO_TYPES];

// An unresolved transaction is not money that moved; only Completed counts.
const COUNTED_STATUS = "Completed";

export async function parsePaymentsFile(file) {
  const { rows, matchedHeaders, unmatchedHeaders } = await parseXlsxFile(file, HEADER_MAP);

  const missing = REQUIRED_FIELDS.filter(f => !matchedHeaders.some(h => HEADER_MAP[h] === f));
  if (missing.length) {
    throw new Error(
      `Missing required column(s) in payments file: ${missing.join(", ")}. ` +
      `Columns found: ${[...matchedHeaders, ...unmatchedHeaders].join(", ") || "none"}. ` +
      `Check this is the transaction-level export rather than a summary.`
    );
  }

  const now = new Date().toISOString();
  const byId = new Map();
  const unknownTypes = new Set();
  const currencies = new Set();
  let earliest = null;
  let latest = null;
  let depositCount = 0;
  let depositAmount = 0;
  let promoCount = 0;

  for (const r of rows) {
    const id = toIdText(r.transaction_id);
    const createdAt = toISOTimestamp(r.created_at, PAYMENTS_TIMEZONE);
    if (!id || !createdAt) continue;

    const type = toText(r.type);
    const status = toText(r.status);
    const amount = toNumber(r.amount);
    const currency = toText(r.currency);
    if (currency) currencies.add(currency);
    if (type && !KNOWN_TYPES.includes(type)) unknownTypes.add(type);

    if (!earliest || createdAt < earliest) earliest = createdAt;
    if (!latest || createdAt > latest) latest = createdAt;

    if (status === COUNTED_STATUS && DEPOSIT_TYPES.includes(type)) {
      depositCount += 1;
      depositAmount += amount ?? 0;
    }
    if (status === COUNTED_STATUS && PROMO_TYPES.includes(type)) promoCount += 1;

    // Keyed by id so a re-export overlapping earlier days updates in place —
    // and so a transaction that has since settled overwrites its own
    // in-progress row rather than being counted twice.
    byId.set(id, {
      transaction_id: id,
      external_id: toText(r.external_id) === "-" ? null : toText(r.external_id),
      player_id: toIdText(r.player_id),
      username: toText(r.username),
      created_at: createdAt,
      completed_at: toISOTimestamp(r.completed_at, PAYMENTS_TIMEZONE),
      provider: toText(r.provider),
      method: toText(r.method),
      type,
      amount: amount ?? 0,
      currency,
      status,
      imported_at: now,
    });
  }

  const unexpectedCurrencies = [...currencies].filter(c => c !== EXPECTED_CURRENCY);

  return {
    transactions: [...byId.values()],
    unmatchedHeaders,
    unknownTypes: [...unknownTypes],
    unexpectedCurrencies,
    expectedCurrency: EXPECTED_CURRENCY,
    summary: { depositCount, depositAmount, promoCount },
    coverage: { start: earliest, end: latest },
  };
}
