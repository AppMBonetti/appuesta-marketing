import { useEffect, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { Radio, Plus } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C, LINE_COLORS } from "../lib/theme";
import { getPeriodRange } from "../lib/period";
import { SectionHeading, Panel, PeriodBar, Spinner, fmtDOP, deltaOf, EmptyState } from "../components/ui";

const METRIC_KEYS = ["spend", "impressions", "clicks", "ctr", "cpc", "cpa", "traffic", "registrations", "deposits", "ftds"];
const FIELD_TO_COLUMN = {
  spend: "spend_dop", impressions: "impressions", clicks: "clicks", ctr: "ctr_pct",
  cpc: "cpc_dop", cpa: "cpa_dop", traffic: "site_traffic", registrations: "registrations",
  deposits: "deposits", ftds: "ftds",
};

function emptyReportForm(channel) {
  return { date: new Date().toISOString().slice(0, 10), channel, spend: "", impressions: "", clicks: "", ctr: "", cpc: "", cpa: "", traffic: "", registrations: "", deposits: "", ftds: "" };
}

function pivotByDate(log, metric) {
  const dates = [...new Set(log.map(r => r.date))].sort();
  const channels = [...new Set(log.map(r => r.channel))];
  return dates.map(date => {
    const row = { date };
    channels.forEach(ch => {
      const entry = log.find(r => r.date === date && r.channel === ch);
      if (entry) row[ch] = entry[metric];
    });
    return row;
  });
}

export default function Acquisition({ s, lang }) {
  const [period, setPeriod] = useState("week");
  const [customStart, setCustomStart] = useState(new Date().toISOString().slice(0, 10));
  const [customEnd, setCustomEnd] = useState(new Date().toISOString().slice(0, 10));

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [channelBudgets, setChannelBudgets] = useState([]);
  const [reportsLog, setReportsLog] = useState([]);
  const [ga4Current, setGa4Current] = useState([]);
  const [ga4Previous, setGa4Previous] = useState([]);

  const [reportForm, setReportForm] = useState(emptyReportForm(""));
  const [submitting, setSubmitting] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState("cpa");
  const [chartView, setChartView] = useState("single");

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const range = getPeriodRange(period, customStart, customEnd);
      const [budgetsRes, reportsRes, ga4CurRes, ga4PrevRes] = await Promise.all([
        supabase.from("channel_budgets").select("*").order("channel"),
        supabase.from("channel_reports").select("*").order("report_date", { ascending: true }),
        supabase.from("ga4_channel_daily").select("channel, sessions").gte("date", range.current.start).lt("date", range.current.end),
        range.previous
          ? supabase.from("ga4_channel_daily").select("channel, sessions").gte("date", range.previous.start).lt("date", range.previous.end)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (budgetsRes.error) throw budgetsRes.error;
      if (reportsRes.error) throw reportsRes.error;
      if (ga4CurRes.error) throw ga4CurRes.error;
      if (ga4PrevRes.error) throw ga4PrevRes.error;

      setChannelBudgets(budgetsRes.data || []);
      setReportsLog((reportsRes.data || []).map(r => ({
        id: r.id, date: r.report_date, channel: r.channel,
        spend: r.spend_dop, impressions: r.impressions, clicks: r.clicks, ctr: r.ctr_pct,
        cpc: r.cpc_dop, cpa: r.cpa_dop, traffic: r.site_traffic,
        registrations: r.registrations, deposits: r.deposits, ftds: r.ftds,
      })));

      const aggBy = (rows) => {
        const m = new Map();
        for (const r of rows) m.set(r.channel, (m.get(r.channel) || 0) + (r.sessions || 0));
        return [...m.entries()].map(([channel, sessions]) => ({ channel, sessions })).sort((a, b) => b.sessions - a.sessions);
      };
      setGa4Current(aggBy(ga4CurRes.data || []));
      setGa4Previous(aggBy(ga4PrevRes.data || []));

      if ((budgetsRes.data || []).length && !reportForm.channel) {
        setReportForm(emptyReportForm(budgetsRes.data[0].channel));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [period, customStart, customEnd]);

  async function updateChannelBudget(channel, field, value) {
    setChannelBudgets(prev => prev.map(c => c.channel === channel ? { ...c, [field]: value } : c));
    const { error } = await supabase.from("channel_budgets").update({ [field]: value }).eq("channel", channel);
    if (error) setError(error.message);
  }

  async function submitReport() {
    const hasAny = METRIC_KEYS.some(k => reportForm[k] !== "");
    if (!hasAny) return;
    setSubmitting(true);
    setError(null);
    const toNullableNum = v => (v === "" ? null : Number(v));
    const payload = { report_date: reportForm.date, channel: reportForm.channel, source: "manual" };
    METRIC_KEYS.forEach(k => { payload[FIELD_TO_COLUMN[k]] = toNullableNum(reportForm[k]); });
    const { error } = await supabase.from("channel_reports").insert(payload);
    setSubmitting(false);
    if (error) { setError(error.message); return; }
    setReportForm(emptyReportForm(reportForm.channel));
    loadAll();
  }

  const periodBarProps = { s, period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd };
  const channelNames = channelBudgets.map(c => c.channel);
  const maxSessions = Math.max(1, ...ga4Current.map(c => c.sessions));

  if (loading && !channelBudgets.length) {
    return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>;
  }

  return (
    <>
      <SectionHeading title={s.acqTitle} subtitle={s.acqSub} />
      <PeriodBar {...periodBarProps} />
      {error && <Panel style={{ color: C.negative, marginBottom: 16 }}>{error}</Panel>}

      {ga4Current.length === 0 ? <div style={{ marginBottom: 20 }}><EmptyState s={s} /></div> : (
        <Panel style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ga4Current.map((c) => {
              const prevVal = ga4Previous.find(p => p.channel === c.channel)?.sessions ?? 0;
              const d = deltaOf(c.sessions, prevVal);
              return (
                <div key={c.channel} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 120, fontSize: 12.5, color: C.inkDim }}>{c.channel}</div>
                  <div style={{ flex: 1, background: "#1D222B", borderRadius: 7, height: 18 }}><div style={{ width: `${(c.sessions / maxSessions) * 100}%`, height: "100%", borderRadius: 7, background: C.accent }} /></div>
                  <div style={{ width: 55, textAlign: "right", fontWeight: 600, fontSize: 13 }}>{c.sessions}</div>
                  <div style={{ width: 60, textAlign: "right", fontSize: 11.5, color: d?.positive ? C.positive : C.negative }}>{d?.label ?? "—"}</div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}
      <div style={{ background: "#2C1B1A", border: `1px solid ${C.negative}40`, borderRadius: 12, padding: "12px 16px", fontSize: 12.5, color: C.negative, marginBottom: 26 }}>{s.acqNote}</div>

      <SectionHeading title={s.budgetByChannel} subtitle={s.budgetByChannelSub} />
      <Panel style={{ padding: 4, overflow: "hidden", marginBottom: 26 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>{[s.channelCol, s.liveCol, s.budgetCol].map(h => <th key={h} style={{ padding: "12px 16px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 12 }}>{h}</th>)}</tr></thead>
          <tbody>
            {channelBudgets.map(c => (
              <tr key={c.channel}>
                <td style={{ padding: "10px 16px", fontWeight: 500 }}>{c.channel}</td>
                <td style={{ padding: "10px 16px" }}>
                  <button onClick={() => updateChannelBudget(c.channel, "live", !c.live)} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "none", background: "transparent", cursor: "pointer", color: c.live ? C.positive : C.inkFaint, fontSize: 12 }}>
                    <Radio size={13} fill={c.live ? C.positive : "none"} />{c.live ? (lang === "es" ? "Activo" : "Live") : (lang === "es" ? "Inactivo" : "Off")}
                  </button>
                </td>
                <td style={{ padding: "8px 16px" }}>
                  <input type="number" defaultValue={c.monthly_budget} onBlur={e => updateChannelBudget(c.channel, "monthly_budget", e.target.value === "" ? 0 : Number(e.target.value))} style={{ background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 8, color: C.ink, padding: "7px 10px", width: 130, fontSize: 13 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <SectionHeading title={s.reportsTitle} subtitle={s.reportsSub} />
      <Panel style={{ marginBottom: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr", gap: 10, alignItems: "end" }}>
          <div><div style={{ fontSize: 11, color: C.inkDim, marginBottom: 4 }}>{s.reportFields.date}</div>
            <input type="date" value={reportForm.date} onChange={e => setReportForm(f => ({ ...f, date: e.target.value }))} style={{ background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 7, color: C.ink, padding: "7px 8px", fontSize: 12.5, width: "100%" }} /></div>
          <div><div style={{ fontSize: 11, color: C.inkDim, marginBottom: 4 }}>{s.reportFields.channel}</div>
            <select value={reportForm.channel} onChange={e => setReportForm(f => ({ ...f, channel: e.target.value }))} style={{ background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 7, color: C.ink, padding: "7px 8px", fontSize: 12.5, width: "100%" }}>
              {channelNames.map(c => <option key={c} value={c}>{c}</option>)}
            </select></div>
          {["spend", "impressions", "clicks", "ctr", "cpc", "cpa"].map(f => (
            <div key={f}><div style={{ fontSize: 11, color: C.inkDim, marginBottom: 4 }}>{s.reportFields[f]}</div>
              <input type="number" value={reportForm[f]} onChange={e => setReportForm(form => ({ ...form, [f]: e.target.value }))} style={{ background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 7, color: C.ink, padding: "7px 8px", fontSize: 12.5, width: "100%" }} /></div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 10 }}>
          {["traffic", "registrations", "deposits", "ftds"].map(f => (
            <div key={f}><div style={{ fontSize: 11, color: C.inkDim, marginBottom: 4 }}>{s.reportFields[f]} <span style={{ color: C.inkFaint }}>({lang === "es" ? "si aplica" : "if applicable"})</span></div>
              <input type="number" value={reportForm[f]} onChange={e => setReportForm(form => ({ ...form, [f]: e.target.value }))} style={{ background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 7, color: C.ink, padding: "7px 8px", fontSize: 12.5, width: "100%" }} /></div>
          ))}
        </div>
        <button onClick={submitReport} disabled={submitting} style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, border: "none", background: C.accent, color: "#fff", fontSize: 13, fontWeight: 500, cursor: submitting ? "default" : "pointer", opacity: submitting ? 0.7 : 1 }}>
          {submitting ? <Spinner /> : <Plus size={14} />} {s.addReport}
        </button>
      </Panel>

      {reportsLog.length === 0 ? <div style={{ marginBottom: 20 }}><EmptyState s={s} /></div> : (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
            <div style={{ fontSize: 13, color: C.inkDim }}>{s.cpaTrend}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {chartView === "single" && (
                <select value={selectedMetric} onChange={e => setSelectedMetric(e.target.value)} style={{ background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 7, color: C.ink, padding: "6px 10px", fontSize: 12.5 }}>
                  {METRIC_KEYS.map(k => <option key={k} value={k}>{s.reportFields[k]}</option>)}
                </select>
              )}
              <div style={{ display: "flex", background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2 }}>
                {["single", "grid"].map(v => (
                  <button key={v} onClick={() => setChartView(v)} style={{ padding: "6px 12px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, background: chartView === v ? C.accent : "transparent", color: chartView === v ? "#fff" : C.inkDim }}>
                    {v === "single" ? s.viewSingle : s.viewGrid}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {chartView === "single" ? (
            <Panel style={{ marginBottom: 20 }}>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={pivotByDate(reportsLog, selectedMetric)}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.panelBorder} vertical={false} />
                  <XAxis dataKey="date" stroke={C.inkFaint} fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke={C.inkFaint} fontSize={11} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 8, fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {channelNames.filter(c => reportsLog.some(r => r.channel === c && r[selectedMetric] != null)).map((c, i) => (
                    <Line key={c} type="monotone" dataKey={c} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} connectNulls dot={{ r: 3 }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
              <p style={{ color: C.inkFaint, fontSize: 11.5, margin: "10px 0 0" }}>
                {lang === "es" ? "Los canales sin datos para este KPI no aparecen — no todos los campos aplican a todos los canales." : "Channels without data for this KPI don't appear — not every field applies to every channel."}
              </p>
            </Panel>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, marginBottom: 20 }}>
              {METRIC_KEYS.filter(m => reportsLog.some(r => r[m] != null)).map(m => (
                <Panel key={m} style={{ padding: 14 }}>
                  <div style={{ fontSize: 12, color: C.inkDim, marginBottom: 8 }}>{s.reportFields[m]}</div>
                  <ResponsiveContainer width="100%" height={130}>
                    <LineChart data={pivotByDate(reportsLog, m)}>
                      <XAxis dataKey="date" stroke={C.inkFaint} fontSize={9.5} tickLine={false} axisLine={false} />
                      <YAxis stroke={C.inkFaint} fontSize={9.5} tickLine={false} axisLine={false} width={34} />
                      <Tooltip contentStyle={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 8, fontSize: 11 }} />
                      {channelNames.filter(c => reportsLog.some(r => r.channel === c && r[m] != null)).map((c, i) => (
                        <Line key={c} type="monotone" dataKey={c} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} connectNulls dot={{ r: 2 }} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </Panel>
              ))}
            </div>
          )}

          <div style={{ fontSize: 13, color: C.inkDim, marginBottom: 10 }}>{s.reportLog}</div>
          <Panel style={{ padding: 4, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead><tr>{[s.reportFields.date, s.reportFields.channel, s.reportFields.spend, s.reportFields.impressions, s.reportFields.clicks, s.reportFields.ctr, s.reportFields.cpc, s.reportFields.cpa, s.reportFields.traffic, s.reportFields.registrations, s.reportFields.deposits, s.reportFields.ftds].map(h => <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
              <tbody>
                {[...reportsLog].reverse().map(r => (
                  <tr key={r.id}>
                    <td style={{ padding: "8px 14px" }}>{r.date}</td><td style={{ padding: "8px 14px", fontWeight: 500 }}>{r.channel}</td>
                    <td style={{ padding: "8px 14px" }}>{fmtDOP(r.spend)}</td><td style={{ padding: "8px 14px" }}>{r.impressions?.toLocaleString() ?? "—"}</td>
                    <td style={{ padding: "8px 14px" }}>{r.clicks?.toLocaleString() ?? "—"}</td><td style={{ padding: "8px 14px" }}>{r.ctr != null ? `${r.ctr}%` : "—"}</td>
                    <td style={{ padding: "8px 14px" }}>{fmtDOP(r.cpc)}</td><td style={{ padding: "8px 14px" }}>{fmtDOP(r.cpa)}</td>
                    <td style={{ padding: "8px 14px" }}>{r.traffic?.toLocaleString() ?? "—"}</td>
                    <td style={{ padding: "8px 14px" }}>{r.registrations?.toLocaleString() ?? "—"}</td>
                    <td style={{ padding: "8px 14px" }}>{r.deposits?.toLocaleString() ?? "—"}</td>
                    <td style={{ padding: "8px 14px" }}>{r.ftds?.toLocaleString() ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </>
  );
}
