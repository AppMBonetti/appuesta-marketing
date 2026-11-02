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
import { clampToCoverage, matchPriorLength, daysBetween, dataAnchoredRange } from "../src/lib/period.js";

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

// The period filter is anchored to the data, not to the clock. Picking "this
// week" off the calendar asked for 26 Oct - 1 Nov against data through the
// 25th, so the week filter rendered an empty page and looked broken.
const THROUGH = "2026-10-25"; // a Sunday
const wk = dataAnchoredRange("week", THROUGH);
check("week anchors to the last week with data",
  { start: wk.current.start, end: wk.current.end }, { start: "2026-10-19", end: "2026-10-25" });
check("a week the data covers to its end is not marked as cut", wk.clamped, false);
check("and compares against the week before",
  { start: wk.previous.start, end: wk.previous.end }, { start: "2026-10-12", end: "2026-10-18" });

// Mid-week coverage: the window stops where the data does and the prior week is
// cut to the same count from its own Monday, not to a whole week.
const midWeek = dataAnchoredRange("week", "2026-10-22"); // a Thursday
check("a part-covered week stops at the data",
  { start: midWeek.current.start, end: midWeek.current.end }, { start: "2026-10-19", end: "2026-10-22" });
check("and says it was cut", midWeek.clamped, true);
check("its prior week is cut to the same 4 days",
  { start: midWeek.previous.start, end: midWeek.previous.end }, { start: "2026-10-12", end: "2026-10-15" });

const mth = dataAnchoredRange("month", THROUGH);
check("month anchors to the month the data ends in",
  { start: mth.current.start, end: mth.current.end }, { start: "2026-10-01", end: "2026-10-25" });
check("against the same days of the month before",
  { start: mth.previous.start, end: mth.previous.end }, { start: "2026-09-01", end: "2026-09-25" });

// A day is the last covered day, compared against the day before it.
const day = dataAnchoredRange("day", THROUGH);
check("day is the last covered day",
  { start: day.current.start, end: day.current.end }, { start: "2026-10-25", end: "2026-10-25" });
check("compared against the day before",
  { start: day.previous.start, end: day.previous.end }, { start: "2026-10-24", end: "2026-10-24" });
check("a day is never marked as cut", day.clamped, false);
check("a day crossing a month boundary still steps back one day",
  dataAnchoredRange("day", "2026-11-01").previous, { start: "2026-10-31", end: "2026-10-31" });

// A custom span is answered as typed, trimmed at the data, and has no prior.
const custom = dataAnchoredRange("custom", THROUGH, "2026-10-01", "2026-10-31");
check("a custom span is trimmed at the data",
  { start: custom.current.start, end: custom.current.end }, { start: "2026-10-01", end: "2026-10-25" });
check("a custom span has no comparison period", custom.previous, null);
check("an inverted custom span is refused",
  dataAnchoredRange("custom", THROUGH, "2026-10-31", "2026-10-01"), null);

if (failures.length) {
  console.error("verify-period-compare FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("verify-period-compare: 24 cases pass, periods are anchored to the data and compared like for like.");
