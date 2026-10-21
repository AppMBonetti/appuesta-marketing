// Week bucketing checks for the traffic chart, run as part of the build.
//
// Two things here are easy to get wrong and invisible once they are:
//
// A week runs Monday to Sunday, the same boundary weekly_kpis uses. Off by one
// and a traffic week stops lining up with a KPI week while both still look
// plausible — the chart would simply disagree with the weekly report.
//
// A week the selected range only partly covers has to be flagged, because it is
// drawn at its real height and reads as traffic collapsing. It is decided from
// the range, never from how many days carry rows: GA4 writes nothing for a
// channel on a day it saw no sessions, so counting present days would call a
// quiet week an incomplete one.
import { pivotSessions } from "../src/lib/metrics.js";

const rows = [
  // Sunday — belongs to the week that started Monday the 12th.
  { date: "2026-10-18", channel: "Direct", sessions: 7 },
  { date: "2026-10-18", channel: "Referral", sessions: 3 },
  // Monday — starts a new bucket.
  { date: "2026-10-19", channel: "Direct", sessions: 5 },
  { date: "2026-10-13", channel: "Direct", sessions: 11 },
  { date: "2026-10-13", channel: "Referral", sessions: 1 },
  // Monday the 12th itself, the first day of its own week.
  { date: "2026-10-12", channel: "Direct", sessions: 2 },
];

const failures = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures.push(`${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};

const full = { start: "2026-10-12", end: "2026-10-26" };
const weeks = pivotSessions(rows, "week", full);

check("bucket starts", weeks.map(w => w.date), ["2026-10-12", "2026-10-19"]);
check("Sunday lands in the Monday-12 week", weeks[0].Direct + weeks[0].Referral, 24);
check("Monday opens the next week", weeks[1].Direct, 5);
check("every channel present in every bucket", weeks.every(w => "Referral" in w), true);

// The range covers both weeks whole, so neither is partial — even though the
// second one carries a single day of data.
check("complete weeks are not flagged", weeks.map(w => w.partial), [false, false]);

// Cut the range short on both sides: the first week now starts before it and
// the second runs past its end.
const clipped = pivotSessions(rows, "week", { start: "2026-10-13", end: "2026-10-20" });
check("weeks clipped by the range are flagged", clipped.map(w => w.partial), [true, true]);

// No range means no claim either way.
check("no range, no partial flag", pivotSessions(rows, "week").map(w => w.partial), [false, false]);

// Day grain must keep every day separate and lose nothing.
const days = pivotSessions(rows, "day");
check("one bucket per day, in order", days.map(d => d.date),
  ["2026-10-12", "2026-10-13", "2026-10-18", "2026-10-19"]);
const dayTotal = days.reduce((sum, d) => sum + d.Direct + d.Referral, 0);
check("day grain total", dayTotal, rows.reduce((sum, r) => sum + r.sessions, 0));

if (failures.length) {
  console.error("verify-week-buckets FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("verify-week-buckets: 9 cases pass, weeks start Monday and clipped weeks are flagged.");
