import { useEffect, useState } from "react";
import { Wallet, TrendingUp } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { getPeriodRange } from "../lib/period";
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

export default function Funnel({ s, lang }) {
  const [period, setPeriod] = useState("week");
  const [customStart, setCustomStart] = useState(new Date().toISOString().slice(0, 10));
  const [customEnd, setCustomEnd] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [tierRows, setTierRows] = useState([]);

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

        // Deposits by VIP tier (independent of period — cumulative totals)
        const { data: tierData, error: tierErr } = await supabase
          .from("players")
          .select("vip_tier, total_deposit_amount")
          .not("vip_tier", "is", null);
        if (tierErr) throw tierErr;

        const { data: tierDefs } = await supabase.from("vip_tiers").select("tier_name, tier_order").order("tier_order");

        const grouped = new Map();
        for (const r of tierData) {
          const g = grouped.get(r.vip_tier) || { total: 0, count: 0 };
          g.total += r.total_deposit_amount || 0;
          g.count += 1;
          grouped.set(r.vip_tier, g);
        }
        const rows = (tierDefs || []).map(t => {
          const g = grouped.get(t.tier_name) || { total: 0, count: 0 };
          return { tier: t.tier_name, total: g.total, avg: g.count ? g.total / g.count : 0, players: g.count };
        });
        if (active) setTierRows(rows);
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [period, customStart, customEnd]);

  const periodBarProps = { s, period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd };
  const maxFunnel = data?.current?.reg || 0;
  const hasData = tierRows.some(r => r.players > 0);

  return (
    <>
      <SectionHeading title={s.funnelTitle} subtitle={s.funnelSub} />
      <PeriodBar {...periodBarProps} />

      {loading && <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>}
      {error && <Panel style={{ color: C.negative, marginBottom: 20 }}>{error}</Panel>}

      {!loading && !error && data && (
        <>
          <div style={{ display: "flex", gap: 14, marginBottom: 20 }}>
            <KpiCard icon={Wallet} label={s.avgDeposit} value={fmtDOP(data.avgDeposit)} />
            <KpiCard icon={TrendingUp} label={s.avgBet} value={fmtDOP(data.avgBet)} />
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

          <SectionHeading title={s.depByTierTitle} subtitle={s.depByTierSub} />
          {!hasData ? <EmptyState s={s} /> : (
            <Panel style={{ padding: 4, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr>{[s.vipCols.tier, lang === "es" ? "Total depositado" : "Total deposited", lang === "es" ? "Depósito promedio" : "Avg deposit", s.vipCols.players].map(h => <th key={h} style={{ padding: "12px 16px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 12 }}>{h}</th>)}</tr></thead>
                <tbody>
                  {tierRows.map(t => (
                    <tr key={t.tier}>
                      <td style={{ padding: "10px 16px" }}>{t.tier}</td>
                      <td style={{ padding: "10px 16px", fontWeight: 500 }}>{fmtDOP(t.total)}</td>
                      <td style={{ padding: "10px 16px", color: C.inkDim }}>{fmtDOP(t.avg)}</td>
                      <td style={{ padding: "10px 16px", color: C.inkDim }}>{t.players.toLocaleString()}</td>
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
