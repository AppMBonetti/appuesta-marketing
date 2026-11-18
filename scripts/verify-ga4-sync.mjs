// The GA4 Data API pull, checked in the build.
//
// The Edge Function cannot be run here — it needs a Google key and the Deno
// runtime — but the parts that would fail silently are not the network ones.
// They are: signing the assertion Google asks for, reading its report by
// header name rather than by position, and producing rows whose keys match the
// two tables. All three live in ga4.js and all three run under Node, because
// WebCrypto is the same API in both runtimes.
//
// The last check here is the one that matters most over time: the API pull and
// the file importer write to the SAME primary key, `(date, source_medium)`. If
// they ever disagree about how to spell "google / organic", one week of
// traffic lands twice under two spellings and the table quietly double-counts
// itself. So they are asserted to agree, on the same inputs, in the build.
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  addDays,
  canonicalSourceMedium,
  isoFromCompact,
  pkcs8FromPem,
  recordsFromReport,
  signAssertion,
  toChannelRows,
  toSourceMediumRows,
  yesterdayInZone,
} from "../supabase/functions/ga4-sync/ga4.js";
import { normalizeSourceMedium } from "../src/lib/importers/ga4.js";

const failures = [];
let checks = 0;
const check = (label, got, want) => {
  checks += 1;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures.push(`${label}:\n     got      ${JSON.stringify(got)}\n     expected ${JSON.stringify(want)}`);
  }
};

// --- dates -----------------------------------------------------------------

check("GA4's compact date becomes an ISO date", isoFromCompact("20261102"), "2026-11-02");
check("anything else is refused", isoFromCompact("2026-11-02"), null);
check("so is a short number", isoFromCompact("202611"), null);
check("days are added across a month end", addDays("2026-10-31", 1), "2026-11-01");
check("and subtracted across one", addDays("2026-11-01", -2), "2026-10-30");
check("and across a year end", addDays("2026-12-31", 1), "2027-01-01");

// Santo Domingo is UTC-4 all year. At 02:00 UTC on the 3rd it is still the 2nd
// there, so "yesterday" is the 1st — asking Google for the 2nd would pull a day
// that has not finished in the property's own timezone.
check("yesterday is the property's yesterday, not UTC's",
  yesterdayInZone(new Date("2026-11-03T02:00:00Z")), "2026-11-01");
check("and once the local day has turned, it moves",
  yesterdayInZone(new Date("2026-11-03T05:00:00Z")), "2026-11-02");

// --- reading the report ----------------------------------------------------

// The shape Google actually returns: headers separate from values, values all
// strings, dates compact.
const report = {
  dimensionHeaders: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }, { name: "sessionSourceMedium" }],
  metricHeaders: [
    { name: "sessions", type: "TYPE_INTEGER" },
    { name: "activeUsers", type: "TYPE_INTEGER" },
    { name: "newUsers", type: "TYPE_INTEGER" },
    { name: "engagementRate", type: "TYPE_FLOAT" },
    { name: "keyEvents", type: "TYPE_INTEGER" },
  ],
  rows: [
    { dimensionValues: [{ value: "20261102" }, { value: "Paid Social" }, { value: "facebook / cpc" }],
      metricValues: [{ value: "100" }, { value: "80" }, { value: "60" }, { value: "0.4" }, { value: "2" }] },
    { dimensionValues: [{ value: "20261102" }, { value: "Paid Social" }, { value: "instagram / cpc" }],
      metricValues: [{ value: "50" }, { value: "45" }, { value: "30" }, { value: "0.6" }, { value: "1" }] },
    { dimensionValues: [{ value: "20261102" }, { value: "Paid Social" }, { value: "tiktok / cpc" }],
      metricValues: [{ value: "50" }, { value: "40" }, { value: "25" }, { value: "0.8" }, { value: "0" }] },
    { dimensionValues: [{ value: "20261102" }, { value: "Direct" }, { value: "(direct) / (none)" }],
      metricValues: [{ value: "25" }, { value: "24" }, { value: "18" }, { value: "0.55" }, { value: "0" }] },
  ],
  rowCount: 4,
};

const records = recordsFromReport(report);
check("every row becomes a record", records.length, 4);
check("read by header name, not position", records[0], {
  date: "20261102", sessionDefaultChannelGroup: "Paid Social", sessionSourceMedium: "facebook / cpc",
  sessions: "100", activeUsers: "80", newUsers: "60", engagementRate: "0.4", keyEvents: "2",
});
check("an empty report is no records", recordsFromReport({}), []);

// A request with the dimensions in another order must still map correctly —
// reading by position is the bug this guards.
const reordered = {
  dimensionHeaders: [{ name: "sessionSourceMedium" }, { name: "date" }],
  metricHeaders: [{ name: "sessions" }],
  rows: [{ dimensionValues: [{ value: "google / organic" }, { value: "20261103" }], metricValues: [{ value: "7" }] }],
};
check("reordering the dimensions does not re-map the columns",
  recordsFromReport(reordered)[0], { sessionSourceMedium: "google / organic", date: "20261103", sessions: "7" });

// --- the rows that get written --------------------------------------------

const channelRows = toChannelRows(records);
check("one row per channel per day, not per source", channelRows.length, 2);
const paid = channelRows.find(r => r.channel === "Paid Social");
check("the channel's sessions are summed across its sources", paid.sessions, 200);
check("users are summed too", paid.active_users, 165);
check("new users are summed too", paid.new_users, 115);
check("key events land in the conversions column", paid.conversions, 3);
// (0.4*100 + 0.6*50 + 0.8*50) / 200 = 0.55
check("the engagement rate is re-weighted by sessions", paid.engagement_rate, 0.55);
check("GA4 returns it as a fraction and it is stored as one",
  channelRows.find(r => r.channel === "Direct").engagement_rate, 0.55);
check("the channel row carries exactly the table's columns",
  Object.keys(paid).sort(),
  ["active_users", "channel", "conversions", "date", "engagement_rate", "new_users", "sessions"]);

const smRows = toSourceMediumRows(records);
check("every source keeps its own row", smRows.length, 4);
check("and carries the channel it belongs to",
  smRows.find(r => r.source_medium === "instagram / cpc").channel, "Paid Social");
check("a source's figures are not rolled up",
  smRows.find(r => r.source_medium === "instagram / cpc").sessions, 50);
check("the source/medium row carries exactly the table's columns",
  Object.keys(smRows[0]).sort(),
  ["active_users", "channel", "conversions", "date", "engagement_rate", "medium", "new_users", "sessions", "source", "source_medium"]);
check("both tables account for the same sessions",
  [channelRows.reduce((t, r) => t + r.sessions, 0), smRows.reduce((t, r) => t + r.sessions, 0)],
  [225, 225]);

// A property with no keyEvents metric: the fallback request omits it, and the
// column must come back null rather than 0 — the file importer's rule too.
const noKeyEvents = recordsFromReport({
  dimensionHeaders: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
  metricHeaders: [{ name: "sessions" }],
  rows: [{ dimensionValues: [{ value: "20261102" }, { value: "Direct" }], metricValues: [{ value: "9" }] }],
});
check("a metric the property does not report is null, not zero",
  toChannelRows(noKeyEvents)[0].conversions, null);
check("and so are the users it did not report",
  toChannelRows(noKeyEvents)[0].active_users, null);

// --- the two writers must spell the key the same way -----------------------

for (const pair of [
  "google / organic", "google/organic", "  google  /  organic ",
  "(direct) / (none)", "facebook / cpc", "l.instagram.com / referral", "(not set)",
]) {
  const fromApi = canonicalSourceMedium(pair);
  const fromFile = normalizeSourceMedium({ source_medium: pair });
  check(`the API and the file importer agree on "${pair}"`, fromApi, fromFile);
}

// --- the assertion Google is sent ------------------------------------------

// A real RSA key, generated here. It is not a credential: it exists for the
// length of this script and signs one test token.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const serviceAccount = { client_email: "ga4-sync@example.iam.gserviceaccount.com", private_key: privateKey };
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const now = Date.UTC(2026, 10, 18, 12, 0, 0);
const token = await signAssertion(serviceAccount, SCOPE, now);

const [headerB64, claimsB64, signatureB64] = token.split(".");
const unb64 = s => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const header = JSON.parse(unb64(headerB64).toString());
const claims = JSON.parse(unb64(claimsB64).toString());

check("the assertion has three parts", token.split(".").length, 3);
check("signed RS256, as Google requires", header, { alg: "RS256", typ: "JWT" });
check("issued by the service account", claims.iss, serviceAccount.client_email);
check("for the analytics read scope", claims.scope, SCOPE);
check("to Google's token endpoint", claims.aud, "https://oauth2.googleapis.com/token");
// Backdated a minute: Google rejects an assertion issued in its own future,
// and a container clock seconds ahead is enough to cause it.
check("issued a minute in the past", claims.iat, Math.floor(now / 1000) - 60);
check("and valid for an hour from there", claims.exp - claims.iat, 3600);
check("no padding survives in the base64url", /[=+/]/.test(token), false);

// The real test: Google will verify this signature, so verify it here.
const verifier = createVerify("RSA-SHA256");
verifier.update(`${headerB64}.${claimsB64}`);
check("the signature verifies against the public key",
  verifier.verify(publicKey, unb64(signatureB64)), true);

// A key pasted with its newlines still escaped is the commonest way this
// breaks, and it has to keep working.
const escaped = { ...serviceAccount, private_key: privateKey.replace(/\n/g, "\\n") };
const escapedToken = await signAssertion(escaped, SCOPE, now);
check("a key whose newlines arrived escaped still signs", escapedToken, token);

let pemError = null;
try { pkcs8FromPem(""); } catch (e) { pemError = e.message; }
check("an empty key says so rather than signing nothing", pemError, "service account private_key is empty");

if (failures.length) {
  console.error(`verify-ga4-sync: ${failures.length} failure(s)\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`verify-ga4-sync: ${checks} cases pass, the assertion verifies and both writers spell the key the same way.`);
