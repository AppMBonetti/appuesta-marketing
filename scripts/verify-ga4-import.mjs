// The GA4 import's row building, checked in the build.
//
// One export now feeds two tables — `ga4_channel_daily` keyed on
// (date, channel) and `ga4_source_medium_daily` keyed on (date, source_medium)
// — and both keys have to survive a file that carries the other dimension too.
// A GA4 export with channel AND source/medium repeats every (date, channel)
// pair once per source inside it, so the channel rows are only right if those
// repeats are summed. Letting the last one win would under-report every paid
// channel by however many sources it has, and nothing on screen would look
// broken: the shape of the chart stays the same, the numbers are just smaller.
//
// The source/medium string is the primary key, so its spelling is load-bearing.
// GA4 writes "google / organic" in the interface and "google/organic" in some
// API exports; two spellings of one key means one week of traffic stored twice
// and a table that double-counts itself.
import { buildGa4Rows, normalizeSourceMedium, parseGa4File } from "../src/lib/importers/ga4.js";

const failures = [];
let checks = 0;
const check = (label, got, want) => {
  checks += 1;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures.push(`${label}:\n     got      ${JSON.stringify(got)}\n     expected ${JSON.stringify(want)}`);
  }
};

const channel = (rows, date, name) =>
  buildGa4Rows(rows).channelRows.find(r => r.date === date && r.channel === name);
const pair = (rows, date, name) =>
  buildGa4Rows(rows).sourceMediumRows.find(r => r.date === date && r.source_medium === name);

// --- the pair string -------------------------------------------------------

check("the interface's spelling", normalizeSourceMedium({ source_medium: "google / organic" }),
  { source_medium: "google / organic", source: "google", medium: "organic" });
check("the API's spelling collapses to the same value", normalizeSourceMedium({ source_medium: "google/organic" }),
  { source_medium: "google / organic", source: "google", medium: "organic" });
check("extra whitespace collapses too", normalizeSourceMedium({ source_medium: "  google  /  organic " }),
  { source_medium: "google / organic", source: "google", medium: "organic" });
check("separate dimensions are joined the same way", normalizeSourceMedium({ source: "facebook", medium: "cpc" }),
  { source_medium: "facebook / cpc", source: "facebook", medium: "cpc" });
check("a pair with no medium keeps its source as the key", normalizeSourceMedium({ source_medium: "(direct)" }),
  { source_medium: "(direct)", source: "(direct)", medium: null });
check("a missing half is named, not dropped", normalizeSourceMedium({ source: "newsletter" }),
  { source_medium: "newsletter / (not set)", source: "newsletter", medium: "(not set)" });
check("neither half is no pair at all", normalizeSourceMedium({ source: "", medium: null }), null);
// GA4's own "(direct) / (none)" has to stay exactly that, because it is the
// row every untagged visit lands in and it is compared against the interface.
check("GA4's direct row is untouched", normalizeSourceMedium({ source_medium: "(direct) / (none)" }),
  { source_medium: "(direct) / (none)", source: "(direct)", medium: "(none)" });

// --- a channel-only export (every file loaded before this change) ----------

const channelOnly = [
  { date: "2026-11-02", channel: "Paid Social", sessions: 120, active_users: 90, new_users: 70, engagement_rate: 0.5, conversions: 3 },
  { date: "2026-11-02", channel: "Direct", sessions: 40, active_users: 35, new_users: 10, engagement_rate: 0.75, conversions: 1 },
];
check("channel rows come through", buildGa4Rows(channelOnly).channelRows.length, 2);
check("and nothing is invented for the other table", buildGa4Rows(channelOnly).sourceMediumRows, []);
check("coverage spans the file", buildGa4Rows(channelOnly).coverage, { start: "2026-11-02", end: "2026-11-02" });

// --- a source/medium-only export ------------------------------------------

const pairOnly = [
  { date: "2026-11-02", source_medium: "google / organic", sessions: 55 },
  { date: "2026-11-03", source_medium: "facebook / paid", sessions: 10 },
];
check("pair rows come through", buildGa4Rows(pairOnly).sourceMediumRows.length, 2);
check("and the channel table is left alone", buildGa4Rows(pairOnly).channelRows, []);
check("channel is null when the export had no channel column",
  pair(pairOnly, "2026-11-02", "google / organic").channel, null);
check("coverage spans both days", buildGa4Rows(pairOnly).coverage, { start: "2026-11-02", end: "2026-11-03" });

// --- both dimensions in one file: the case that makes or breaks the keys ----

// This is the shape of the export worth asking for, and the one that repeats a
// channel once per source inside it. Paid Social arrives as three rows.
const both = [
  { date: "2026-11-02", channel: "Paid Social", source_medium: "facebook / cpc", sessions: 100, active_users: 80, new_users: 60, engagement_rate: 0.40, conversions: 2 },
  { date: "2026-11-02", channel: "Paid Social", source_medium: "instagram / cpc", sessions: 50, active_users: 45, new_users: 30, engagement_rate: 0.60, conversions: 1 },
  { date: "2026-11-02", channel: "Paid Social", source_medium: "tiktok / cpc", sessions: 50, active_users: 40, new_users: 25, engagement_rate: 0.80, conversions: 0 },
  { date: "2026-11-02", channel: "Organic Search", source_medium: "google / organic", sessions: 30, active_users: 28, new_users: 20, engagement_rate: 0.70, conversions: 1 },
];
check("the channel's sessions are summed across its sources", channel(both, "2026-11-02", "Paid Social").sessions, 200);
check("users are summed too", channel(both, "2026-11-02", "Paid Social").active_users, 165);
check("new users are summed too", channel(both, "2026-11-02", "Paid Social").new_users, 115);
check("conversions are summed too", channel(both, "2026-11-02", "Paid Social").conversions, 3);
// (0.40*100 + 0.60*50 + 0.80*50) / 200 = (40 + 30 + 40) / 200 = 0.55
check("engagement rate is re-weighted by sessions, not averaged",
  channel(both, "2026-11-02", "Paid Social").engagement_rate, 0.55);
check("one channel row per channel, not per source", buildGa4Rows(both).channelRows.length, 2);
check("and every source keeps its own row", buildGa4Rows(both).sourceMediumRows.length, 4);
check("each source carries the channel it belongs to",
  pair(both, "2026-11-02", "instagram / cpc").channel, "Paid Social");
check("a source's own figures are not rolled up",
  pair(both, "2026-11-02", "instagram / cpc").sessions, 50);

// The whole file must still add up to the same traffic whichever way it is cut.
const built = buildGa4Rows(both);
const sum = (rows, col) => rows.reduce((t, r) => t + (r[col] ?? 0), 0);
check("both tables account for the same sessions",
  [sum(built.channelRows, "sessions"), sum(built.sourceMediumRows, "sessions")], [230, 230]);

// --- the two spellings arriving in one file --------------------------------

const mixedSpelling = [
  { date: "2026-11-02", source_medium: "google / organic", sessions: 10, engagement_rate: 0.5 },
  { date: "2026-11-02", source_medium: "google/organic", sessions: 30, engagement_rate: 0.9 },
];
check("one key, not two", buildGa4Rows(mixedSpelling).sourceMediumRows.length, 1);
check("and their sessions are added", pair(mixedSpelling, "2026-11-02", "google / organic").sessions, 40);
// (0.5*10 + 0.9*30) / 40 = (5 + 27) / 40 = 0.8
check("with the rate re-weighted across both", pair(mixedSpelling, "2026-11-02", "google / organic").engagement_rate, 0.8);

// --- engagement rate as a percentage --------------------------------------

check("a percentage is scaled back to a fraction",
  channel([{ date: "2026-11-02", channel: "Direct", sessions: 10, engagement_rate: 76.52 }], "2026-11-02", "Direct").engagement_rate,
  0.7652);
check("a string percentage too",
  channel([{ date: "2026-11-02", channel: "Direct", sessions: 10, engagement_rate: "54.5%" }], "2026-11-02", "Direct").engagement_rate,
  0.545);
// 1 is a legitimate rate — every session engaged — and must not be divided.
check("a rate of exactly 1 is left alone",
  channel([{ date: "2026-11-02", channel: "Direct", sessions: 10, engagement_rate: 1 }], "2026-11-02", "Direct").engagement_rate,
  1);

// --- missing figures stay missing -----------------------------------------

const noUsers = [{ date: "2026-11-02", channel: "Direct", sessions: 10 }];
check("an absent column is null, not zero", channel(noUsers, "2026-11-02", "Direct").new_users, null);
check("absent users are null too", channel(noUsers, "2026-11-02", "Direct").active_users, null);
// The 101 rows loaded before new_users existed are exactly this case: summing
// a null into a 0 would make them claim nobody was new that week.
const oneSideNull = [
  { date: "2026-11-02", channel: "Direct", sessions: 10 },
  { date: "2026-11-02", channel: "Direct", sessions: 5, new_users: 4 },
];
check("a known figure survives beside a missing one", channel(oneSideNull, "2026-11-02", "Direct").new_users, 4);

// --- rows that carry nothing usable ---------------------------------------

const junk = [
  { date: "", channel: "Direct", sessions: 99 },
  { date: "2026-11-02", sessions: 99 },
  { date: "2026-11-02", channel: "Direct", sessions: 7 },
];
check("a row with no date is dropped", buildGa4Rows(junk).channelRows.length, 1);
check("a row with neither dimension is dropped too", buildGa4Rows(junk).sourceMediumRows, []);
check("and the dropped rows take their sessions with them",
  channel(junk, "2026-11-02", "Direct").sessions, 7);
check("coverage ignores the undated row", buildGa4Rows(junk).coverage, { start: "2026-11-02", end: "2026-11-02" });

// --- the two file shapes, read the way the import reads them ---------------
//
// Everything above tests the row building. These two test the reading, which is
// where an import fails in a way nobody can diagnose: a header the map doesn't
// know, or — worse — a delimiter guessed off the wrong line.
//
// A GA4 interface export opens with "#" comment lines. The delimiter used to be
// taken from the first line, which in that file carries no comma, so the whole
// file came back as one column per row and the import failed saying there was
// no date column. The fix lives in parseWorkbook, shared by every importer, so
// it is guarded here rather than only by hand.

const fakeFile = (name, text) => ({ name, text: async () => text });

// A GA4 interface export, Spanish property, "#" preamble, compact dates.
const ga4Ui = await parseGa4File(fakeFile("traffic.csv", `# ----------------------------------------
# Todos los usuarios
# Adquisición de tráfico
# 20261102-20261108
# ----------------------------------------

Fecha,Fuente / medio de la sesión,Grupo de canales predeterminado de la sesión,Sesiones,Usuarios activos,Usuarios nuevos,Tasa de interacciones,Eventos clave
20261102,facebook / cpc,Paid Social,100,80,60,0.42,2
20261102,google / organic,Organic Search,30,28,20,0.71,1
20261103,facebook / cpc,Paid Social,90,70,50,0.39,3
`));

check("the preamble does not become the header row", ga4Ui.unmatchedHeaders, []);
// Three rows: Paid Social and Organic Search on the 2nd, Paid Social on the 3rd.
check("the Spanish labels are understood", ga4Ui.channelRows.length, 3);
check("and each day keeps its own channel row",
  ga4Ui.channelRows.map(r => `${r.date}|${r.channel}`).sort(),
  ["2026-11-02|Organic Search", "2026-11-02|Paid Social", "2026-11-03|Paid Social"]);
check("GA4's compact date is read as a date", ga4Ui.coverage, { start: "2026-11-02", end: "2026-11-03" });
check("and the figures survive the trip",
  ga4Ui.channelRows.find(r => r.channel === "Paid Social" && r.date === "2026-11-02"),
  { date: "2026-11-02", channel: "Paid Social", sessions: 100, active_users: 80, new_users: 60, conversions: 2, engagement_rate: 0.42 });
check("source/medium is filled from the same file", ga4Ui.sourceMediumRows.length, 3);

// A Supermetrics export: API field ids as headers, ISO dates, rates as percents.
const sm = await parseGa4File(fakeFile("sm.csv", `date,sessionSourceMedium,sessionDefaultChannelGrouping,sessions,activeUsers,newUsers,engagementRate,conversions
2026-11-02,facebook / cpc,Paid Social,100,80,60,42.0,2
2026-11-02,google/organic,Organic Search,30,28,20,71.0,1
`));

check("camelCase field ids are understood too", sm.unmatchedHeaders, []);
check("a percentage rate is scaled on the way in",
  sm.channelRows.find(r => r.channel === "Paid Social").engagement_rate, 0.42);
check("both spellings of the pair arrive as two sources", sm.sourceMediumRows.length, 2);

// A file that is a GA4 export of something else entirely has to say so, and
// name what it did find, or the next step is guessing.
let message = null;
try {
  await parseGa4File(fakeFile("events.csv", "Nombre del evento,Recuento de eventos\nsign_up,42\n"));
} catch (e) { message = e.message; }
check("a file with no date column is refused",
  message?.startsWith("Missing required column in GA4 file: date."), true);
check("and the refusal names the columns it saw",
  message?.includes("nombre del evento") && message?.includes("recuento de eventos"), true);

if (failures.length) {
  console.error(`verify-ga4-import: ${failures.length} failure(s)\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`verify-ga4-import: ${checks} cases pass, one export fills both tables and the week keys survive it.`);
