import { parseXlsxFile, readAllSheets, toNumber, toText, unwrapCellValue } from "./parseWorkbook";

// Backoffice payments report -> deposit_periods. Grouped by player, summed over
// the report's date range: "# deposits" and "deposits amount" are totals for the
// window, not individual transactions.
const HEADER_MAP = {
  "currency": "currency",
  "player": "player",
  "# deposits": "deposit_count",
  "deposits amount": "deposit_amount",
  "# payouts": "payout_count",
  "payouts amount": "payout_amount",
  "net +/": "net",
  "net +/-": "net",
};

const REQUIRED_FIELDS = ["player", "deposit_count", "deposit_amount"];

const EXPECTED_CURRENCY = "DOP";

// "username (222100000149)" — the parenthesised number is the Altenar-side
// external user id, whose last nine digits are the backoffice player id.
const PLAYER_CELL_RE = /^(.*?)\s*\((\d+)\)\s*$/;

// "Date range" on the Properties sheet: "10/08/2026 00:00 - 31/08/2026 23:59",
// day first. This is the only statement of which period the totals cover — the
// filename says when the report was generated, not what it contains.
const DATE_RANGE_RE =
  /(\d{2})\/(\d{2})\/(\d{4})\s+\d{2}:\d{2}\s*[-–]\s*(\d{2})\/(\d{2})\/(\d{4})\s+\d{2}:\d{2}/;

/**
 * Turns the external user id in a player cell into the backoffice player id.
 * The ids run in parallel: external 222100000149 is player 100000149, so the
 * last nine digits are the join key.
 */
export function playerIdFromExternal(externalId) {
  const digits = String(externalId ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
}

export async function parsePaymentsReportFile(file) {
  const period = await readReportPeriod(file);
  if (!period) {
    throw new Error(
      "Could not find the report's date range. The payments report carries it " +
      "on its Properties sheet as \"Date range\" — without it there is no way " +
      "to know which period these totals belong to."
    );
  }

  const { rows, matchedHeaders, unmatchedHeaders } = await parseXlsxFile(file, HEADER_MAP);

  const missing = REQUIRED_FIELDS.filter(f => !matchedHeaders.some(h => HEADER_MAP[h] === f));
  if (missing.length) {
    throw new Error(
      `Missing required column(s) in payments report: ${missing.join(", ")}. ` +
      `Columns found: ${[...matchedHeaders, ...unmatchedHeaders].join(", ") || "none"}. ` +
      `Check this is the payments report grouped by player.`
    );
  }

  const now = new Date().toISOString();
  const byPlayer = new Map();
  const currencies = new Set();
  const unparsedPlayers = [];
  let reportedTotal = null;
  let depositCount = 0;
  let depositAmount = 0;
  let payoutCount = 0;
  let payoutAmount = 0;

  for (const r of rows) {
    const currency = toText(r.currency);

    // The sheet ends with a TOTAL line whose cells are shifted one column left,
    // so its "# deposits" holds the amount. Reading it as a player would both
    // invent a player and double the file's totals.
    if (currency && currency.toUpperCase() === "TOTAL") {
      reportedTotal = {
        depositAmount: toNumber(r.deposit_count),
        payoutAmount: toNumber(r.payout_count),
      };
      continue;
    }

    const rawPlayer = toText(r.player);
    if (!rawPlayer) continue;

    const match = PLAYER_CELL_RE.exec(rawPlayer);
    if (!match) {
      unparsedPlayers.push(rawPlayer);
      continue;
    }

    const externalId = match[2];
    const playerId = playerIdFromExternal(externalId);
    if (!playerId) {
      unparsedPlayers.push(rawPlayer);
      continue;
    }

    if (currency) currencies.add(currency);

    const deposits = toNumber(r.deposit_count) ?? 0;
    const depositSum = toNumber(r.deposit_amount) ?? 0;
    const payouts = toNumber(r.payout_count) ?? 0;
    const payoutSum = toNumber(r.payout_amount) ?? 0;

    depositCount += deposits;
    depositAmount += depositSum;
    payoutCount += payouts;
    payoutAmount += payoutSum;

    // A player can appear once per currency; the dashboard is DOP-only and the
    // currency is checked below, so rows for one player are summed rather than
    // letting the last one win.
    const existing = byPlayer.get(playerId);
    if (existing) {
      existing.deposit_count += deposits;
      existing.deposit_amount += depositSum;
      existing.payout_count += payouts;
      existing.payout_amount += payoutSum;
      continue;
    }

    byPlayer.set(playerId, {
      period_start: period.start,
      period_end: period.end,
      player_id: playerId,
      username: match[1].trim() || null,
      external_id: externalId,
      deposit_count: deposits,
      deposit_amount: depositSum,
      payout_count: payouts,
      payout_amount: payoutSum,
      imported_at: now,
    });
  }

  return {
    periods: [...byPlayer.values()],
    period,
    unmatchedHeaders,
    unparsedPlayers,
    unexpectedCurrencies: [...currencies].filter(c => c !== EXPECTED_CURRENCY),
    expectedCurrency: EXPECTED_CURRENCY,
    summary: {
      players: byPlayer.size,
      // A row means "had payment activity in the window", not "deposited": the
      // report also lists withdrawal-only players and players whose payments
      // all failed. Counting rows overstates depositors, so count the rows that
      // actually carry a deposit.
      depositors: [...byPlayer.values()].filter(p => p.deposit_count > 0).length,
      depositCount,
      depositAmount,
      payoutCount,
      payoutAmount,
      // The file's own TOTAL line, kept so the import can prove it read every
      // row rather than asserting it.
      reportedTotal,
    },
    coverage: { start: period.start, end: period.end },
  };
}

/** Reads "Date range" off the Properties sheet as `{ start, end }` ISO dates. */
export async function readReportPeriod(file) {
  let sheets;
  try {
    sheets = await readAllSheets(file);
  } catch {
    return null;
  }

  for (const rows of sheets) {
    for (const row of rows.slice(0, 40)) {
      if (!row) continue;
      const line = row.map(cell => toText(unwrapCellValue(cell)) ?? "").join(" ");
      const m = DATE_RANGE_RE.exec(line);
      if (!m) continue;
      return {
        start: `${m[3]}-${m[2]}-${m[1]}`,
        end: `${m[6]}-${m[5]}-${m[4]}`,
      };
    }
  }
  return null;
}
