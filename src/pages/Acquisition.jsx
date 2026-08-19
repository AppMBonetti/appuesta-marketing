import { useEffect, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { Users, MousePointerClick, Activity, Target, Share2, Eye, UserPlus } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C, LINE_COLORS } from "../lib/theme";
import {
  getPeriodRange, monthOptions, currentBudgetMonth, formatMonth,
  weeksInMonth, previousWeek, weekStartOf,
} from "../lib/period";
import { aggregateByChannel, pivotSessionsByDate, deriveWeeklyKpis } from "../lib/metrics";
import { SectionHeading, Panel, PeriodBar, Spinner, KpiCard, fmtDOP, deltaOf, EmptyState } from "../components/ui";
import WeeklyKpiGrid from "../components/WeeklyKpiGrid";
import GoalTracker from "../components/GoalTracker";

const fmtPct = n => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

export default function Acquisition({ s, lang }) {
  const [tab, setTab] = useState("weekly");

  // Channel view uses the period bar; the weekly report uses the month picker.
  const [period, setPeriod] = useState("week");
  const [customStart, setCustomStart] = useState(new Date().toISOString().slice(0, 10));
  const [customEnd, setCustomEnd] = useState(new Date().toISOString().slice(0, 10));

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [ga4Rows, setGa4Rows] = useState([]);
  const [ga4PrevRows, setGa4PrevRows] = useState([]);
  const [social, setSocial] = useState([]);
  const [ga4View, setGa4View] = useState("stacked");

  const [month, setMonth] = useState(currentBudgetMonth());
  const [weeklyRows, setWeeklyRows] = useState([]);
  const [savingWeek, setSavingWeek] = useState(null);
  const [opsStart, setOpsStart] = useState(null);
  const [budgetGoal, setBudgetGoal] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("app_settings").select("value").eq("key", "operations_start_date").maybeSingle();
      if (active && data?.value) setOpsStart(data.value);
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      const range = getPeriodRange(period, customStart, customEnd);
      const cols = "date, channel, sessions, active_users, engagement_rate, conversions";
      const [cur, prev, ig] = await Promise.all([
        supabase.from("ga4_channel_daily").select(cols).gte("date", range.current.start).lt("date", range.current.end).order("date"),
        range.previous
          ? supabase.from("ga4_channel_daily").select(cols).gte("date", range.previous.start).lt("date", range.previous.end)
          : Promise.resolve({ data: [], error: null }),
        supabase.from("social_daily").select("*").gte("date", range.current.start).lt("date", range.current.end).order("date"),
      ]);
      if (!active) return;
      const failure = cur.error || prev.error || ig.error;
      if (failure) setError(failure.message);
      setGa4Rows(cur.data || []);
      setGa4PrevRows(prev.data || []);
      setSocial(ig.data || []);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [period, customStart, customEnd]);

  const reportWeeks = weeksInMonth(month).filter(w => !opsStart || w >= weekStartOf(opsStart));

  async function loadWeekly() {
    if (!reportWeeks.length) return;
    const [weekly, goal] = await Promise.all([
      supabase.from("weekly_kpis").select("*")
        .gte("week_start", previousWeek(reportWeeks[0]))
        .lte("week_start", reportWeeks[reportWeeks.length - 1]),
      supabase.from("goals").select("target_value")
        .eq("period_start", month).eq("period_type", "month").eq("metric_name", "monthly_budget").maybeSingle(),
    ]);
    if (weekly.error) { setError(weekly.error.message); return; }
    setWeeklyRows(weekly.data || []);
    setBudgetGoal(goal.data?.target_value ?? null);
  }

  useEffect(() => { loadWeekly(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [month, opsStart]);

  async function saveWeeklySpend(week, value) {
    setSavingWeek(week);
    const { error: err } = await supabase.from("weekly_spend")
      .upsert({ week_start: week, spend_dop: value, updated_at: new Date().toISOString() }, { onConflict: "week_start" });
    setSavingWeek(null);
    if (err) { setError(err.message); return; }
    loadWeekly();
  }

  const rowsByWeek = Object.fromEntries(weeklyRows.map(r => [r.week_start, deriveWeeklyKpis(r)]));
  const monthSpend = reportWeeks.reduce((sum, w) => sum + (rowsByWeek[w]?.spend ?? 0), 0);

  const ga4Current = aggregateByChannel(ga4Rows);
  const ga4Previous = aggregateByChannel(ga4PrevRows);
  const sessionsSeries = pivotSessionsByDate(ga4Rows);
  const ga4Channels = ga4Current.map(c => c.channel);
  const totalSessions = ga4Current.reduce((sum, c) => sum + c.sessions, 0);
  const totalUsers = ga4Current.reduce((sum, c) => sum + c.active_users, 0);
  const totalConversions = ga4Current.reduce((sum, c) => sum + c.conversions, 0);
  const weightedEngagement = totalSessions > 0
    ? ga4Current.reduce((sum, c) => sum + c.engagement_rate * c.sessions, 0) / totalSessions : null;
  const sessionsDelta = deltaOf(totalSessions, ga4Previous.reduce((sum, c) => sum + c.sessions, 0));

  const igTotals = social.reduce((acc, r) => ({
    reach: acc.reach + (r.reach || 0),
    views: acc.views + (r.profile_views || 0),
    followers: acc.followers + (r.new_followers || 0),
  }), { reach: 0, views: 0, followers: 0 });

  const thStyle = { padding: "12px 16px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 12 };
  const axis = { stroke: C.inkFaint, fontSize: 11, tickLine: false, axisLine: false };
  const tooltip = { contentStyle: { background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 8, fontSize: 12 } };

  return (
    <>
      <SectionHeading title={s.acqTitle} subtitle={s.acqSub} />

      <div style={{ display: "flex", marginBottom: 16, background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2, width: "fit-content" }}>
        {[["weekly", s.wk.viewWeekly], ["channels", s.social.channelsTitle]].map(([v, label]) => (
          <button key={v} onClick={() => setTab(v)} style={{ padding: "6px 18px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 500, background: tab === v ? C.accent : "transparent", color: tab === v ? "#fff" : C.inkDim }}>{label}</button>
        ))}
      </div>

      {error && <Panel style={{ color: C.negative, marginBottom: 16 }}>{error}</Panel>}

      {tab === "weekly" ? (
        <>
          <SectionHeading title={s.wk.title} subtitle={s.wk.sub} />
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
            <select value={month} onChange={e => setMonth(e.target.value)}
              style={{ background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 8, color: C.ink, padding: "7px 10px", fontSize: 12.5, textTransform: "capitalize" }}>
              {monthOptions().map(m => <option key={m} value={m}>{formatMonth(m, lang)}</option>)}
            </select>
            <span style={{ fontSize: 12.5, color: C.inkDim }}>
              {s.wk.goalLine}: <strong style={{ color: C.ink }}>{budgetGoal ? fmtDOP(budgetGoal) : "—"}</strong>
              {"  ·  "}{s.wk.actualLine}: <strong style={{ color: C.ink }}>{fmtDOP(monthSpend)}</strong>
              {budgetGoal > 0 && (
                <span style={{ color: monthSpend > budgetGoal ? C.negative : C.inkFaint }}>
                  {`  ·  ${((monthSpend / budgetGoal) * 100).toFixed(0)}% ${s.wk.ofGoal}`}
                </span>
              )}
            </span>
          </div>

          <GoalTracker s={s} lang={lang} month={month} />

          <WeeklyKpiGrid s={s} lang={lang} weeks={reportWeeks} rowsByWeek={rowsByWeek}
            onEditSpend={saveWeeklySpend} savingWeek={savingWeek} />

          <p style={{ color: C.inkFaint, fontSize: 11.5, margin: "12px 0 0", maxWidth: 780, lineHeight: 1.6 }}>{s.wk.spendFallback}</p>
          <p style={{ color: C.inkFaint, fontSize: 11.5, margin: "8px 0 26px", maxWidth: 780, lineHeight: 1.6 }}>{s.wk.pendingSources}</p>
        </>
      ) : (
        <>
          <PeriodBar s={s} period={period} setPeriod={setPeriod} customStart={customStart}
            setCustomStart={setCustomStart} customEnd={customEnd} setCustomEnd={setCustomEnd} />

          {loading && <div style={{ display: "flex", justifyContent: "center", padding: 40 }}><Spinner size={20} /></div>}

          <SectionHeading title={s.trafficByChannel} subtitle={s.trafficByChannelSub} />
          {totalSessions === 0 ? <div style={{ marginBottom: 20 }}><EmptyState s={s} /></div> : (
            <>
              <div style={{ display: "flex", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
                <KpiCard icon={Users} label={s.ga4Kpi.sessions} value={totalSessions.toLocaleString()} delta={sessionsDelta?.label} deltaGood={sessionsDelta?.positive} />
                <KpiCard icon={MousePointerClick} label={s.ga4Kpi.users} value={totalUsers.toLocaleString()} />
                <KpiCard icon={Activity} label={s.ga4Kpi.engagement} value={fmtPct(weightedEngagement)} />
                <KpiCard icon={Target} label={s.ga4Kpi.conversions} value={totalConversions.toLocaleString()} />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
                <div style={{ display: "flex", background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2 }}>
                  {[["stacked", s.ga4Stacked], ["total", s.ga4Total]].map(([v, label]) => (
                    <button key={v} onClick={() => setGa4View(v)} style={{ padding: "6px 12px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, background: ga4View === v ? C.accent : "transparent", color: ga4View === v ? "#fff" : C.inkDim }}>{label}</button>
                  ))}
                </div>
              </div>

              <Panel style={{ marginBottom: 16 }}>
                <ResponsiveContainer width="100%" height={230}>
                  <AreaChart data={sessionsSeries}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.panelBorder} vertical={false} />
                    <XAxis dataKey="date" {...axis} />
                    <YAxis {...axis} />
                    <Tooltip {...tooltip} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {ga4View === "stacked"
                      ? ga4Channels.map((ch, i) => (
                        <Area key={ch} type="monotone" dataKey={ch} stackId="sessions" stroke={LINE_COLORS[i % LINE_COLORS.length]} fill={LINE_COLORS[i % LINE_COLORS.length]} fillOpacity={0.28} strokeWidth={1.5} />
                      ))
                      : <Area type="monotone" dataKey={d => ga4Channels.reduce((sum, ch) => sum + (d[ch] || 0), 0)} name={s.ga4Kpi.sessions} stroke={C.accent} fill={C.accent} fillOpacity={0.22} strokeWidth={2} />}
                  </AreaChart>
                </ResponsiveContainer>
              </Panel>

              <Panel style={{ padding: 4, overflow: "auto", marginBottom: 16 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr>{[s.ga4Cols.channel, s.ga4Cols.sessions, s.ga4Cols.share, s.ga4Cols.users, s.ga4Cols.engagement, s.ga4Cols.delta].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                  <tbody>
                    {ga4Current.map((c, i) => {
                      const d = deltaOf(c.sessions, ga4Previous.find(p => p.channel === c.channel)?.sessions ?? 0);
                      const share = totalSessions > 0 ? (c.sessions / totalSessions) * 100 : 0;
                      return (
                        <tr key={c.channel}>
                          <td style={{ padding: "10px 16px" }}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                              <span style={{ width: 9, height: 9, borderRadius: 99, background: LINE_COLORS[i % LINE_COLORS.length] }} />
                              {c.channel}
                            </span>
                          </td>
                          <td style={{ padding: "10px 16px", fontWeight: 600 }}>{c.sessions.toLocaleString()}</td>
                          <td style={{ padding: "10px 16px", color: C.inkDim, minWidth: 130 }}>
                            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ flex: 1, background: "#1D222B", borderRadius: 6, height: 7, minWidth: 50 }}>
                                <span style={{ display: "block", width: `${share}%`, height: "100%", borderRadius: 6, background: LINE_COLORS[i % LINE_COLORS.length] }} />
                              </span>
                              {share.toFixed(1)}%
                            </span>
                          </td>
                          <td style={{ padding: "10px 16px", color: C.inkDim }}>{c.active_users.toLocaleString()}</td>
                          <td style={{ padding: "10px 16px", color: C.inkDim }}>{fmtPct(c.engagement_rate)}</td>
                          <td style={{ padding: "10px 16px", fontSize: 12, color: d ? (d.positive ? C.positive : C.negative) : C.inkFaint }}>{d?.label ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Panel>
            </>
          )}
          <div style={{ background: "#2C1B1A", border: `1px solid ${C.negative}40`, borderRadius: 12, padding: "12px 16px", fontSize: 12.5, color: C.negative, marginBottom: 26 }}>{s.acqNote}</div>

          <SectionHeading title={s.social.title} subtitle={s.social.sub} />
          {social.length === 0 ? (
            <Panel style={{ color: C.inkDim, fontSize: 12.5 }}>{s.social.noData}</Panel>
          ) : (
            <>
              <div style={{ display: "flex", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
                <KpiCard icon={Share2} label={s.social.reach} value={igTotals.reach.toLocaleString()} />
                <KpiCard icon={Eye} label={s.social.views} value={igTotals.views.toLocaleString()} />
                <KpiCard icon={UserPlus} label={s.social.followers} value={igTotals.followers.toLocaleString()} />
              </div>
              <Panel>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={social}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.panelBorder} vertical={false} />
                    <XAxis dataKey="date" {...axis} />
                    <YAxis {...axis} />
                    <Tooltip {...tooltip} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="reach" name={s.social.reach} fill="#B073F0" radius={[5, 5, 0, 0]} />
                    <Bar dataKey="profile_views" name={s.social.views} fill="#6E9BF2" radius={[5, 5, 0, 0]} />
                    <Bar dataKey="new_followers" name={s.social.followers} fill={C.positive} radius={[5, 5, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Panel>
            </>
          )}
        </>
      )}
    </>
  );
}
