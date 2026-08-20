import { useEffect, useState } from "react";
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { formatWeek, addDays, dateRangeLabel, formatMonth } from "../lib/period";
import { deriveWeeklyKpis, wowChange, aggregateWeeklyRows } from "../lib/metrics";
import { SectionHeading, Panel, Spinner, fmtDOP, EmptyState } from "../components/ui";
import { fmtMoney } from "../lib/currency";
import SparkTile from "../components/SparkTile";
import CoverageBar from "../components/CoverageBar";
import GoalTracker from "../components/GoalTracker";

const MODES = ["week", "month", "custom"];

const selectStyle = {
  padding: "6px 9px", borderRadius: 8, border: `1px solid ${C.panelBorder}`,
  background: C.panel, color: C.ink, fontSize: 12.5,
};

const fmtInt = v => (v == null ? "—" : Math.round(v).toLocaleString());
const fmtPct = v => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const fmtX = v => (v == null ? "—" : `${v.toFixed(2)}x`);
const fmtMoney2 = v => fmtMoney(v, { decimals: 2 });

/** Every month that has at least one week of data, newest last. */
function monthsWithData(weeks) {
  return [...new Set(weeks.map(w => `${w.week.slice(0, 7)}-01`))].sort();
}

/**
 * Picks the weeks a selection covers. Every figure on this page comes from
 * `weekly_kpis`, whose grain is a Monday-to-Sunday week, so a month or a custom
 * span is the set of weeks it touches rather than an exact day range — the
 * heading always states the real dates that produces.
 */
function weeksForSelection(weeks, mode, selection) {
  if (!weeks.length) return [];
  if (mode === "week") {
    const found = weeks.find(w => w.week === selection.week);
    return found ? [found] : [weeks[weeks.length - 1]];
  }
  if (mode === "month") {
    const month = selection.month?.slice(0, 7);
    const inMonth = weeks.filter(w => w.week.slice(0, 7) === month);
    return inMonth.length ? inMonth : [];
  }
  const { start, end } = selection;
  if (!start || !end || start > end) return weeks;
  // A week counts when any of its days fall inside the range.
  return weeks.filter(w => w.week <= end && addDays(w.week, 6) >= start);
}

export default function Overview({ s, lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [weeks, setWeeks] = useState([]);
  const [mode, setMode] = useState("month");
  const [selection, setSelection] = useState({ week: null, month: null, start: null, end: null });
  // A custom span is answered at day grain by the database rather than by
  // rounding to whole weeks — "the 10th to the 18th" has to mean those days,
  // which is how the figures get checked against the backoffice.
  const [rangeRow, setRangeRow] = useState(null);
  const [rangeBusy, setRangeBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error: err } = await supabase
        .from("weekly_kpis").select("*").order("week_start");
      if (!active) return;
      if (err) { setError(err.message); setLoading(false); return; }
      const rows = (data || []).map(r => ({ week: r.week_start, raw: r, ...deriveWeeklyKpis(r) }));
      setWeeks(rows);
      if (rows.length) {
        const lastWeek = rows[rows.length - 1].week;
        setSelection({
          week: lastWeek,
          month: `${lastWeek.slice(0, 7)}-01`,
          start: rows[0].week,
          end: addDays(lastWeek, 6),
        });
      }
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  const { start: customStart, end: customEnd } = selection;
  useEffect(() => {
    if (mode !== "custom" || !customStart || !customEnd || customStart > customEnd) {
      setRangeRow(null);
      return undefined;
    }
    let active = true;
    setRangeBusy(true);
    (async () => {
      // The comparison is the same number of days immediately before the range.
      const days = Math.round((new Date(customEnd) - new Date(customStart)) / 86400000) + 1;
      const priorEnd = addDays(customStart, -1);
      const [now, before] = await Promise.all([
        supabase.rpc("kpis_for_range", { p_start: customStart, p_end: customEnd }),
        supabase.rpc("kpis_for_range", { p_start: addDays(priorEnd, -(days - 1)), p_end: priorEnd }),
      ]);
      if (!active) return;
      if (now.error) setError(now.error.message);
      const first = res => (Array.isArray(res.data) ? res.data[0] || null : res.data);
      setRangeRow({ current: first(now), prior: before.error ? null : first(before), days });
      setRangeBusy(false);
    })();
    return () => { active = false; };
  }, [mode, customStart, customEnd]);

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>;
  if (error) return <Panel style={{ color: C.negative }}>{error}</Panel>;
  if (!weeks.length) return (<><SectionHeading title={s.ov.heroTitle} subtitle={s.ov.heroSub} /><EmptyState s={s} /></>);

  const months = monthsWithData(weeks);
  const shown = weeksForSelection(weeks, mode, selection);

  // The comparison is the block of weeks of the same length immediately before
  // the selection — a month against the previous four or five weeks, a week
  // against the week before it. A partial prior block would understate itself,
  // so it is dropped rather than shown short.
  const firstIndex = shown.length ? weeks.findIndex(w => w.week === shown[0].week) : -1;
  const priorStart = firstIndex - shown.length;
  const priorWeeks = shown.length && priorStart >= 0 ? weeks.slice(priorStart, firstIndex) : [];

  const exactRange = mode === "custom" && rangeRow?.current;
  const current = exactRange
    ? deriveWeeklyKpis(rangeRow.current)
    : (shown.length ? deriveWeeklyKpis(aggregateWeeklyRows(shown.map(w => w.raw))) : {});
  const prior = exactRange
    ? (rangeRow.prior ? deriveWeeklyKpis(rangeRow.prior) : {})
    : (priorWeeks.length ? deriveWeeklyKpis(aggregateWeeklyRows(priorWeeks.map(w => w.raw))) : {});
  const seriesOf = key => shown.map(w => w[key]);
  const tile = (key, label, format, better, accent) => ({
    label, value: format(current[key]), change: wowChange(current[key], prior[key]),
    better, series: seriesOf(key), accent,
  });

  // The exact span on screen, so a tile is never read against an unknown period.
  const firstWeek = shown[0]?.week;
  const lastWeek = shown[shown.length - 1]?.week;
  // The last week is usually still running, so the label must not claim data
  // through a date that hasn't happened.
  const today = new Date().toISOString().slice(0, 10);
  const lastWeekEnd = lastWeek ? addDays(lastWeek, 6) : null;
  const coveredEnd = lastWeekEnd && lastWeekEnd > today ? today : lastWeekEnd;
  const coveredRange = exactRange
    ? dateRangeLabel(rangeRow.current.range_start, rangeRow.current.range_end > today ? today : rangeRow.current.range_end, lang)
    : (firstWeek && coveredEnd ? dateRangeLabel(firstWeek, coveredEnd, lang) : "");

  // Two figures cannot be produced for an arbitrary span and say so rather than
  // approximating: deposits need a snapshot taken before the range to subtract
  // from, and spend is captured per week so it is split across that week's days.
  const rangeCaveats = exactRange
    ? [
        rangeRow.current.deposit_amount == null ? s.ov.noDepositBaseline : null,
        rangeRow.current.spend_prorated ? s.ov.spendProrated : null,
      ].filter(Boolean)
    : [];

  const chartData = shown.map(w => ({
    label: formatWeek(w.week, lang),
    registrations: w.registrations, ftds: w.ftds,
    cpl: w.costPerRegistration, cpa: w.costPerAcquisition,
    ggr: w.ggr, deposits: w.depositAmount,
  }));

  const axis = { stroke: C.inkFaint, fontSize: 11, tickLine: false, axisLine: false };
  const tooltip = { contentStyle: { background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 8, fontSize: 12 } };

  return (
    <>
      <SectionHeading
        title={s.ov.heroTitle}
        subtitle={`${s.ov.heroSub} · ${coveredRange}`}
      />

      <CoverageBar s={s} lang={lang} weekEnd={lastWeekEnd} />

      <GoalTracker s={s} lang={lang} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, color: C.inkDim }}>{s.ov.range}</span>
        <div style={{ display: "flex", background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2 }}>
          {MODES.map(m => (
            <button key={m} onClick={() => setMode(m)}
              style={{ padding: "6px 12px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, background: mode === m ? C.accent : "transparent", color: mode === m ? "#fff" : C.inkDim }}>
              {s.ov[`mode${m[0].toUpperCase()}${m.slice(1)}`]}
            </button>
          ))}
        </div>

        {mode === "week" && (
          <select value={selection.week || ""} onChange={e => setSelection(p => ({ ...p, week: e.target.value }))} style={selectStyle}>
            {[...weeks].reverse().map(w => (
              <option key={w.week} value={w.week}>{formatWeek(w.week, lang)}</option>
            ))}
          </select>
        )}

        {mode === "month" && (
          <select value={selection.month || ""} onChange={e => setSelection(p => ({ ...p, month: e.target.value }))} style={selectStyle}>
            {[...months].reverse().map(m => (
              <option key={m} value={m}>{formatMonth(m, lang)}</option>
            ))}
          </select>
        )}

        {mode === "custom" && (
          <>
            <label style={{ fontSize: 12, color: C.inkDim }}>{s.ov.periodFrom}</label>
            <input type="date" value={selection.start || ""} onChange={e => setSelection(p => ({ ...p, start: e.target.value }))} style={selectStyle} />
            <label style={{ fontSize: 12, color: C.inkDim }}>{s.ov.periodTo}</label>
            <input type="date" value={selection.end || ""} onChange={e => setSelection(p => ({ ...p, end: e.target.value }))} style={selectStyle} />
          </>
        )}

        <span style={{ fontSize: 12, color: C.inkFaint }}>
          {rangeBusy ? <Spinner size={13} />
            : exactRange
              ? (rangeRow.prior ? s.ov.comparedToDays.replace("{n}", String(rangeRow.days)) : s.ov.noPriorPeriod)
              : priorWeeks.length
                ? (shown.length === 1 ? s.ov.comparedToWeek : s.ov.comparedTo.replace("{n}", String(priorWeeks.length)))
                : s.ov.noPriorPeriod}
        </span>
      </div>

      <div style={{ fontSize: 11.5, color: C.inkFaint, marginBottom: 16, lineHeight: 1.5 }}>
        {mode === "custom"
          ? [s.ov.exactDaysNote, ...rangeCaveats].join(" ")
          : mode === "week" ? s.ov.wholeWeeksNote : `${s.ov.wholeWeeksNote} ${s.ov.weekGrainOnly}`}
      </div>

      {!shown.length && !exactRange && <Panel style={{ marginBottom: 16, color: C.inkDim, fontSize: 12.5 }}>{s.ov.noWeeks}</Panel>}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <SparkTile {...tile("sessions", s.ga4Kpi.sessions, fmtInt, "up", "#6E9BF2")} />
        <SparkTile {...tile("registrations", s.ov.legendReg, fmtInt, "up", C.accent)} />
        <SparkTile {...tile("ftds", s.ov.legendFtd, fmtInt, "up", C.accent)} />
        <SparkTile {...tile("ggr", s.ov.legendGgr, v => fmtDOP(v), "up", C.positive)} />
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 26 }}>
        <SparkTile {...tile("costPerRegistration", s.wk.rows.costPerRegistration, fmtMoney2, "down", "#D9A848")} />
        <SparkTile {...tile("costPerAcquisition", s.wk.rows.costPerAcquisition, fmtMoney2, "down", "#D9A848")} />
        <SparkTile {...tile("roasGgr", s.wk.rows.roasGgr, fmtX, "up", C.positive)} />
        <SparkTile {...tile("registrationToDeposit", s.wk.rows.registrationToDeposit, fmtPct, "up", "#B073F0")} />
      </div>

      <SectionHeading title={s.ov.trendRegFtd} />
      <Panel style={{ marginBottom: 24 }}>
        <ResponsiveContainer width="100%" height={210}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.panelBorder} vertical={false} />
            <XAxis dataKey="label" {...axis} />
            <YAxis {...axis} />
            <Tooltip {...tooltip} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="registrations" name={s.ov.legendReg} stroke="#6E9BF2" fill="#6E9BF2" fillOpacity={0.2} strokeWidth={2} connectNulls />
            <Area type="monotone" dataKey="ftds" name={s.ov.legendFtd} stroke={C.accent} fill={C.accent} fillOpacity={0.25} strokeWidth={2} connectNulls />
          </AreaChart>
        </ResponsiveContainer>
      </Panel>

      <SectionHeading title={s.ov.trendCost} />
      <Panel style={{ marginBottom: 24 }}>
        <ResponsiveContainer width="100%" height={210}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.panelBorder} vertical={false} />
            <XAxis dataKey="label" {...axis} />
            <YAxis {...axis} width={64} />
            <Tooltip {...tooltip} formatter={v => fmtMoney2(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="cpl" name={s.ov.legendCpl} stroke="#D9A848" strokeWidth={2} dot={{ r: 3 }} connectNulls />
            <Line type="monotone" dataKey="cpa" name={s.ov.legendCpa} stroke={C.accent} strokeWidth={2} dot={{ r: 3 }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </Panel>

      <SectionHeading title={s.ov.trendRevenue} />
      <Panel>
        <ResponsiveContainer width="100%" height={210}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.panelBorder} vertical={false} />
            <XAxis dataKey="label" {...axis} />
            <YAxis {...axis} width={70} />
            <Tooltip {...tooltip} formatter={v => fmtDOP(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="ggr" name={s.ov.legendGgr} stroke={C.positive} fill={C.positive} fillOpacity={0.2} strokeWidth={2} connectNulls />
            <Area type="monotone" dataKey="deposits" name={s.ov.legendDeposits} stroke="#B073F0" fill="#B073F0" fillOpacity={0.18} strokeWidth={2} connectNulls />
          </AreaChart>
        </ResponsiveContainer>
      </Panel>
    </>
  );
}
