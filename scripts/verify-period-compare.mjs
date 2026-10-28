// Period-comparison checks, run as part of the build.
//
// The bug this guards: the current month runs to the 31st on the calendar and
// to the 25th in the database, because the reports land weekly. Comparing the
// whole month against a whole previous month puts 25 days of numerator over 30
// days of denominator, and every growth figure comes out short. October read
// +165% on registrations where the honest like-for-like is +254%, and +196% on
// FTDs where it is +408%.
//
// Nothing about that looks wrong on screen -- both numbers are real, the
// arithmetic is right, and only the windows disagree. That is exactly the kind
// of mistake a test catches and a reading does not.
import { clampToCoverage, matchPriorLength, daysBetween } from "../src/lib/period.js";

const failures = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures.push(`${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};

// October 2026, data through the 25th: the real case.
const october = { start: "2026-10-01", end: "2026-10-31" };
const covered = clampToCoverage(october, "2026-10-25");
check("a month in progress stops where the data stops",
  { start: covered.start, end: covered.end }, { start: "2026-10-01", end: "2026-10-25" });
check("and says it was cut", covered.clamped, true);
check("25 days, not 31", daysBetween(covered.start, covered.end), 25);

const september = { start: "2026-09-01", end: "2026-09-30" };
check("the prior month is cut to the same count, from its own start",
  matchPriorLength(september, 25), { start: "2026-09-01", end: "2026-09-25" });
check("so both sides are the same length",
  daysBetween("2026-09-01", "2026-09-25"), daysBetween(covered.start, covered.end));

// A finished month must be left alone, or every historical comparison shifts.
const august = { start: "2026-08-01", end: "2026-08-31" };
check("a month the data fully covers is untouched", clampToCoverage(august, "2026-10-25"), august);
check("and is not marked as cut", clampToCoverage(august, "2026-10-25").clamped, undefined);
check("its prior keeps its full length", matchPriorLength({ start: "2026-07-01", end: "2026-07-31" }, 31),
  { start: "2026-07-01", end: "2026-07-31" });

// A prior shorter than the window asked for is left as it is rather than
// stretched into days nobody has data for.
check("a short prior is never extended", matchPriorLength({ start: "2026-02-01", end: "2026-02-28" }, 31),
  { start: "2026-02-01", end: "2026-02-28" });

// Missing coverage must not silently empty the range.
check("no anchor, no clamp", clampToCoverage(october, null), october);

if (failures.length) {
  console.error("verify-period-compare FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("verify-period-compare: 9 cases pass, a month in progress is compared like for like.");
