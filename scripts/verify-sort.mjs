// Ordering checks for the table sort, run as part of the build.
//
// There is no test suite here, but one case is worth guarding: a blank has to
// stay at the bottom of the table in both directions. An earlier version
// negated the whole comparison to sort descending, which floated every player
// who had never deposited to the top the moment you clicked "depositado" —
// exactly the column that question is asked with.
import { orderBy } from "../src/lib/sortRows.js";

const rows = [
  { id: "c", dep: 500, when: "2026-10-01" },
  { id: "a", dep: null, when: null },
  { id: "b", dep: 1500, when: "2026-09-15" },
  { id: "d", dep: 0, when: "2026-10-05" },
  { id: "e", dep: "2200.50", when: "2026-08-01" },
];

const money = { key: "dep", value: r => r.dep };
const date = { key: "when", kind: "date", value: r => r.when };
const text = { key: "id", kind: "text", value: r => r.id };

const cases = [
  ["money desc", money, "desc", "e,b,c,d,a"],
  ["money asc", money, "asc", "d,c,b,e,a"],
  ["date desc", date, "desc", "d,c,b,e,a"],
  ["date asc", date, "asc", "e,b,c,d,a"],
  ["text asc", text, "asc", "a,b,c,d,e"],
  ["text desc", text, "desc", "e,d,c,b,a"],
];

const failures = [];
for (const [name, column, dir, expected] of cases) {
  const actual = orderBy(rows, column, dir).map(r => r.id).join(",");
  if (actual !== expected) failures.push(`${name}: expected ${expected}, got ${actual}`);
}

if (failures.length) {
  console.error(`verify-sort: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`verify-sort: ${cases.length} ordering cases pass, blanks last in both directions.`);
