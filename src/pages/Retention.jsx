import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { SectionHeading, Panel, Spinner, EmptyState } from "../components/ui";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEKLY_MILESTONES = [0, 1, 2, 4, 8];
const MONTHLY_MILESTONES = [1, 2, 3];
const WEEKLY_COHORT_COUNT = 9;
const MONTHLY_COHORT_COUNT = 4;

function mondayOf(d) {
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day));
  monday.setHours(0, 0, 0, 0);
  return monday;
}
function firstOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

async function fetchCohortData(earliestDate) {
  // Fetch players registered on/after earliestDate, along with their bets' dates (left join).
  const { data, error } = await supabase
    .from("players")
    .select("id, registered_at, vip_tier, bets(bet_date)")
    .gte("registered_at", earliestDate.toISOString());
  if (error) throw error;
  return data || [];
}

function buildWeeklyCohorts(players) {
  const now = new Date();
  const thisMonday = mondayOf(now);
  const cohortMap = new Map(); // mondayISO -> players[]

  for (const p of players) {
    if (!p.registered_at) continue;
    const monday = mondayOf(new Date(p.registered_at));
    const key = monday.toISOString().slice(0, 10);
    if (!cohortMap.has(key)) cohortMap.set(key, []);
    cohortMap.get(key).push(p);
  }

  const rows = [...cohortMap.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, WEEKLY_COHORT_COUNT)
    .map(([mondayISO, players]) => {
      const monday = new Date(mondayISO);
      const weeksAgo = Math.round((thisMonday - monday) / WEEK_MS);
      const label = monday.toLocaleDateString("es-DO", { day: "numeric", month: "short" });
      const milestoneValues = {};
      for (const m of WEEKLY_MILESTONES) {
        const matured = weeksAgo >= m;
        if (!matured) { milestoneValues[`w${m}`] = null; continue; }
        const windowStart = new Date(monday.getTime() + m * WEEK_MS);
        const windowEnd = new Date(monday.getTime() + (m + 1) * WEEK_MS);
        const retainedCount = players.filter(p =>
          (p.bets || []).some(b => {
            const bd = new Date(b.bet_date);
            return bd >= windowStart && bd < windowEnd;
          })
        ).length;
        milestoneValues[`w${m}`] = players.length ? Math.round((retainedCount / players.length) * 100) : 0;
      }
      return { label, weeksAgo, pop: players.length, ...milestoneValues };
    });

  return rows.reverse(); // oldest first
}

function buildMonthlyCohorts(players) {
  const now = new Date();
  const thisMonthStart = firstOfMonth(now);
  const cohortMap = new Map();

  for (const p of players) {
    if (!p.registered_at) continue;
    const monthStart = firstOfMonth(new Date(p.registered_at));
    const key = monthStart.toISOString().slice(0, 10);
    if (!cohortMap.has(key)) cohortMap.set(key, []);
    cohortMap.get(key).push(p);
  }

  const rows = [...cohortMap.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, MONTHLY_COHORT_COUNT)
    .map(([monthISO, players]) => {
      const monthStart = new Date(monthISO);
      const monthsAgo = (thisMonthStart.getFullYear() - monthStart.getFullYear()) * 12 + (thisMonthStart.getMonth() - monthStart.getMonth());
      const label = monthStart.toLocaleDateString("es-DO", { month: "short", year: "numeric" });
      const milestoneValues = {};
      for (const m of MONTHLY_MILESTONES) {
        const matured = monthsAgo >= m;
        if (!matured) { milestoneValues[`m${m}`] = null; continue; }
        const windowStart = new Date(monthStart.getFullYear(), monthStart.getMonth() + m, 1);
        const windowEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + m + 1, 1);
        const retainedCount = players.filter(p =>
          (p.bets || []).some(b => {
            const bd = new Date(b.bet_date);
            return bd >= windowStart && bd < windowEnd;
          })
        ).length;
        milestoneValues[`m${m}`] = players.length ? Math.round((retainedCount / players.length) * 100) : 0;
      }
      return { label, monthsAgo, pop: players.length, ...milestoneValues };
    });

  return rows.reverse();
}

function buildTierRetention(players) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 4 * WEEK_MS);
  const byTier = new Map();
  for (const p of players) {
    if (!p.vip_tier || !p.registered_at) continue;
    const regDate = new Date(p.registered_at);
    if (regDate > cutoff) continue; // must be at least 4 weeks old
    if (!byTier.has(p.vip_tier)) byTier.set(p.vip_tier, []);
    byTier.get(p.vip_tier).push(p);
  }
  const rows = [];
  for (const [tier, tierPlayers] of byTier.entries()) {
    const retained = tierPlayers.filter(p => {
      const monday = mondayOf(new Date(p.registered_at));
      const windowStart = new Date(monday.getTime() + 4 * WEEK_MS);
      const windowEnd = new Date(monday.getTime() + 5 * WEEK_MS);
      return (p.bets || []).some(b => {
        const bd = new Date(b.bet_date);
        return bd >= windowStart && bd < windowEnd;
      });
    }).length;
    rows.push({ tier, retW4: tierPlayers.length ? Math.round((retained / tierPlayers.length) * 100) : 0, pop: tierPlayers.length });
  }
  return rows;
}

export default function Retention({ s, lang }) {
  const [retView, setRetView] = useState("total");
  const [retGran, setRetGran] = useState("week");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [weeklyCohorts, setWeeklyCohorts] = useState([]);
  const [monthlyCohorts, setMonthlyCohorts] = useState([]);
  const [tierRows, setTierRows] = useState([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const now = new Date();
        const earliest = new Date(now.getTime() - (WEEKLY_COHORT_COUNT + WEEKLY_MILESTONES.at(-1) + 1) * WEEK_MS);
        const players = await fetchCohortData(earliest);
        if (!active) return;
        setWeeklyCohorts(buildWeeklyCohorts(players));
        setTierRows(buildTierRetention(players));

        const earliestMonthly = new Date(now.getFullYear(), now.getMonth() - (MONTHLY_COHORT_COUNT + MONTHLY_MILESTONES.at(-1)), 1);
        const monthlyPlayers = earliestMonthly < earliest ? await fetchCohortData(earliestMonthly) : players;
        if (!active) return;
        setMonthlyCohorts(buildMonthlyCohorts(monthlyPlayers));
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, []);

  const hasWeekly = weeklyCohorts.some(r => r.pop > 0);
  const hasMonthly = monthlyCohorts.some(r => r.pop > 0);
  const hasTier = tierRows.some(r => r.pop > 0);

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <SectionHeading title={s.retTitle} subtitle={s.retSub} />
        <div style={{ display: "flex", gap: 8 }}>
          {retView === "total" && (
            <div style={{ display: "flex", background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2 }}>
              {["week", "month"].map(g => <button key={g} onClick={() => setRetGran(g)} style={{ padding: "6px 14px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 500, background: retGran === g ? "#2A303B" : "transparent", color: retGran === g ? C.ink : C.inkDim }}>{s.granToggle[g]}</button>)}
            </div>
          )}
          <div style={{ display: "flex", background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2 }}>
            {["total", "segment"].map(v => <button key={v} onClick={() => setRetView(v)} style={{ padding: "6px 14px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 500, background: retView === v ? C.accent : "transparent", color: retView === v ? "#fff" : C.inkDim }}>{v === "total" ? s.retToggle.total : s.retToggle.bySegment}</button>)}
          </div>
        </div>
      </div>

      {loading && <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>}
      {error && <Panel style={{ color: C.negative, marginTop: 12 }}>{error}</Panel>}

      {!loading && !error && retView === "total" && (
        <>
          {retGran === "week" ? (
            !hasWeekly ? <div style={{ marginTop: 12 }}><EmptyState s={s} /></div> : (
              <Panel style={{ padding: 4, overflow: "hidden", marginBottom: 12, marginTop: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr>{[lang === "es" ? "Cohorte" : "Cohort", "Sem 0", "Sem 1", "Sem 2", "Sem 4", "Sem 8"].map(h => <th key={h} style={{ padding: "12px 16px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 12 }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {weeklyCohorts.map(row => (
                      <tr key={row.label}>
                        <td style={{ padding: "10px 16px", fontWeight: 500 }}>{row.label} <span style={{ color: C.inkFaint, fontWeight: 400 }}>({row.pop})</span></td>
                        {WEEKLY_MILESTONES.map(m => {
                          const v = row[`w${m}`];
                          return <td key={m} style={{ padding: "10px 16px" }}>
                            {v == null ? <span style={{ color: C.inkFaint, fontStyle: "italic", fontSize: 12 }}>{s.maturing}</span> :
                              <span style={{ display: "inline-block", padding: "3px 9px", borderRadius: 6, background: `rgba(228,2,43,${v / 130})`, color: v > 60 ? "#fff" : C.ink, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{v}%</span>}
                          </td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )
          ) : (
            !hasMonthly ? <div style={{ marginTop: 12 }}><EmptyState s={s} /></div> : (
              <Panel style={{ padding: 4, overflow: "hidden", marginBottom: 12, marginTop: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr>{[lang === "es" ? "Cohorte" : "Cohort", "Mes +1", "Mes +2", "Mes +3"].map(h => <th key={h} style={{ padding: "12px 16px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 12 }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {monthlyCohorts.map(row => (
                      <tr key={row.label}>
                        <td style={{ padding: "10px 16px", fontWeight: 500 }}>{row.label} <span style={{ color: C.inkFaint, fontWeight: 400 }}>({row.pop})</span></td>
                        {MONTHLY_MILESTONES.map(m => {
                          const v = row[`m${m}`];
                          return <td key={m} style={{ padding: "10px 16px" }}>
                            {v == null ? <span style={{ color: C.inkFaint, fontStyle: "italic", fontSize: 12 }}>{s.maturing}</span> :
                              <span style={{ display: "inline-block", padding: "3px 9px", borderRadius: 6, background: `rgba(228,2,43,${v / 45})`, color: v > 25 ? "#fff" : C.ink, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{v}%</span>}
                          </td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )
          )}
          <p style={{ color: C.inkFaint, fontSize: 12, margin: 0 }}>{s.maturingNote}</p>
        </>
      )}

      {!loading && !error && retView === "segment" && (
        !hasTier ? <div style={{ marginTop: 12 }}><EmptyState s={s} /></div> : (
          <>
            <p style={{ color: C.inkDim, fontSize: 12.5, marginTop: 12, marginBottom: 14 }}>{s.retByTierSub}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {tierRows.map(t => (
                <div key={t.tier} style={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{ width: 130, fontWeight: 500, fontSize: 13 }}>{t.tier}</div>
                  <div style={{ flex: 1, background: "#1D222B", borderRadius: 8, height: 20 }}><div style={{ width: `${t.retW4}%`, height: "100%", borderRadius: 8, background: C.accent }} /></div>
                  <div style={{ width: 60, textAlign: "right", fontWeight: 600 }}>{t.retW4}%</div>
                </div>
              ))}
            </div>
          </>
        )
      )}
    </>
  );
}
