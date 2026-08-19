import { useEffect, useState } from "react";
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { formatWeek, addDays, dateRangeLabel } from "../lib/period";
import { deriveWeeklyKpis, wowChange } from "../lib/metrics";
import { SectionHeading, Panel, Spinner, fmtDOP, EmptyState } from "../components/ui";
import { fmtMoney } from "../lib/currency";
import SparkTile from "../components/SparkTile";
import CoverageBar from "../components/CoverageBar";

const WEEK_RANGES = [4, 8, 12, 0];  // 0 = every week since launch

const fmtInt = v => (v == null ? "—" : Math.round(v).toLocaleString());
const fmtPct = v => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const fmtX = v => (v == null ? "—" : `${v.toFixed(2)}x`);
const fmtMoney2 = v => fmtMoney(v, { decimals: 2 });

export default function Overview({ s, lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [weeks, setWeeks] = useState([]);
  const [range, setRange] = useState(8);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error: err } = await supabase
        .from("weekly_kpis").select("*").order("week_start");
      if (!active) return;
      if (err) { setError(err.message); setLoading(false); return; }
      setWeeks((data || []).map(r => ({ week: r.week_start, ...deriveWeeklyKpis(r) })));
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>;
  if (error) return <Panel style={{ color: C.negative }}>{error}</Panel>;
  if (!weeks.length) return (<><SectionHeading title={s.ov.heroTitle} subtitle={s.ov.heroSub} /><EmptyState s={s} /></>);

  const shown = range === 0 ? weeks : weeks.slice(-range);
  const latest = shown[shown.length - 1] || {};
  const prior = shown[shown.length - 2] || {};
  const seriesOf = key => shown.map(w => w[key]);
  const tile = (key, label, format, better, accent) => ({
    label, value: format(latest[key]), change: wowChange(latest[key], prior[key]),
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
  const coveredRange = firstWeek && coveredEnd
    ? dateRangeLabel(firstWeek, coveredEnd, lang)
    : "";

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

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, color: C.inkDim }}>{s.ov.range}</span>
        <div style={{ display: "flex", background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2 }}>
          {WEEK_RANGES.map(n => (
            <button key={n} onClick={() => setRange(n)}
              style={{ padding: "6px 12px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, background: range === n ? C.accent : "transparent", color: range === n ? "#fff" : C.inkDim }}>
              {n === 0 ? s.ov.weeksAll : s.ov[`weeks${n}`]}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 12, color: C.inkFaint }}>
          {s.ov.lastWeeks.replace("{n}", String(shown.length))}
        </span>
      </div>

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
