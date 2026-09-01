import { useEffect, useRef, useState } from "react";
import { UploadCloud, CheckCircle2, FileSpreadsheet, AlertCircle } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { SectionHeading, Panel, Spinner, fmtDOP } from "../components/ui";
import DataCoverage from "../components/DataCoverage";
import DataHealth from "../components/DataHealth";
import SnapshotRollback from "../components/SnapshotRollback";
import { parseIntargetFile } from "../lib/importers/intarget";
import { parseAltenarFile } from "../lib/importers/altenar";
import { parseGa4File } from "../lib/importers/ga4";
import { parseInstagramFile } from "../lib/importers/instagram";
import { parsePaymentsFile } from "../lib/importers/payments";
import { parseRegistrationsFile } from "../lib/importers/registrations";
import { parseFtdListFile } from "../lib/importers/ftdList";
import { upsertInChunks, SOURCE_TIMEZONE, IMPORT_TIMEZONES, timezoneShiftHours, zoneCancellingShift } from "../lib/importers/parseWorkbook";

// bets.external_user_id has a FK to players.id — if a bet references a player
// not yet imported, null out the link rather than failing the whole batch.
async function reconcileExternalUserIds(bets) {
  const ids = [...new Set(bets.map(b => b.external_user_id).filter(Boolean))];
  if (!ids.length) return { reconciled: bets, orphaned: 0 };
  const validIds = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { data, error } = await supabase.from("players").select("id").in("id", chunk);
    if (error) throw error;
    for (const row of data) validIds.add(row.id);
  }
  let orphaned = 0;
  const reconciled = bets.map(b => {
    if (b.external_user_id && !validIds.has(b.external_user_id)) {
      orphaned += 1;
      return { ...b, external_user_id: null };
    }
    return b;
  });
  return { reconciled, orphaned };
}

// The import log stores plain dates; the parsers hand back ISO timestamps.
// Uses the operator's calendar rather than the uploader's, so a snapshot taken
// late evening in Santo Domingo is not filed under the following day by someone
// importing from a machine further east.
function localDay(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SOURCE_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

function toLocalDay(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : localDay(d);
}


// Zone a report was last declared to have been generated in. Stored so a later
// upload can tell an intentional zone change apart from a template accident.
const TZ_SETTING_KEY = "altenar_source_tz";
// How bets were read before the zone was selectable, so an unset installation
// keeps reading them the same way and re-importing an old file stays a no-op.
// Verified against the exports themselves: MLB fixtures in the loaded data land
// on each park's published start time only under this reading.
const DEFAULT_SOURCE_TZ = "America/Santo_Domingo";

/**
 * Compares an incoming batch of bets against what is already stored, by bet_id.
 *
 * Two things come out of this. How many bets are already known — those get
 * updated in place by the upsert, never duplicated, which is what makes
 * overlapping date ranges safe. And whether the file's clock has moved: Altenar
 * exports carry no timezone marker, and the same bet can come back with a
 * different clock time when a report is regenerated from a differently
 * configured template — one real pair of exports differed by exactly 8 hours on
 * all 212 shared bets. Importing that unnoticed would move every bet across day
 * and week boundaries.
 */
async function compareWithStored(bets) {
  const dated = bets.filter(b => b.bet_id && b.bet_date);
  const incoming = new Map(dated.map(b => [b.bet_id, b.bet_date]));
  const ids = [...incoming.keys()];
  const shifts = new Map();
  let compared = 0;

  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const { data, error } = await supabase.from("bets").select("bet_id, bet_date").in("bet_id", chunk);
    if (error) throw error;
    for (const row of data || []) {
      const before = new Date(row.bet_date).getTime();
      const after = new Date(incoming.get(row.bet_id)).getTime();
      if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
      compared += 1;
      const hours = Math.round((after - before) / 3600000);
      shifts.set(hours, (shifts.get(hours) || 0) + 1);
    }
  }

  const known = compared;
  // Too few overlapping bets to call a shift a pattern rather than a coincidence.
  if (compared < 20) return { known, shift: null };

  const [hours, count] = [...shifts.entries()].sort((a, b) => b[1] - a[1])[0];
  // Only a shift that applies to essentially every shared bet is a zone change;
  // a handful of corrected timestamps is normal and should pass.
  if (hours !== 0 && count / compared > 0.9) return { known, shift: { hours, compared: count } };
  return { known, shift: null };
}

const CARD_DEFS = [
  { source: "Payments", labelKey: "paymentsCard", noteKey: "paymentsNote" },
  { source: "Registrations", labelKey: "registrationsCard", noteKey: "registrationsNote" },
  { source: "FTD", labelKey: "ftdCard", noteKey: "ftdNote" },
  { source: "Altenar", labelKey: "altenarCard" },
  { source: "GA4", labelKey: "ga4Card" },
  { source: "Instagram", labelKey: "instagramCard" },
  { source: "InTarget", labelKey: "intargetCard" },
];

export default function Imports({ s, lang }) {
  const [importLog, setImportLog] = useState([]);
  const [lastBySource, setLastBySource] = useState({});
  const [loadingLog, setLoadingLog] = useState(true);
  const [cardState, setCardState] = useState({}); // source -> { phase, error, result }
  const [sourceTz, setSourceTz] = useState(DEFAULT_SOURCE_TZ);
  // The zone the stored bets were read with — what an incoming file is compared
  // against. Held separately from the picker so changing the picker does not, on
  // its own, make the app believe history was re-timed.
  const storedTz = useRef(DEFAULT_SOURCE_TZ);
  // One ref object keyed by source — calling useRef per card would put a hook
  // inside a loop.
  const fileInputs = useRef({});

  async function loadSourceTz() {
    const { data } = await supabase
      .from("app_settings").select("value").eq("key", TZ_SETTING_KEY).maybeSingle();
    const value = data?.value;
    if (value && IMPORT_TIMEZONES.some(tz => tz.value === value)) {
      storedTz.current = value;
      setSourceTz(value);
    }
  }

  async function loadLog() {
    setLoadingLog(true);
    const { data, error } = await supabase
      .from("data_imports")
      .select("*")
      .order("imported_at", { ascending: false })
      .limit(50);
    if (!error) {
      setImportLog(data || []);
      const latest = {};
      for (const row of data || []) {
        if (!latest[row.source]) latest[row.source] = row;
      }
      setLastBySource(latest);
    }
    setLoadingLog(false);
  }

  useEffect(() => { loadLog(); loadSourceTz(); }, []);

  function setPhase(source, phase, extra = {}) {
    setCardState(prev => ({ ...prev, [source]: { phase, ...extra } }));
  }

  async function handleFile(source, file) {
    if (!file) return;
    try {
      setPhase(source, "parsing");

      if (source === "Payments") {
        const { transactions, unmatchedHeaders, unknownTypes, unexpectedCurrencies,
                expectedCurrency, summary, coverage } = await parsePaymentsFile(file);
        if (transactions.length === 0) throw new Error(lang === "es" ? "No se encontraron filas válidas en el archivo." : "No valid rows found in the file.");

        if (unexpectedCurrencies.length) {
          throw new Error(
            s.currencyBlocked
              .replace("{found}", unexpectedCurrencies.join(", "))
              .replaceAll("{expected}", expectedCurrency)
          );
        }

        setPhase(source, "importing");
        // transaction_id is the primary key, so re-exporting overlapping days
        // updates each row in place — including one that has since settled.
        await upsertInChunks(supabase, "payment_transactions", transactions, "transaction_id");

        // Deposit totals on the player are derived, never imported, so they can
        // never drift from the transactions they summarize.
        const { error: refreshErr } = await supabase.rpc("refresh_player_deposit_totals");
        if (refreshErr) throw refreshErr;

        setPhase(source, "logging");
        const { error: logErr } = await supabase.from("data_imports").insert({
          source, filename: file.name, row_count: transactions.length, status: "success",
          period_start: toLocalDay(coverage.start), period_end: toLocalDay(coverage.end),
        });
        if (logErr) throw logErr;

        setPhase(source, "assigning");
        const { error: rpcErr } = await supabase.rpc("assign_vip_tiers");
        if (rpcErr) throw rpcErr;

        setPhase(source, "done", { rowCount: transactions.length, unmatchedHeaders, unknownTypes, summary });
      } else if (source === "Registrations") {
        const { players, unmatchedHeaders, coverage } = await parseRegistrationsFile(file);
        if (players.length === 0) throw new Error(lang === "es" ? "No se encontraron filas válidas en el archivo." : "No valid rows found in the file.");

        setPhase(source, "importing");
        await upsertInChunks(supabase, "players", players, "id");

        setPhase(source, "logging");
        const { error: logErr } = await supabase.from("data_imports").insert({
          source, filename: file.name, row_count: players.length, status: "success",
          period_start: toLocalDay(coverage.start), period_end: toLocalDay(coverage.end),
        });
        if (logErr) throw logErr;

        setPhase(source, "done", { rowCount: players.length, unmatchedHeaders });
      } else if (source === "FTD") {
        const { players, unmatchedHeaders, amountKnown, coverage } = await parseFtdListFile(file);
        if (players.length === 0) throw new Error(lang === "es" ? "No se encontraron filas válidas en el archivo." : "No valid rows found in the file.");

        setPhase(source, "importing");
        // This file owns only the first-deposit fields. A null registration date
        // is dropped rather than written, so it cannot blank a date the
        // registration export already supplied.
        const rows = players.map(p => {
          const row = { id: p.id, first_deposit_date: p.first_deposit_date,
            first_deposit_amount: p.first_deposit_amount, imported_at: p.imported_at };
          if (p.registered_at) row.registered_at = p.registered_at;
          return row;
        });
        await upsertInChunks(supabase, "players", rows, "id");

        setPhase(source, "logging");
        const { error: logErr } = await supabase.from("data_imports").insert({
          source, filename: file.name, row_count: players.length, status: "success",
          period_start: toLocalDay(coverage.start), period_end: toLocalDay(coverage.end),
        });
        if (logErr) throw logErr;

        setPhase(source, "done", { rowCount: players.length, unmatchedHeaders, amountKnown });
      } else if (source === "Instagram") {
        const { rows, unmatchedHeaders, coverage } = await parseInstagramFile(file);
        if (rows.length === 0) throw new Error(lang === "es" ? "No se encontraron filas válidas en el archivo." : "No valid rows found in the file.");

        setPhase(source, "importing");
        await upsertInChunks(supabase, "social_daily", rows, "date,platform");

        setPhase(source, "logging");
        const { error: logErr } = await supabase.from("data_imports").insert({
          source, filename: file.name, row_count: rows.length, status: "success",
          period_start: coverage.start, period_end: coverage.end,
        });
        if (logErr) throw logErr;

        setPhase(source, "done", { rowCount: rows.length, unmatchedHeaders });
      } else if (source === "GA4") {
        const { rows, unmatchedHeaders, coverage } = await parseGa4File(file);
        if (rows.length === 0) throw new Error(lang === "es" ? "No se encontraron filas válidas en el archivo." : "No valid rows found in the file.");

        setPhase(source, "importing");
        await upsertInChunks(supabase, "ga4_channel_daily", rows, "date,channel");

        setPhase(source, "logging");
        const { error: logErr } = await supabase.from("data_imports").insert({
          source, filename: file.name, row_count: rows.length, status: "success",
          period_start: coverage.start, period_end: coverage.end,
        });
        if (logErr) throw logErr;

        setPhase(source, "done", { rowCount: rows.length, unmatchedHeaders });
      } else if (source === "InTarget") {
        const { players, unmatchedHeaders, coverage } = await parseIntargetFile(file);
        if (players.length === 0) throw new Error(lang === "es" ? "No se encontraron filas válidas en el archivo." : "No valid rows found in the file.");

        setPhase(source, "importing");
        await upsertInChunks(supabase, "players", players, "id");

        setPhase(source, "logging");
        const { error: logErr } = await supabase.from("data_imports").insert({
          source, filename: file.name, row_count: players.length, status: "success",
          period_start: toLocalDay(coverage.start), period_end: toLocalDay(coverage.end),
        });
        if (logErr) throw logErr;

        setPhase(source, "assigning");
        const { error: rpcErr } = await supabase.rpc("assign_vip_tiers");
        if (rpcErr) throw rpcErr;

        // Players hold only current state, so each import is also recorded as a
        // dated snapshot — that history is what deposit trends are computed from.
        setPhase(source, "snapshotting");
        const { error: snapErr } = await supabase.rpc("snapshot_players", { snapshot_day: localDay() });
        if (snapErr) throw snapErr;

        // Recover first-deposit amounts InTarget doesn't export: exact for
        // single-deposit players, and from the 0 -> 1 snapshot crossing for
        // everyone who converts from here on. Runs after the snapshot so
        // today's crossing is already visible to it.
        const { error: ftdErr } = await supabase.rpc("derive_first_deposit_amounts");
        if (ftdErr) throw ftdErr;

        setPhase(source, "done", { rowCount: players.length, unmatchedHeaders });
      } else {
        const { bets, unmatchedHeaders, unknownStatuses, unexpectedCurrencies, expectedCurrency, coverage } =
          await parseAltenarFile(file, sourceTz);
        if (bets.length === 0) throw new Error(lang === "es" ? "No se encontraron filas válidas en el archivo." : "No valid rows found in the file.");

        // Currency first: a wrong-currency file is unusable regardless of its
        // timestamps, and the message should say so rather than blaming a clock.
        if (unexpectedCurrencies.length) {
          throw new Error(
            s.currencyBlocked
              .replace("{found}", unexpectedCurrencies.join(", "))
              .replaceAll("{expected}", expectedCurrency)
          );
        }

        // Declaring the zone is what makes an export line up with what is
        // already stored, so the test is simply whether it did: a bet present in
        // both must land on the same instant. Any residual shift means the zone
        // is wrong or the report changed clock — and since a wrong zone is the
        // common case, the message names the one that would cancel the shift
        // instead of just reporting its size.
        const referenceMs = coverage.start ? new Date(coverage.start).getTime() : Date.now();
        const { known, shift } = await compareWithStored(bets);
        if (shift) {
          const fix = zoneCancellingShift(shift.hours, sourceTz, referenceMs);
          throw new Error(
            s.shiftBlocked
              .replace("{h}", shift.hours > 0 ? `+${shift.hours}` : String(shift.hours))
              .replace("{n}", String(shift.compared))
            + (fix ? " " + s.shiftFixHint.replace("{zone}", fix.label) : "")
          );
        }
        let retimed = null;

        setPhase(source, "importing");

        // With overlapping bets the zero-shift check above already proved the
        // new reading agrees with the stored one, so nothing needs moving. Only
        // a zone change that had no overlap to verify against leaves history in
        // the old reading, and that is what gets re-timed — otherwise the table
        // would hold two different readings of the same clock.
        if (sourceTz !== storedTz.current) {
          const expectedShift = known ? 0 : timezoneShiftHours(sourceTz, storedTz.current, referenceMs);
          if (expectedShift !== 0) {
            const { data: moved, error: retimeErr } = await supabase.rpc("retime_bets", { shift_hours: expectedShift });
            if (retimeErr) throw retimeErr;
            retimed = { from: storedTz.current, to: sourceTz, hours: expectedShift, count: moved || 0 };
          }
          const { error: tzErr } = await supabase.from("app_settings").upsert(
            { key: TZ_SETTING_KEY, value: sourceTz, updated_at: new Date().toISOString() },
            { onConflict: "key" }
          );
          if (tzErr) throw tzErr;
          storedTz.current = sourceTz;
        }

        const { reconciled, orphaned } = await reconcileExternalUserIds(bets);
        // bet_id is the primary key and every column is written, so a bet that
        // appears in two overlapping reports is updated in place: an Open bet
        // that later settles takes its new status, winnings and settlement date
        // rather than being counted a second time.
        await upsertInChunks(supabase, "bets", reconciled, "bet_id");

        setPhase(source, "logging");
        const { error: logErr } = await supabase.from("data_imports").insert({
          source, filename: file.name, row_count: bets.length, status: "success",
          period_start: toLocalDay(coverage.start), period_end: toLocalDay(coverage.end),
        });
        if (logErr) throw logErr;

        setPhase(source, "assigning");
        // Per-player GGR is derived from the bets just loaded, so it is
        // refreshed here rather than waiting for a player export to restate it.
        const { error: ggrErr } = await supabase.rpc("refresh_player_ggr");
        if (ggrErr) throw ggrErr;
        const { error: rpcErr } = await supabase.rpc("assign_vip_tiers");
        if (rpcErr) throw rpcErr;

        setPhase(source, "done", { rowCount: bets.length, orphaned, unmatchedHeaders, unknownStatuses, known, retimed });
      }

      loadLog();
    } catch (e) {
      await supabase.from("data_imports").insert({ source, filename: file.name, row_count: 0, status: "failed" }).then(() => {}, () => {});
      setPhase(source, "error", { error: e.message });
      loadLog();
    }
  }

  const phaseLabel = (phase) => ({
    parsing: s.parsing, importing: s.importing, logging: s.importing, assigning: s.assigningTiers,
  }[phase]);

  return (
    <>
      <SectionHeading title={s.importsTitle} subtitle={s.importsSub} />
      <div style={{ display: "flex", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
        {CARD_DEFS.map(card => {
          const last = lastBySource[card.source];
          const state = cardState[card.source] || {};
          const busy = ["parsing", "importing", "logging", "assigning", "snapshotting"].includes(state.phase);
          return (
            <Panel key={card.source} style={{ flex: 1, minWidth: 280 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <FileSpreadsheet size={16} color={C.accent} />
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{s[card.labelKey]}</span>
              </div>
              {card.noteKey && (
                <div style={{ fontSize: 11.5, color: C.inkFaint, marginBottom: 10, lineHeight: 1.45 }}>
                  {s[card.noteKey]}
                </div>
              )}

              {last ? (
                <>
                  <div style={{ fontSize: 12, color: C.inkDim, marginBottom: 4 }}>{s.lastImport}: {new Date(last.imported_at).toLocaleString(lang === "es" ? "es-DO" : "en-US")}</div>
                  <div style={{ fontSize: 12, color: C.inkFaint, marginBottom: 14 }}>{last.filename} · {last.row_count?.toLocaleString()} {s.rowsImported} {last.status !== "success" && `(${last.status})`}</div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: C.inkFaint, marginBottom: 14 }}>{lang === "es" ? "Sin importaciones todavía" : "No imports yet"}</div>
              )}

              {card.source === "Altenar" && (
                <div style={{ marginBottom: 14 }}>
                  <label
                    htmlFor="altenar-source-tz"
                    style={{ display: "block", fontSize: 11.5, color: C.inkDim, marginBottom: 5 }}
                  >
                    {s.sourceTzLabel}
                  </label>
                  <select
                    id="altenar-source-tz"
                    value={sourceTz}
                    disabled={busy}
                    onChange={e => setSourceTz(e.target.value)}
                    style={{ width: "100%", padding: "7px 9px", borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: "#1D222B", color: C.ink, fontSize: 12.5 }}
                  >
                    {IMPORT_TIMEZONES.map(tz => (
                      <option key={tz.value} value={tz.value}>{tz.label}</option>
                    ))}
                  </select>
                  <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 5, lineHeight: 1.4 }}>{s.sourceTzHint}</div>
                </div>
              )}

              <input
                type="file"
                accept=".xlsx,.csv"
                ref={el => { fileInputs.current[card.source] = el; }}
                style={{ display: "none" }}
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; handleFile(card.source, f); }}
              />
              <button
                onClick={() => fileInputs.current[card.source]?.click()}
                disabled={busy}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: "#1D222B", color: C.ink, fontSize: 12.5, fontWeight: 500, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}
              >
                {busy ? <Spinner /> : <UploadCloud size={14} />} {busy ? phaseLabel(state.phase) : s.uploadBtn}
              </button>

              {state.phase === "done" && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, color: C.positive, marginTop: 12 }}>
                  <CheckCircle2 size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    {state.rowCount.toLocaleString()} {s.importSuccess}
                    {state.orphaned > 0 && (lang === "es"
                      ? ` — ${state.orphaned} sin jugador asociado aún`
                      : ` — ${state.orphaned} without a matching player yet`)}
                    {state.summary && (
                      <div style={{ color: C.inkDim, marginTop: 4 }}>
                        {s.depositsLoaded
                          .replace("{n}", state.summary.depositCount.toLocaleString())
                          .replace("{amt}", fmtDOP(state.summary.depositAmount))}
                        <div>{s.promoExcluded.replace("{n}", state.summary.promoCount.toLocaleString())}</div>
                      </div>
                    )}
                    {state.amountKnown != null && (
                      <div style={{ color: C.inkDim, marginTop: 4 }}>
                        {s.health.ftdOk.replace("{t}", state.amountKnown.toLocaleString())}
                      </div>
                    )}
                    {state.unknownTypes?.length > 0 && (
                      <div style={{ color: C.negative, marginTop: 4 }}>
                        {s.unknownTypes}{state.unknownTypes.join(", ")}
                      </div>
                    )}
                    {state.known > 0 && (
                      <div style={{ color: C.inkDim, marginTop: 4 }}>
                        {s.reimported.replace("{n}", state.known.toLocaleString())}
                      </div>
                    )}
                    {state.retimed && (
                      <div style={{ color: C.inkDim, marginTop: 4 }}>
                        {s.sourceTzChanged
                          .replace("{from}", state.retimed.from)
                          .replace("{to}", state.retimed.to)
                          .replace("{n}", state.retimed.count.toLocaleString())
                          .replace("{h}", state.retimed.hours > 0 ? `+${state.retimed.hours}` : String(state.retimed.hours))}
                      </div>
                    )}
                    {state.unknownStatuses?.length > 0 && (
                      <div style={{ color: C.negative, marginTop: 4 }}>
                        {lang === "es"
                          ? "Estados de apuesta no reconocidos (revisar si cuentan como apuesta): "
                          : "Unrecognized bet statuses (check whether they count as wagering): "}
                        {state.unknownStatuses.join(", ")}
                      </div>
                    )}
                    {state.unmatchedHeaders?.length > 0 && (
                      <div style={{ color: C.inkFaint, marginTop: 4 }}>
                        {lang === "es" ? "Columnas no reconocidas: " : "Unrecognized columns: "}{state.unmatchedHeaders.join(", ")}
                      </div>
                    )}
                  </span>
                </div>
              )}
              {state.phase === "error" && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, color: C.negative, marginTop: 12 }}>
                  <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{s.importError}: {state.error}</span>
                </div>
              )}
            </Panel>
          );
        })}
      </div>

      <div style={{ background: "#132A24", border: `1px solid ${C.positive}30`, borderRadius: 12, padding: "10px 16px", fontSize: 12, color: C.positive, marginBottom: 24, display: "flex", alignItems: "center", gap: 8 }}>
        <CheckCircle2 size={14} /> {s.cadenceNote}
      </div>

      <DataHealth s={s} />

      <DataCoverage s={s} lang={lang} />

      <SnapshotRollback s={s} lang={lang} />

      <div style={{ fontSize: 13, color: C.inkDim, marginBottom: 10 }}>{s.importHistory}</div>
      {loadingLog ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 40 }}><Spinner size={22} /></div>
      ) : importLog.length === 0 ? (
        <Panel style={{ textAlign: "center", padding: "32px 24px", color: C.inkDim, fontSize: 12.5 }}>
          {lang === "es" ? "Todavía no se ha importado ningún archivo." : "No files imported yet."}
        </Panel>
      ) : (
        <Panel style={{ padding: 4, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr>{[lang === "es" ? "Fuente" : "Source", lang === "es" ? "Fecha" : "Date", lang === "es" ? "Archivo" : "File", lang === "es" ? "Filas" : "Rows", lang === "es" ? "Estado" : "Status"].map(h => <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5 }}>{h}</th>)}</tr></thead>
            <tbody>
              {importLog.map(l => (
                <tr key={l.id}>
                  <td style={{ padding: "8px 14px", fontWeight: 500 }}>{l.source}</td>
                  <td style={{ padding: "8px 14px", color: C.inkDim }}>{new Date(l.imported_at).toLocaleString(lang === "es" ? "es-DO" : "en-US")}</td>
                  <td style={{ padding: "8px 14px", color: C.inkFaint }}>{l.filename}</td>
                  <td style={{ padding: "8px 14px" }}>{l.row_count?.toLocaleString() ?? "—"}</td>
                  <td style={{ padding: "8px 14px", color: l.reverted_at ? C.inkFaint : l.status === "success" ? C.positive : C.negative }}>
                    {/* The log records what was uploaded, so a reverted import
                        stays listed — but its data is no longer in the dashboard
                        and the row has to say so. */}
                    {l.reverted_at ? s.rollback.reverted : l.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}
