// The parts of the GA4 pull that can be wrong without anything failing loudly:
// signing the assertion Google asks for, reading its report shape, and turning
// its rows into the two tables' columns.
//
// Plain .js rather than .ts so `scripts/verify-ga4-sync.mjs` can import it
// under Node and exercise it for real — the signing included, since WebCrypto
// is the same API in Node 22 and in Deno. `index.ts` holds only what genuinely
// needs the Deno runtime: environment, fetch and the upsert.

/** GA4 writes dates as 20261102. Everything downstream wants 2026-11-02. */
export function isoFromCompact(value) {
  const m = String(value ?? "").match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** 2026-11-02 shifted by n days, as a plain date string. */
export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/**
 * Yesterday in the reporting timezone.
 *
 * GA4's own day boundary is the property's timezone, and the dashboard reports
 * in America/Santo_Domingo. Asking for "today" would pull a part-day that the
 * next run then has to correct, so the window ends on the last day that is
 * actually over.
 */
export function yesterdayInZone(now = new Date(), timeZone = "America/Santo_Domingo") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return addDays(parts, -1);
}

/**
 * One canonical "source / medium", the same rule the file importer applies.
 *
 * The API is consistent about the spacing where a spreadsheet export is not,
 * but the two paths write to the same primary key, so they have to agree or
 * one week arrives twice under two spellings. `scripts/verify-ga4-sync.mjs`
 * asserts this function and the importer's agree on the same inputs.
 */
export function canonicalSourceMedium(pair) {
  const text = String(pair ?? "").trim();
  if (!text) return null;
  const parts = text.split("/").map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { source_medium: `${parts[0]} / ${parts[1]}`, source: parts[0], medium: parts[1] };
  const only = parts[0] ?? text;
  return { source_medium: only, source: only, medium: null };
}

/**
 * A runReport response as plain records keyed by the header names that were
 * asked for. Reading by position would silently re-map every column the day a
 * dimension is added to the request.
 */
export function recordsFromReport(report) {
  const dimensionNames = (report?.dimensionHeaders || []).map(h => h.name);
  const metricNames = (report?.metricHeaders || []).map(h => h.name);
  return (report?.rows || []).map(row => {
    const out = {};
    dimensionNames.forEach((name, i) => { out[name] = row.dimensionValues?.[i]?.value ?? null; });
    metricNames.forEach((name, i) => { out[name] = row.metricValues?.[i]?.value ?? null; });
    return out;
  });
}

// GA4 returns every metric as a string. An absent metric — one the property
// does not have, such as keyEvents on an older property — must stay null
// rather than become 0, for the reason the file importer has the same rule:
// zero is a claim and null is the absence of one.
const int = v => (v == null || v === "" ? null : Math.round(Number(v)));
const rate = v => (v == null || v === "" ? null : Number(v));

function metrics(record) {
  return {
    sessions: int(record.sessions) ?? 0,
    active_users: int(record.activeUsers),
    new_users: int(record.newUsers),
    // GA4 returns engagementRate as a fraction (0.7239 is 72.39%), which is
    // what the column holds, so it is stored as given.
    engagement_rate: rate(record.engagementRate),
    conversions: int(record.keyEvents ?? record.conversions),
  };
}

export function toChannelRows(records) {
  const merged = new Map();
  for (const r of records) {
    const date = isoFromCompact(r.date);
    const channel = (r.sessionDefaultChannelGroup ?? "").trim();
    if (!date || !channel) continue;
    const key = `${date}|${channel}`;
    const seed = { date, channel, ...metrics(r) };
    const prev = merged.get(key);
    if (!prev) { merged.set(key, seed); continue; }
    accumulate(prev, seed);
  }
  return [...merged.values()];
}

export function toSourceMediumRows(records) {
  const merged = new Map();
  for (const r of records) {
    const date = isoFromCompact(r.date);
    const pair = canonicalSourceMedium(r.sessionSourceMedium);
    if (!date || !pair) continue;
    const key = `${date}|${pair.source_medium}`;
    const seed = {
      date,
      source_medium: pair.source_medium,
      source: pair.source,
      medium: pair.medium,
      channel: (r.sessionDefaultChannelGroup ?? "").trim() || null,
      ...metrics(r),
    };
    const prev = merged.get(key);
    if (!prev) { merged.set(key, seed); continue; }
    accumulate(prev, seed);
  }
  return [...merged.values()];
}

// Two spellings of one source/medium, or one channel reached through several
// sources, land on the same key. Sessions and users add; the engagement rate is
// a ratio and is re-weighted by sessions, exactly as the file importer does it.
function accumulate(prev, seed) {
  const total = prev.sessions + seed.sessions;
  if (prev.engagement_rate != null || seed.engagement_rate != null) {
    prev.engagement_rate = total > 0
      ? ((prev.engagement_rate ?? 0) * prev.sessions + (seed.engagement_rate ?? 0) * seed.sessions) / total
      : null;
  }
  prev.sessions = total;
  for (const col of ["active_users", "new_users", "conversions"]) {
    if (seed[col] != null) prev[col] = (prev[col] ?? 0) + seed[col];
  }
  if (prev.channel == null && seed.channel != null) prev.channel = seed.channel;
}

// --- the Google assertion ---------------------------------------------------

const enc = new TextEncoder();

function base64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const base64urlJson = obj => base64url(enc.encode(JSON.stringify(obj)));

/**
 * The PKCS#8 bytes inside a service account's `private_key`.
 *
 * The JSON key carries the PEM with literal \n escapes, which JSON.parse turns
 * back into newlines — but a key pasted into a dashboard secret field often
 * keeps them as two characters, and then the base64 body is still intact while
 * the header line is not. Stripping every kind of whitespace and the armour
 * handles both without caring which one arrived.
 */
export function pkcs8FromPem(pem) {
  const body = String(pem ?? "")
    .replace(/\\n/g, "\n")
    .replace(/-----[A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("service account private_key is empty");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * The signed JWT Google exchanges for an access token.
 *
 * `iat` is pushed one minute into the past: Google rejects an assertion issued
 * in its own future, and a container clock a few seconds ahead is enough to
 * trigger it — a failure that looks like a bad key rather than a clock.
 */
export async function signAssertion(serviceAccount, scope, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000) - 60;
  const claims = {
    iss: serviceAccount.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  const signingInput = `${base64urlJson({ alg: "RS256", typ: "JWT" })}.${base64urlJson(claims)}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8FromPem(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
