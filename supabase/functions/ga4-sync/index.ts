// Pulls GA4 traffic straight from Google and writes it into the two tables the
// Semana a semana screen reads. This is what replaces Supermetrics: the Data
// API is free, and the only thing that ever expired was a reseller's trial.
//
// Everything decidable without a network lives in ./ga4.js, which runs under
// Node so the build can test it. This file is the runtime: secrets, fetch and
// the upsert.
//
// Secrets it needs, set on the Supabase project (never in this repo):
//
//   GA4_SERVICE_ACCOUNT   the service account's JSON key, verbatim
//   GA4_PROPERTY_ID       the GA4 property, e.g. 545967787 (Appuesta RD)
//   GA4_SYNC_TOKEN        the shared token the daily schedule calls with; the
//                         same value lives in Vault as `ga4_sync_token`
//
// `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by the platform.
// The service role is used on purpose: this function is not a signed-in team
// member, and `ga4_channel_daily` is behind `is_team_member()` like everything
// else. The key never leaves the function.

import {
  addDays,
  recordsFromReport,
  signAssertion,
  toChannelRows,
  toSourceMediumRows,
  yesterdayInZone,
} from "./ga4.js";

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const DIMENSIONS = ["date", "sessionDefaultChannelGroup", "sessionSourceMedium"];
// keyEvents replaced conversions in 2024. A property that still reports the
// old name makes the whole request fail, so the retry below drops to it rather
// than losing the entire pull over one column.
const METRICS = ["sessions", "activeUsers", "newUsers", "engagementRate", "keyEvents"];
const METRICS_FALLBACK = ["sessions", "activeUsers", "newUsers", "engagementRate"];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });

async function accessToken(serviceAccount: Record<string, string>): Promise<string> {
  const assertion = await signAssertion(serviceAccount, SCOPE);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    // Google's own description is the only useful thing here: "invalid_grant"
    // means the clock or the key, "access_denied" means the service account was
    // never added to the property.
    throw new Error(`Google refused the assertion: ${body.error ?? res.status} — ${body.error_description ?? ""}`);
  }
  return body.access_token as string;
}

/** Every row of one report, following GA4's paging rather than hoping one page is enough. */
async function runReport(
  token: string,
  propertyId: string,
  metrics: string[],
  start: string,
  end: string,
): Promise<Record<string, string | null>[]> {
  const records: Record<string, string | null>[] = [];
  const limit = 100000;
  let offset = 0;

  for (;;) {
    const res = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          dateRanges: [{ startDate: start, endDate: end }],
          dimensions: DIMENSIONS.map(name => ({ name })),
          metrics: metrics.map(name => ({ name })),
          limit,
          offset,
          // A day a source saw no traffic gets no row, which is what both
          // tables want: they store what happened, and the weekly views read
          // an absent row as absent rather than as zero.
          keepEmptyRows: false,
        }),
      },
    );
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`GA4 runReport failed (${res.status}): ${body?.error?.message ?? JSON.stringify(body)}`);
    }
    records.push(...recordsFromReport(body));
    const total = Number(body.rowCount ?? records.length);
    offset += limit;
    if (offset >= total || !body.rows?.length) break;
  }
  return records;
}

async function upsert(
  supabaseUrl: string,
  serviceKey: string,
  table: string,
  onConflict: string,
  rows: unknown[],
) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await fetch(
      `${supabaseUrl}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          authorization: `Bearer ${serviceKey}`,
          "content-type": "application/json",
          prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(chunk),
      },
    );
    if (!res.ok) throw new Error(`upsert into ${table} failed (${res.status}): ${await res.text()}`);
  }
}

/** The day after the last one already stored, backed up two days. */
async function defaultStart(supabaseUrl: string, serviceKey: string): Promise<string> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/ga4_channel_daily?select=date&order=date.desc&limit=1`,
    { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } },
  );
  const rows = res.ok ? await res.json() : [];
  // Two days of overlap on purpose: GA4 keeps revising the most recent days as
  // late hits are attributed, and an upsert makes re-reading them free.
  // With nothing stored, start where operations did.
  return rows?.[0]?.date ? addDays(rows[0].date, -2) : "2026-08-10";
}

/**
 * Constant-time string compare, so the token check does not leak its answer
 * one character at a time.
 */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  // This function writes to the database with the service role, so it cannot be
  // an open endpoint. It is deployed without the platform's JWT check — the
  // daily schedule calls it from inside Postgres, which has no session to
  // present — and does its own instead, against a token that exists in exactly
  // two places: this function's secrets and the project's Vault, where the
  // cron job reads it. Missing token means refuse everything, never allow.
  const expected = Deno.env.get("GA4_SYNC_TOKEN");
  const provided = req.headers.get("x-ga4-sync-token") ?? "";
  if (!expected) {
    return json({ status: "error", error: "GA4_SYNC_TOKEN is not set on this function; refusing every request until it is" }, 503);
  }
  if (!sameSecret(expected, provided)) {
    return json({ status: "error", error: "unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const rawServiceAccount = Deno.env.get("GA4_SERVICE_ACCOUNT");
  const propertyId = Deno.env.get("GA4_PROPERTY_ID");

  // Not configured is not an error. The daily schedule runs whether or not the
  // Google side has been set up, and a cron job failing every morning is noise
  // that teaches everyone to ignore it.
  if (!rawServiceAccount || !propertyId) {
    return json({
      status: "not_configured",
      missing: [
        !rawServiceAccount ? "GA4_SERVICE_ACCOUNT" : null,
        !propertyId ? "GA4_PROPERTY_ID" : null,
      ].filter(Boolean),
      note: "Set these as secrets on the Supabase project. Nothing was written.",
    });
  }
  if (!supabaseUrl || !serviceKey) {
    return json({ status: "error", error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from the function environment" }, 500);
  }

  try {
    let serviceAccount: Record<string, string>;
    try {
      serviceAccount = JSON.parse(rawServiceAccount);
    } catch {
      throw new Error("GA4_SERVICE_ACCOUNT is not valid JSON — paste the key file whole, braces included");
    }
    if (!serviceAccount.client_email || !serviceAccount.private_key) {
      throw new Error("GA4_SERVICE_ACCOUNT is missing client_email or private_key");
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const end: string = body.end ?? yesterdayInZone();
    const start: string = body.start ?? await defaultStart(supabaseUrl, serviceKey);

    const token = await accessToken(serviceAccount);

    let records;
    let metricsUsed = METRICS;
    try {
      records = await runReport(token, propertyId, METRICS, start, end);
    } catch (e) {
      if (!String(e).includes("keyEvents")) throw e;
      metricsUsed = METRICS_FALLBACK;
      records = await runReport(token, propertyId, METRICS_FALLBACK, start, end);
    }

    const channelRows = toChannelRows(records);
    const sourceMediumRows = toSourceMediumRows(records);

    if (channelRows.length) {
      await upsert(supabaseUrl, serviceKey, "ga4_channel_daily", "date,channel", channelRows);
    }
    if (sourceMediumRows.length) {
      await upsert(supabaseUrl, serviceKey, "ga4_source_medium_daily", "date,source_medium", sourceMediumRows);
    }

    // The Imports screen's log is where anybody looks to see whether a source
    // is current, so a pull that nobody watched still has to appear there.
    await fetch(`${supabaseUrl}/rest/v1/data_imports`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify({
        source: "GA4",
        filename: `GA4 Data API · property ${propertyId}`,
        row_count: channelRows.length + sourceMediumRows.length,
        status: "success",
        period_start: start,
        period_end: end,
      }),
    });

    return json({
      status: "ok",
      property: propertyId,
      range: { start, end },
      metrics: metricsUsed,
      channel_rows: channelRows.length,
      source_medium_rows: sourceMediumRows.length,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await fetch(`${supabaseUrl}/rest/v1/data_imports`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify({
        source: "GA4",
        // data_imports has no column for a reason, and the Imports log shows
        // the filename, so that is where a failed pull has to say what went
        // wrong — otherwise the row is a red mark with no explanation.
        filename: `GA4 Data API — ${message}`.slice(0, 300),
        row_count: 0,
        status: "error",
      }),
    }).catch(() => {});
    return json({ status: "error", error: message }, 500);
  }
});
