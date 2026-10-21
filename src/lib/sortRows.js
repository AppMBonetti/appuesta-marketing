import { useMemo, useState } from "react";

/**
 * Click-to-sort for the dashboard's tables.
 *
 * Every table here mixes numbers, money, dates, text and nulls in one row, and
 * each needs different handling: money and counts sort numerically, dates
 * chronologically, text by locale, and a null is always "no value" rather than
 * zero — a player who has never deposited should not rank alongside one who
 * deposited nothing this week. Nulls therefore sink to the bottom in both
 * directions, so flipping the arrow never fills the top of the table with
 * blanks.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function isMissing(value) {
  return value == null || value === "";
}

/** Compares two present values; the caller handles missing ones and direction. */
function comparePresent(a, b, kind) {
  if (kind === "text") return collator.compare(String(a), String(b));
  if (kind === "date") {
    const at = new Date(a).getTime();
    const bt = new Date(b).getTime();
    if (Number.isNaN(at) || Number.isNaN(bt)) {
      return Number.isNaN(at) === Number.isNaN(bt) ? 0 : Number.isNaN(at) ? 1 : -1;
    }
    return at - bt;
  }
  const an = Number(a);
  const bn = Number(b);
  if (Number.isNaN(an) || Number.isNaN(bn)) {
    return Number.isNaN(an) === Number.isNaN(bn) ? 0 : Number.isNaN(an) ? 1 : -1;
  }
  return an - bn;
}

/**
 * Orders a copy of `rows` by one column.
 *
 * Missing values are placed last before the direction is applied, not after:
 * negating the whole comparison would float every blank to the top as soon as
 * the column was flipped to descending.
 */
export function orderBy(rows, column, dir) {
  const kind = column.kind === "text" ? "text" : column.kind === "date" ? "date" : "number";
  const factor = dir === "asc" ? 1 : -1;
  return [...rows].sort((x, y) => {
    const a = column.value(x);
    const b = column.value(y);
    const aMissing = isMissing(a);
    const bMissing = isMissing(b);
    if (aMissing || bMissing) {
      if (aMissing && bMissing) return 0;
      return aMissing ? 1 : -1;
    }
    return factor * comparePresent(a, b, kind);
  });
}

/**
 * @param rows    the rows to order
 * @param columns [{ key, value, kind }] — `value` reads the sort value off a
 *                row, `kind` is "number" (default), "money", "date" or "text"
 * @param initial { key, dir } to start on, or null for the caller's own order
 */
export function useSortedRows(rows, columns, initial = null) {
  const [sort, setSort] = useState(initial);

  const byKey = useMemo(
    () => Object.fromEntries(columns.filter(c => c.key).map(c => [c.key, c])),
    [columns]
  );

  const sorted = useMemo(() => {
    if (!sort?.key) return rows;
    const column = byKey[sort.key];
    if (!column) return rows;
    return orderBy(rows, column, sort.dir);
  }, [rows, sort, byKey]);

  /**
   * First click on a column sorts the way that column is usually read —
   * descending for money and counts, ascending for names and dates. Clicking
   * the active column flips it; a third click clears back to the default order.
   */
  function toggle(key) {
    const column = byKey[key];
    if (!column) return;
    const firstDir = column.kind === "text" || column.kind === "date" ? "asc" : "desc";
    setSort(current => {
      if (current?.key !== key) return { key, dir: firstDir };
      if (current.dir === firstDir) return { key, dir: firstDir === "asc" ? "desc" : "asc" };
      return initial;
    });
  }

  return { sorted, sort, toggle };
}

/** The affordance in a header cell: ⇅ when idle, ↓/↑ when this column is active. */
export function sortIndicator(sort, key) {
  if (sort?.key !== key) return "⇅";
  return sort.dir === "asc" ? "↑" : "↓";
}
