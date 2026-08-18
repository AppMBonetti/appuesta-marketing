import { useEffect, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { Wallet, TrendingUp, Coins, Users, Percent, PiggyBank } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { getPeriodRange, formatWeek } from "../lib/period";
import { weeklyFromSnapshots } from "../lib/metrics";
import { SectionHeading, Panel, KpiCard, PeriodBar, Spinner, fmtDOP, deltaOf, EmptyState } from "../components/ui";

async function countDepositStage(minCount, start, end) {
  const { count, error } = await supabase
    .from("players")
    .select("*", { count: "exact", head: true })
    .gte("registered_at", start)
    .lt("registered_at", end)
    .gte("total_deposit_count", minCount);
  if (error) throw error;
  return count ?? 0;
}

function WeeklyBarChart({ data, lang, color, money = true }) {
  const chartData = data.map(d => ({ ...d, label: formatWeek(d.week, lang) }));
  return (
    <ResponsiveContainer width="100%" height={210}>
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.panelBorder} vertical={false} />
        <XAxis dataKey="label" stroke={C.inkFaint} fontSize={11} tickLine={false} axisLine={false} />
        <YAxis stroke={C.inkFaint} fontSize={11} tickLine={false} axisLine={false} width={money ? 62 : 34} />
        <Tooltip
          contentStyle={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 8, fontSize: 12 }}
          formatter={v => (money ? fmtDOP(v) : v.toLocaleString())}
        />
        <Bar dataKey="value" fill={color} radius={[6, 6, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function InfoNote({ children, tone = "neutral" }) {
  const palette = tone === "warn"
    ? { bg: "#2C1B1A", border: `${C.negative}40`, color: C.negative }
    : { bg: "#161A21", border: C.panelBorder, color: C.inkDim };
  return (
    <div style={{ background: palette.bg, border: `1px solid ${palette.border}`, borderRadius: 12, padding: "12px 16px", fontSize: 12.5, color: palette.color, marginBottom: 20 }}>
      {children}
    </div>
  );
}

export default function Funnel({ s, lang }) {
  const [view, setView] = useState("deposits");
  const [period, setPeriod] = useState("week");
  const [customStart, setCustomStart] = useState(new Date().toISOString().slice(0, 10));
  const [customEnd, setCustomEnd] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [tierRows, setTierRows] = useState([]);
  const [dailyTotals, setDailyTotals] = useState([]);
  const [ftdWeekly, setFtdWeekly] = useState([]);
  const [betsWeekly, setBetsWeekly] = useState([]);
  const [topGgr, setTopGgr] = useState([]);

  const stages = [
    { key: "reg", min: 0, stageEs: "Registro", stageEn: "Registration" },
    { key: "ftd", min: 1, stageEs: "FTD", stageEn: "FTD" },
    { key: "d2", min: 2, stageEs: "2do depósito", stageEn: "2nd deposit" },
    { key: "d3", min: 3, stageEs: "3er depósito", stageEn: "3rd deposit" },
    { key: "d4", min: 4, stageEs: "4+ depósitos", stageEn: "4+ deposits" },
  ];

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const range = getPeriodRange(period, customStart, customEnd);
        const { current, previous } = range;

        const currentCounts = await Promise.all(stages.map(st => countDepositStage(st.min, current.start, current.end)));
        const previousCounts = previous ? await Promise.all(stages.map(st => countDepositStage(st.min, previous.start, previous.end))) : stages.map(() => null);

        const { data: depRows, error: depErr } = await supabase
          .from("players")
          .select("avg_deposit_amount, avg_sportsbook_bet_amount")
          .gte("registered_at", current.start)
          .lt("registered_at", current.end)
          .eq("is_ftd", true);
        if (depErr) throw depErr;

        const avgDeposit = depRows.length ? depRows.reduce((sum, r) => sum + (r.avg_deposit_amount || 0), 0) / depRows.length : null;
        const avgBet = depRows.length ? depRows.reduce((sum, r) => sum + (r.avg_sportsbook_bet_amount || 0), 0) / depRows.length : null;

        if (!active) return;
        setData({
          current: Object.fromEntries(stages.map((st, i) => [st.key, currentCounts[i]])),
          previous: Object.fromEntries(stages.map((st, i) => [st.key, previousCounts[i]])),
          avgDeposit, avgBet,
        });

        // Everything below is cumulative rather than period-scoped: tier totals,
        // the weekly series, and the GGR leaderboard all describe the book to date.
        const [tiersRes, dailyRes, ftdRes, betsRes, topRes] = await Promise.all([
          supabase.from("vip_tier_summary").select("*").order("tier_order"),
          supabase.from("snapshot_daily_totals").select("*").order("snapshot_date"),
          supabase.from("ftd_weekly").select("*").order("week_start"),
          supabase.from("bets_weekly").select("*").order("week_start"),
          supabase.from("players").select("id, name, total_ggr_sportsbook, total_deposit_amount, vip_tier")
            .not("total_ggr_sportsbook", "is", null)
            .order("total_ggr_sportsbook", { ascending: false })
            .limit(10),
        ]);
        if (tiersRes.error) throw tiersRes.error;
        if (dailyRes.error) throw dailyRes.error;
        if (ftdRes.error) throw ftdRes.error;
        if (betsRes.error) throw betsRes.error;
        if (topRes.error) throw topRes.error;

        if (!active) return;
        setTierRows(tiersRes.data || []);
        setDailyTotals(dailyRes.data || []);
        setFtdWeekly(ftdRes.data || []);
        setBetsWeekly(betsRes.data || []);
        setTopGgr(topRes.data || []);
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [period, customStart, customEnd]);

  const periodBarProps = { s, period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd };
  const maxFunnel = data?.current?.reg || 0;
  const hasTierData = tierRows.some(r => r.players > 0);

  const depositsWeekly = weeklyFromSnapshots(dailyTotals, "total_deposits");
  const snapshotGgrWeekly = weeklyFromSnapshots(dailyTotals, "total_ggr");
  // Altenar bets carry a real bet_date, so they give a true weekly GGR series
  // from a single import; snapshot deltas are the fallback until then.
  const hasBets = betsWeekly.length > 0;
  const ggrWeekly = hasBets
    ? betsWeekly.map(b => ({ week: b.week_start, value: Number(b.ggr) || 0 }))
    : snapshotGgrWeekly;
  const ftdWeeklyChart = ftdWeekly.map(r => ({ week: r.week_start, value: r.ftds }));

  const latestTotals = dailyTotals.length ? dailyTotals[dailyTotals.length - 1] : null;
  const totalGgr = Number(latestTotals?.total_ggr ?? 0);
  const totalDeposits = Number(latestTotals?.total_deposits ?? 0);
  const ftdPlayers = Number(latestTotals?.ftd_players ?? 0);
  const ggrPerPlayer = ftdPlayers > 0 ? totalGgr / ftdPlayers : null;
  const depositMargin = totalDeposits > 0 ? totalGgr / totalDeposits : null;
  const totalStake = betsWeekly.reduce((sum, b) => sum + (Number(b.stake) || 0), 0);
  const holdRate = totalStake > 0 ? ggrWeekly.reduce((sum, w) => sum + w.value, 0) / totalStake : null;

  const thStyle = { padding: "12px 16px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 12 };

  return (
    <>
      <SectionHeading
        title={view === "deposits" ? s.funnelTitle : s.ggrTitle}
        subtitle={view === "deposits" ? s.funnelSub : s.ggrSub}
      />

      <div style={{ display: "flex", marginBottom: 16, background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2, width: "fit-content" }}>
        {[["deposits", s.depView.deposits], ["ggr", s.depView.ggr]].map(([v, label]) => (
          <button key={v} onClick={() => setView(v)} style={{ padding: "6px 18px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 500, background: view === v ? C.accent : "transparent", color: view === v ? "#fff" : C.inkDim }}>{label}</button>
        ))}
      </div>

      {view === "deposits" && <PeriodBar {...periodBarProps} />}

      {loading && <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>}
      {error && <Panel style={{ color: C.negative, marginBottom: 20 }}>{error}</Panel>}

      {!loading && !error && view === "deposits" && data && (
        <>
          <div style={{ display: "flex", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
            <KpiCard icon={Wallet} label={s.avgDeposit} value={fmtDOP(data.avgDeposit)} />
            <KpiCard icon={TrendingUp} label={s.avgBet} value={fmtDOP(data.avgBet)} />
            <KpiCard icon={PiggyBank} label={s.ggrKpi.deposits} value={fmtDOP(totalDeposits)} />
          </div>

          {maxFunnel === 0 ? (
            <div style={{ marginBottom: 28 }}><EmptyState s={s} /></div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 28 }}>
              {stages.map(f => {
                const val = data.current[f.key]; const prevVal = data.previous[f.key]; const d = deltaOf(val, prevVal); const p = Math.round((val / maxFunnel) * 100);
                return (
                  <div key={f.key} style={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", gap: 16 }}>
                    <div style={{ width: 120, fontSize: 13, color: C.inkDim }}>{lang === "es" ? f.stageEs : f.stageEn}</div>
                    <div style={{ flex: 1, background: "#1D222B", borderRadius: 8, height: 26 }}><div style={{ width: `${p}%`, height: "100%", borderRadius: 8, background: `linear-gradient(90deg, ${C.accent}, ${C.accentDim})` }} /></div>
                    <div style={{ width: 80, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>{val.toLocaleString()}</div>
                    <div style={{ width: 40, textAlign: "right", color: C.inkFaint, fontSize: 12.5 }}>{p}%</div>
                    <div style={{ width: 60, textAlign: "right", fontSize: 11.5, color: d?.positive ? C.positive : C.negative }}>{d?.label ?? "—"}</div>
                  </div>
                );
              })}
            </div>
          )}

          <SectionHeading title={s.depWeeklyTitle} subtitle={s.depWeeklySub} />
          {depositsWeekly.length === 0 ? (
            <InfoNote>{s.needsTwoSnapshots}</InfoNote>
          ) : (
            <Panel style={{ marginBottom: 26 }}><WeeklyBarChart data={depositsWeekly} lang={lang} color={C.accent} /></Panel>
          )}

          <SectionHeading title={s.ftdWeeklyTitle} subtitle={s.ftdWeeklySub} />
          {ftdWeeklyChart.length === 0 ? <div style={{ marginBottom: 26 }}><EmptyState s={s} /></div> : (
            <Panel style={{ marginBottom: 26 }}><WeeklyBarChart data={ftdWeeklyChart} lang={lang} color={C.positive} money={false} /></Panel>
          )}

          <SectionHeading title={s.depByTierTitle} subtitle={s.depByTierSub} />
          {!hasTierData ? <EmptyState s={s} /> : (
            <Panel style={{ padding: 4, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr>{[s.vipCols.tier, lang === "es" ? "Total depositado" : "Total deposited", lang === "es" ? "Depósito promedio" : "Avg deposit", s.vipCols.players].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                <tbody>
                  {tierRows.map(t => (
                    <tr key={t.tier_name}>
                      <td style={{ padding: "10px 16px" }}>{t.tier_name}</td>
                      <td style={{ padding: "10px 16px", fontWeight: 500 }}>{fmtDOP(t.total_deposits)}</td>
                      <td style={{ padding: "10px 16px", color: C.inkDim }}>{fmtDOP(t.avg_deposit)}</td>
                      <td style={{ padding: "10px 16px", color: C.inkDim }}>{Number(t.players).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </>
      )}

      {!loading && !error && view === "ggr" && (
        <>
          <div style={{ display: "flex", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
            <KpiCard icon={Coins} label={s.ggrKpi.total} value={fmtDOP(totalGgr)} />
            <KpiCard icon={Users} label={s.ggrKpi.perPlayer} value={fmtDOP(ggrPerPlayer)} />
            <KpiCard icon={PiggyBank} label={s.ggrKpi.deposits} value={fmtDOP(totalDeposits)} />
            <KpiCard icon={Percent} label={s.ggrKpi.margin} value={depositMargin == null ? "—" : `${(depositMargin * 100).toFixed(1)}%`} />
          </div>

          {!hasBets && <InfoNote tone="warn">{s.altenarPending}</InfoNote>}

          <SectionHeading title={s.ggrWeeklyTitle} subtitle={hasBets ? s.ggrSub : s.ggrWeeklySub} />
          {ggrWeekly.length === 0 ? (
            <InfoNote>{s.needsTwoSnapshots}</InfoNote>
          ) : (
            <Panel style={{ marginBottom: 26 }}>
              <WeeklyBarChart data={ggrWeekly} lang={lang} color={C.accent} />
              {holdRate != null && (
                <p style={{ color: C.inkFaint, fontSize: 11.5, margin: "10px 0 0" }}>
                  {lang === "es" ? "Margen sobre monto apostado: " : "Hold on amount wagered: "}
                  <strong style={{ color: C.ink }}>{(holdRate * 100).toFixed(1)}%</strong>
                  {` · ${lang === "es" ? "apostado" : "wagered"} ${fmtDOP(totalStake)}`}
                </p>
              )}
            </Panel>
          )}

          <SectionHeading title={s.ggrByTierTitle} subtitle={s.ggrByTierSub} />
          {!hasTierData ? <div style={{ marginBottom: 26 }}><EmptyState s={s} /></div> : (
            <Panel style={{ padding: 4, overflow: "auto", marginBottom: 26 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr>{[s.vipCols.tier, s.ggrCol, s.depositsCol, s.vipCols.players].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                <tbody>
                  {tierRows.map(t => (
                    <tr key={t.tier_name}>
                      <td style={{ padding: "10px 16px" }}>{t.tier_name}</td>
                      <td style={{ padding: "10px 16px", fontWeight: 500 }}>{fmtDOP(t.total_ggr)}</td>
                      <td style={{ padding: "10px 16px", color: C.inkDim }}>{fmtDOP(t.total_deposits)}</td>
                      <td style={{ padding: "10px 16px", color: C.inkDim }}>{Number(t.players).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}

          <SectionHeading title={s.ggrTopTitle} subtitle={s.ggrTopSub} />
          {topGgr.length === 0 ? <EmptyState s={s} /> : (
            <Panel style={{ padding: 4, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr>{[s.playerCol, s.vipCols.tier, s.ggrCol, s.depositsCol].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                <tbody>
                  {topGgr.map(p => (
                    <tr key={p.id}>
                      <td style={{ padding: "10px 16px", fontWeight: 500 }}>{p.name || p.id}</td>
                      <td style={{ padding: "10px 16px", color: C.inkDim }}>{p.vip_tier || "—"}</td>
                      <td style={{ padding: "10px 16px" }}>{fmtDOP(p.total_ggr_sportsbook)}</td>
                      <td style={{ padding: "10px 16px", color: C.inkDim }}>{fmtDOP(p.total_deposit_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </>
      )}
    </>
  );
}
