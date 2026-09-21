import { useEffect, useRef, useState } from "react";
import { UploadCloud, CheckCircle2, FileSpreadsheet, AlertCircle } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { SectionHeading, Panel, Spinner, fmtDOP } from "../components/ui";
import DataCoverage from "../components/DataCoverage";
import DataHealth from "../components/DataHealth";
import { parseAltenarFile } from "../lib/importers/altenar";
import { parseGa4File } from "../lib/importers/ga4";
import { parseInstagramFile } from "../lib/importers/instagram";
import { parsePlayerReportFile } from "../lib/importers/playerReport";
import { parsePaymentsReportFile } from "../lib/importers/paymentsReport";
import { upsertInChunks, SOURCE_TIMEZONE, IMPORT_TIMEZONES, timezoneShiftHours, zoneCancellingShift } from "../lib/importers/parseWorkbook";

// How many of a batch's bets belong to players the dashboard has never been
// told about. The Altenar export routinely arrives before the week's player
// report, so this is reported rather than corrected: the bets still count
// towards house totals, and the number tells Marcos how much of the week's
// activity is waiting on the backoffice file.
async function countUnmatchedPlayers(bets) {
  // player_key is generated in the database; derive the same value here so the
  // check runs before the rows are sent rather than after.
  const keys = [...new Set(
    bets.map(b => (b.external_user_id ? String(b.external_user_id).slice(-9) : null)).filter(Boolean)
  )];
  if (!keys.length) return 0;
  const known = new Set();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const { data, error } = await supabase.from("players").select("id").in("id", chunk);
    if (error) throw error;
    for (const row of data) known.add(row.id);
  }
  return keys.filter(k => !known.has(k)).length;
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
// Altenar's current export template writes UTC. Established by anchoring every
// player's first bet against their registration time: read as UTC nobody bets
// before they exist and the quickest do so within a minute, while an hour
// either way makes that impossible or implausible. Earlier exports were UTC-5 --
// the same bets came back shifted five hours -- so the zone stays selectable and
// a mismatch against stored bets is still blocked below.
const DEFAULT_SOURCE_TZ = "UTC";

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

// The two backoffice exports and the Altenar bet list are the source of truth
// for players, money and betting. GA4 and Instagram sit apart: they describe
// marketing, not players, and nothing on the acquisition figures depends on them.
const CARD_DEFS = [
  { source: "Player Report", labelKey: "playerReportCard", noteKey: "playerReportNote" },
  { source: "Payments Report", labelKey: "paymentsReportCard", noteKey: "paymentsReportNote" },
  { source: "Altenar", labelKey: "altenarCard", noteKey: "altenarNote" },
  { source: "GA4", labelKey: "ga4Card" },
  { source: "Instagram", labelKey: "instagramCard" },
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

      if (source === "Player Report") {
        const { players, unmatchedHeaders, unexpectedCurrencies, expectedCurrency,
                summary, coverage } = await parsePlayerReportFile(file);
        if (players.length === 0) throw new Error(lang === "es" ? "No se encontraron filas válidas en el archivo." : "No valid rows found in the file.");

        if (unexpectedCurrencies.length) {
          throw new Error(
            s.currencyBlocked
              .replace("{found}", unexpectedCurrencies.join(", "))
              .replaceAll("{expected}", expectedCurrency)
          );
        }

        setPhase(source, "importing");
        // id is the primary key and the report restates every player each time,
        // so re-uploading an overlapping export updates in place rather than
        // duplicating anyone.
        await upsertInChunks(supabase, "players", players, "id");

        // Staff and QA accounts have to be flagged before anything counts them:
        // they register, deposit and bet exactly like real players.
        const { error: flagErr } = await supabase.rpc("refresh_internal_flags");
        if (flagErr) throw flagErr;

        setPhase(source, "logging");
        const { error: logErr } = await supabase.from("data_imports").insert({
          source, filename: file.name, row_count: players.length, status: "success",
          period_start: toLocalDay(coverage.start), period_end: toLocalDay(coverage.end),
        });
        if (logErr) throw logErr;

        setPhase(source, "assigning");
        const { error: rpcErr } = await supabase.rpc("assign_vip_tiers");
        if (rpcErr) throw rpcErr;

        setPhase(source, "done", {
          rowCount: players.length, unmatchedHeaders, summary,
          // What the file actually knows about, which is often earlier than the
          // range in its filename.
          knowsThrough: toLocalDay(coverage.end),
        });
      } else if (source === "Payments Report") {
        const { periods, period, unmatchedHeaders, unparsedPlayers,
                unexpectedCurrencies, expectedCurrency, summary } = await parsePaymentsReportFile(file);
        if (periods.length === 0) throw new Error(lang === "es" ? "No se encontraron filas válidas en el archivo." : "No valid rows found in the file.");

        if (unexpectedCurrencies.length) {
          throw new Error(
            s.currencyBlocked
              .replace("{found}", unexpectedCurrencies.join(", "))
              .replaceAll("{expected}", expectedCurrency)
          );
        }

        // The file states its own totals. Reproducing them proves every row was
        // read and the TOTAL line was not counted as a player.
        const stated = summary.reportedTotal?.depositAmount;
        if (stated != null && Math.abs(stated - summary.depositAmount) > 0.01) {
          throw new Error(
            s.totalMismatch
              .replace("{ours}", fmtDOP(summary.depositAmount))
              .replace("{theirs}", fmtDOP(stated))
          );
        }

        setPhase(source, "importing");
        // A range that overlaps one already loaded is a re-cut of the same days,
        // not new money. It is stored for reconciliation and left out of every
        // total, so uploading the month view after the weeks cannot double them.
        const { data: existing, error: overlapErr } = await supabase
          .from("deposit_periods")
          .select("period_start, period_end")
          .lte("period_start", period.end)
          .gte("period_end", period.start)
          .limit(200);
        if (overlapErr) throw overlapErr;
        const overlapsOther = (existing || []).some(
          r => !(r.period_start === period.start && r.period_end === period.end)
        );
        const scope = overlapsOther ? "validation" : "primary";
        await upsertInChunks(
          supabase, "deposit_periods",
          periods.map(r => ({ ...r, scope })),
          "period_start,period_end,player_id"
        );

        // Once narrower periods tile a wider one end to end, the block is the
        // redundant copy and the weeks are the better record, so scopes are
        // re-derived after every upload rather than fixed at insert time.
        const { error: scopeErr } = await supabase.rpc("reconcile_deposit_period_scopes");
        if (scopeErr) throw scopeErr;

        const { error: refreshErr } = await supabase.rpc("refresh_player_deposit_totals");
        if (refreshErr) throw refreshErr;

        setPhase(source, "logging");
        const { error: logErr } = await supabase.from("data_imports").insert({
          source, filename: file.name, row_count: periods.length, status: "success",
          period_start: period.start, period_end: period.end,
        });
        if (logErr) throw logErr;

        setPhase(source, "done", { rowCount: periods.length, unmatchedHeaders, unparsedPlayers, summary, period, scope });
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

        const unmatched = await countUnmatchedPlayers(bets);
        // bet_id is the primary key and every column is written, so a bet that
        // appears in two overlapping reports is updated in place: an Open bet
        // that later settles takes its new status, winnings and settlement date
        // rather than being counted a second time.
        await upsertInChunks(supabase, "bets", bets, "bet_id");

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

        setPhase(source, "done", { rowCount: bets.length, unmatched, unmatchedHeaders, unknownStatuses, known, retimed });
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
          const busy = ["parsing", "importing", "logging", "assigning"].includes(state.phase);
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
                    {state.unmatched > 0 && (
                      <div style={{ color: C.inkDim, marginTop: 4 }}>
                        {s.betsUnmatched.replace("{n}", state.unmatched.toLocaleString())}
                      </div>
                    )}
                    {state.knowsThrough && (
                      <div style={{ color: C.inkDim, marginTop: 4 }}>
                        {s.reportKnowsThrough.replace("{d}", state.knowsThrough)}
                      </div>
                    )}
                    {state.summary?.ftdKnown != null && (
                      <div style={{ color: C.inkDim, marginTop: 4 }}>
                        {s.playersLoaded
                          .replace("{d}", state.summary.depositors.toLocaleString())
                          .replace("{f}", state.summary.ftdKnown.toLocaleString())}
                        {state.summary.ftdDateMissing > 0 && (
                          <div style={{ color: C.negative }}>
                            {s.ftdDateMissing.replace("{n}", state.summary.ftdDateMissing.toLocaleString())}
                          </div>
                        )}
                      </div>
                    )}
                    {state.period && (
                      <div style={{ color: C.inkDim, marginTop: 4 }}>
                        {s.depositsForPeriod
                          .replace("{a}", state.period.start)
                          .replace("{b}", state.period.end)
                          .replace("{n}", state.summary.depositCount.toLocaleString())
                          .replace("{amt}", fmtDOP(state.summary.depositAmount))
                          .replace("{d}", state.summary.depositors.toLocaleString())}
                        {state.summary.players > state.summary.depositors && (
                          <div>
                            {s.paymentsNonDepositors.replace(
                              "{n}",
                              (state.summary.players - state.summary.depositors).toLocaleString(),
                            )}
                          </div>
                        )}
                        {state.scope === "validation" && (
                          <div style={{ color: C.negative }}>{s.periodValidationOnly}</div>
                        )}
                      </div>
                    )}
                    {state.unparsedPlayers?.length > 0 && (
                      <div style={{ color: C.negative, marginTop: 4 }}>
                        {s.unparsedPlayers.replace("{n}", String(state.unparsedPlayers.length))}
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
                  <td style={{ padding: "8px 14px", color: l.status === "success" ? C.positive : C.negative }}>
                    {l.status}
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
