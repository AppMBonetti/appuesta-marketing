import { useCallback, useEffect, useState } from "react";
import { Users, UserPlus, Activity, Coins } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C, alpha } from "../lib/theme";
import { weekRangeLabel, formatWeek } from "../lib/period";
import { fmtMoney } from "../lib/currency";
import { Panel, SectionHeading, Spinner, KpiCard, fmtDOP } from "./ui";
import { useSortedRows } from "../lib/sortRows";
import { SortHeader } from "./SortHeader";

/**
 * The weekly traffic report: one week at a time, by channel and by
 * source/medium, each row against the same channel a week earlier.
 *
 * The channel screen beside this one aggregates whatever the period bar
 * selects, which answers "how much traffic in this range" but not "is it
 * growing". Growth needs a fixed grain, and the grain has to be the week the
 * rest of the dashboard already uses, or a traffic week and a KPI week are
 * different seven days with the same name. The views do the bucketing with
 * date_trunc('week', ...) — the same Monday boundary as weekly_spend.
 *
 * Two things on this screen are easy to misread, so both are stated rather
 * than left to be inferred:
 *
 *   - **A partial week.** GA4 data arrives when somebody exports it, so the
 *     most recent week is usually a few days long. Its sessions are genuinely
 *     lower and its cost per session genuinely higher, and neither is news.
 *     `days_with_data` is counted across all channels in the view, because GA4
 *     writes no row for a channel on a day it saw no sessions — counting one
 *     channel's days would call a quiet week a short one.
 *   - **Channel spend is hand-entered.** Nothing supplies it: `weekly_spend`
 *     holds one total for the week and the ad platforms are not connected. A
 *     channel with no figure shows "—", not DOP 0, and the footer says what the
 *     parts add up to against the total that was already entered for the week.
 */

const fmtPct = n => (n == null ? "—" : `${(Number(n) * 100).toFixed(1)}%`);
// Cost per session is single-digit pesos, so whole pesos would round DOP 19.16
// to DOP 19 and a change of twenty cents would read as no change at all. The
// weekly report shows the same figure to two decimals ("money2").
const fmtRate = n => (n == null ? "—" : fmtMoney(Number(n), { decimals: 2 }));
const fmtInt = n => (n == null ? "—" : Number(n).toLocaleString());

// Plain sign colouring: a minus is red and a plus is green, whatever the metric
// means. Colouring by whether the movement is *good* made every row red at once
// on a quiet week, which reads as a broken screen rather than as a quiet week.
function ChangeCell({ value, prev }) {
  if (value == null) {
    return <span style={{ color: C.inkFaint }} title={prev == null ? "sin semana anterior" : undefined}>—</span>;
  }
  const pct = Number(value) * 100;
  const color = pct > 0 ? C.positive : pct < 0 ? C.negative : C.inkDim;
  return (
    <span style={{ color, fontVariantNumeric: "tabular-nums" }}>
      {pct > 0 ? "+" : ""}{pct.toFixed(1)}%
    </span>
  );
}

const CHANNEL_COLUMNS = [
  { key: "channel", kind: "text", label: s => s.traffic.cols.channel, value: r => r.channel },
  { key: "sessions", label: s => s.traffic.cols.sessions, value: r => r.sessions },
  { key: "change", label: s => s.traffic.cols.change, value: r => r.sessions_change },
  { key: "users", label: s => s.traffic.cols.users, value: r => r.users },
  { key: "newUsers", label: s => s.traffic.cols.newUsers, value: r => r.new_users },
  { key: "engagement", label: s => s.traffic.cols.engagement, value: r => r.engagement_rate },
  { key: "conversions", label: s => s.traffic.cols.conversions, value: r => r.conversions },
  { key: "spend", label: s => s.traffic.cols.spend, value: r => r.spend },
  { key: "cps", label: s => s.traffic.cols.costPerSession, value: r => r.cost_per_session },
];

const SOURCE_COLUMNS = [
  { key: "sourceMedium", kind: "text", label: s => s.traffic.cols.sourceMedium, value: r => r.source_medium },
  { key: "channel", kind: "text", label: s => s.traffic.cols.channel, value: r => r.channel },
  { key: "sessions", label: s => s.traffic.cols.sessions, value: r => r.sessions },
  { key: "change", label: s => s.traffic.cols.change, value: r => r.sessions_change },
  { key: "users", label: s => s.traffic.cols.users, value: r => r.users },
  { key: "newUsers", label: s => s.traffic.cols.newUsers, value: r => r.new_users },
  { key: "engagement", label: s => s.traffic.cols.engagement, value: r => r.engagement_rate },
  { key: "conversions", label: s => s.traffic.cols.conversions, value: r => r.conversions },
];

export default function TrafficWeek({ s, lang }) {
  const [weeks, setWeeks] = useState([]);
  const [week, setWeek] = useState(null);
  const [channelRows, setChannelRows] = useState([]);
  const [sourceRows, setSourceRows] = useState([]);
  const [loadingWeeks, setLoadingWeeks] = useState(true);
  const [loadingWeek, setLoadingWeek] = useState(false);
  const [error, setError] = useState(null);

  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(null);

  // The week list and the totals come from the same view, so the picker can
  // only offer weeks that actually carry traffic.
  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error: err } = await supabase
        .from("ga4_weekly_totals").select("*").order("week_start", { ascending: false });
      if (!active) return;
      if (err) setError(err.message);
      const rows = data || [];
      setWeeks(rows);
      setWeek(w => w ?? rows[0]?.week_start ?? null);
      setLoadingWeeks(false);
    })();
    return () => { active = false; };
  }, []);

  const loadWeek = useCallback(async () => {
    if (!week) return;
    setLoadingWeek(true);
    const [byChannel, bySource] = await Promise.all([
      supabase.from("ga4_weekly_channel").select("*").eq("week_start", week).order("sessions", { ascending: false }),
      supabase.from("ga4_weekly_source_medium").select("*").eq("week_start", week).order("sessions", { ascending: false }),
    ]);
    if (byChannel.error) setError(byChannel.error.message);
    if (bySource.error) setError(bySource.error.message);
    setChannelRows(byChannel.data || []);
    setSourceRows(bySource.data || []);
    setLoadingWeek(false);
  }, [week]);

  useEffect(() => { loadWeek(); }, [loadWeek]);

  async function commitSpend(channel) {
    const raw = draft.trim();
    setEditing(null);
    if (raw === "") return;
    const value = Number(raw.replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(value)) return;
    setSaving(channel);
    const { error: err } = await supabase.from("channel_spend").upsert({
      week_start: week, channel, spend_dop: value, updated_at: new Date().toISOString(),
    }, { onConflict: "week_start,channel" });
    setSaving(null);
    if (err) { setError(err.message); return; }
    // The week totals carry channel_spend_total, so both the table and the
    // footer have to come back from the database rather than be patched here.
    loadWeek();
    const { data } = await supabase
      .from("ga4_weekly_totals").select("*").order("week_start", { ascending: false });
    if (data) setWeeks(data);
  }

  const { sorted: channelsSorted, sort: channelSort, toggle: channelToggle } =
    useSortedRows(channelRows, CHANNEL_COLUMNS);
  const { sorted: sourcesSorted, sort: sourceSort, toggle: sourceToggle } =
    useSortedRows(sourceRows, SOURCE_COLUMNS);

  const total = weeks.find(w => w.week_start === week) || null;
  // The anchor for "how current is this screen": the newest week present, and
  // how much of it there is. Both come from the view rather than the clock.
  const newest = weeks[0] || null;

  const th = { padding: "9px 12px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" };
  const td = { padding: "8px 12px", fontSize: 12.5, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

  if (loadingWeeks) {
    return <div style={{ display: "flex", justifyContent: "center", padding: 40 }}><Spinner size={20} /></div>;
  }

  if (!weeks.length) {
    return (
      <>
        <SectionHeading title={s.traffic.title} subtitle={s.traffic.sub} />
        {error && <Panel style={{ color: C.negative, marginBottom: 16 }}>{error}</Panel>}
        <Panel style={{ color: C.inkDim, fontSize: 12.5, lineHeight: 1.7 }}>{s.traffic.noData}</Panel>
      </>
    );
  }

  const partial = total && total.days_with_data < 7;
  const channelSpendTotal = total?.channel_spend_total == null ? null : Number(total.channel_spend_total);
  const weekSpend = total?.spend == null ? null : Number(total.spend);
  const spendGap = channelSpendTotal != null && weekSpend != null ? weekSpend - channelSpendTotal : null;

  return (
    <>
      <SectionHeading title={s.traffic.title} subtitle={s.traffic.sub} />
      {error && <Panel style={{ color: C.negative, marginBottom: 16 }}>{error}</Panel>}

      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
        <select
          value={week ?? ""}
          onChange={e => setWeek(e.target.value)}
          style={{ background: C.inset, border: `1px solid ${C.panelBorder}`, borderRadius: 8, color: C.ink, padding: "7px 10px", fontSize: 12.5 }}
        >
          {weeks.map(w => (
            <option key={w.week_start} value={w.week_start}>
              {weekRangeLabel(w.week_start, lang)}{w.days_with_data < 7 ? ` · ${w.days_with_data}/7` : ""}
            </option>
          ))}
        </select>
        {newest && (
          <span style={{ fontSize: 12.5, color: C.inkDim }}>
            {s.traffic.coverage.replace("{d}", `${formatWeek(newest.last_day ?? newest.week_start, lang)} ${(newest.last_day ?? newest.week_start).slice(0, 4)}`)}
          </span>
        )}
      </div>

      {/* A short week is not a drop in traffic, and a short week carrying a
          full week's spend is not a rise in cost. Said here, where the figures
          are, rather than in a hover nobody opens while comparing numbers. */}
      {partial && (
        <Panel style={{ marginBottom: 16, borderColor: alpha(C.warn, 45), color: C.warn, fontSize: 12.5, lineHeight: 1.7 }}>
          {s.traffic.partialWeek.replace("{n}", total.days_with_data)}
        </Panel>
      )}

      {total && (
        <div style={{ display: "flex", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
          <KpiCard
            icon={Users} label={s.traffic.kpi.sessions} value={fmtInt(total.sessions)}
            delta={total.sessions_change == null ? undefined : `${Number(total.sessions_change) > 0 ? "+" : ""}${(Number(total.sessions_change) * 100).toFixed(1)}%`}
            deltaGood={Number(total.sessions_change) >= 0}
          />
          <KpiCard icon={Users} label={s.traffic.kpi.users} value={fmtInt(total.users)} />
          <KpiCard icon={UserPlus} label={s.traffic.kpi.newUsers} value={fmtInt(total.new_users)} />
          <KpiCard icon={Activity} label={s.traffic.kpi.engagement} value={fmtPct(total.engagement_rate)} />
          <KpiCard
            icon={Coins} label={s.traffic.kpi.costPerSession}
            value={fmtRate(total.cost_per_session)}
          />
        </div>
      )}

      {loadingWeek ? <div style={{ display: "flex", justifyContent: "center", padding: 30 }}><Spinner size={18} /></div> : (
        <>
          <SectionHeading title={s.traffic.byChannel} />
          <div style={{ overflowX: "auto", border: `1px solid ${C.panelBorder}`, borderRadius: 14, background: C.panel, marginBottom: 10 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
              <thead>
                <SortHeader columns={CHANNEL_COLUMNS} sort={channelSort} toggle={channelToggle} s={s} th={th} />
              </thead>
              <tbody>
                {channelsSorted.map(r => (
                  <tr key={r.channel}>
                    <td style={{ ...td, fontWeight: 500 }}>{r.channel}</td>
                    <td style={td}>{fmtInt(r.sessions)}</td>
                    <td style={td}><ChangeCell value={r.sessions_change} prev={r.prev_sessions} /></td>
                    <td style={{ ...td, color: C.inkDim }}>{fmtInt(r.users)}</td>
                    <td style={{ ...td, color: C.inkDim }}>{fmtInt(r.new_users)}</td>
                    <td style={{ ...td, color: C.inkDim }}>{fmtPct(r.engagement_rate)}</td>
                    <td style={{ ...td, color: C.inkDim }}>{fmtInt(r.conversions)}</td>
                    <td
                      onClick={() => { setEditing(r.channel); setDraft(r.spend == null ? "" : String(r.spend)); }}
                      title={s.traffic.spendHint}
                      style={{ ...td, cursor: "pointer", color: r.spend == null ? C.inkFaint : C.ink }}
                    >
                      {editing === r.channel ? (
                        <input
                          autoFocus
                          type="number"
                          value={draft}
                          onChange={e => setDraft(e.target.value)}
                          onBlur={() => commitSpend(r.channel)}
                          onKeyDown={e => {
                            if (e.key === "Enter") commitSpend(r.channel);
                            if (e.key === "Escape") setEditing(null);
                          }}
                          style={{ width: 96, background: C.inset, border: `1px solid ${C.accent}`, borderRadius: 6, color: C.ink, padding: "4px 6px", fontSize: 12.5, textAlign: "right" }}
                        />
                      ) : saving === r.channel ? <Spinner />
                        : r.spend == null ? "—" : fmtDOP(Number(r.spend))}
                    </td>
                    <td style={td}>{r.cost_per_session == null ? <span style={{ color: C.inkFaint }}>—</span> : fmtRate(r.cost_per_session)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p style={{ color: C.inkFaint, fontSize: 11.5, margin: "0 0 6px", maxWidth: 820, lineHeight: 1.6 }}>
            {s.traffic.spendNote}
          </p>
          {/* The parts beside the whole. A gap is the normal state until every
              channel has a figure, and naming it is what stops someone reading
              a missing channel as a free one. */}
          <p style={{ color: C.inkFaint, fontSize: 11.5, margin: "0 0 26px", maxWidth: 820, lineHeight: 1.6 }}>
            {s.traffic.spendSum
              .replace("{parts}", channelSpendTotal == null ? "—" : fmtDOP(channelSpendTotal))
              .replace("{total}", weekSpend == null ? "—" : fmtDOP(weekSpend))}
            {spendGap != null && spendGap !== 0 && (
              <span style={{ color: C.warn }}>
                {"  ·  "}{s.traffic.spendGap.replace("{amount}", fmtDOP(Math.abs(spendGap)))}
              </span>
            )}
            {spendGap === 0 && <span style={{ color: C.positive }}>{"  ·  "}{s.traffic.spendMatches}</span>}
          </p>

          <SectionHeading title={s.traffic.bySource} />
          {sourceRows.length === 0 ? (
            <Panel style={{ color: C.inkDim, fontSize: 12.5, lineHeight: 1.7, marginBottom: 26 }}>{s.traffic.noSources}</Panel>
          ) : (
            <div style={{ overflowX: "auto", border: `1px solid ${C.panelBorder}`, borderRadius: 14, background: C.panel, marginBottom: 26 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
                <thead>
                  <SortHeader columns={SOURCE_COLUMNS} sort={sourceSort} toggle={sourceToggle} s={s} th={th} />
                </thead>
                <tbody>
                  {sourcesSorted.map(r => (
                    <tr key={r.source_medium}>
                      <td style={{ ...td, fontWeight: 500 }}>{r.source_medium}</td>
                      <td style={{ ...td, color: C.inkDim }}>{r.channel || "—"}</td>
                      <td style={td}>{fmtInt(r.sessions)}</td>
                      <td style={td}><ChangeCell value={r.sessions_change} prev={r.prev_sessions} /></td>
                      <td style={{ ...td, color: C.inkDim }}>{fmtInt(r.users)}</td>
                      <td style={{ ...td, color: C.inkDim }}>{fmtInt(r.new_users)}</td>
                      <td style={{ ...td, color: C.inkDim }}>{fmtPct(r.engagement_rate)}</td>
                      <td style={{ ...td, color: C.inkDim }}>{fmtInt(r.conversions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
