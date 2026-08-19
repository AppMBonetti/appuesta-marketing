import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { weeksInMonth, currentBudgetMonth, formatMonth } from "../lib/period";
import { deriveWeeklyKpis } from "../lib/metrics";
import { SectionHeading, Panel, fmtDOP } from "./ui";

// Cost goals are met by coming in UNDER them, so both the comparison and the
// pace calculation invert. Treating them like volume goals would show a cheap
// CPA as failure.
const TRACKED = [
  { key: "new_registrations", metric: "registrations", money: false },
  { key: "ftd_count", metric: "ftds", money: false },
  { key: "ggr_target", metric: "ggr", money: true },
  { key: "deposit_target", metric: "depositAmount", money: true },
  { key: "monthly_budget", metric: "spend", money: true, lowerIsBetter: true },
  { key: "cpl_target", metric: "costPerRegistration", money: true, lowerIsBetter: true, rate: true },
  { key: "cpa_target", metric: "costPerAcquisition", money: true, lowerIsBetter: true, rate: true },
];

/** Fraction of the month already elapsed, used to judge whether pace is on track. */
function monthElapsed(month) {
  const [y, m] = month.split("-").map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1);
  const now = Date.now();
  if (now <= start) return 0;
  if (now >= end) return 1;
  return (now - start) / (end - start);
}

export default function GoalTracker({ s, lang, month = currentBudgetMonth() }) {
  const [goals, setGoals] = useState({});
  const [rows, setRows] = useState([]);

  useEffect(() => {
    let active = true;
    (async () => {
      const [g, w] = await Promise.all([
        supabase.from("goals").select("metric_name, target_value")
          .eq("period_start", month).eq("period_type", "month"),
        supabase.from("weekly_kpis").select("*"),
      ]);
      if (!active) return;
      setGoals(Object.fromEntries((g.data || []).map(r => [r.metric_name, Number(r.target_value)])));
      setRows(w.data || []);
    })();
    return () => { active = false; };
  }, [month]);

  const weeks = new Set(weeksInMonth(month));
  const inMonth = rows.filter(r => weeks.has(r.week_start)).map(deriveWeeklyKpis);
  const sum = key => inMonth.reduce((total, w) => total + (w[key] ?? 0), 0);

  const spend = sum("spend");
  const registrations = sum("registrations");
  const ftds = sum("ftds");
  const actualFor = {
    registrations, ftds, spend,
    ggr: sum("ggr"),
    depositAmount: sum("depositAmount"),
    costPerRegistration: registrations > 0 ? spend / registrations : null,
    costPerAcquisition: ftds > 0 ? spend / ftds : null,
  };

  const elapsed = monthElapsed(month);
  const tracked = TRACKED.filter(t => goals[t.key] > 0);

  if (tracked.length === 0) {
    return (
      <>
        <SectionHeading title={s.goalTrack.title} subtitle={s.goalTrack.sub} />
        <Panel style={{ color: C.inkDim, fontSize: 12.5, marginBottom: 24 }}>{s.goalTrack.none}</Panel>
      </>
    );
  }

  return (
    <>
      <SectionHeading
        title={s.goalTrack.title}
        subtitle={`${formatMonth(month, lang)} · ${(elapsed * 100).toFixed(0)}% ${s.goalTrack.ofMonth}`}
      />
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 26 }}>
        {tracked.map(t => {
          const target = goals[t.key];
          const actual = actualFor[t.metric];
          const fmt = v => (v == null ? "—" : t.money ? fmtDOP(v) : Math.round(v).toLocaleString());

          // Volume goals accumulate through the month, so they are judged
          // against elapsed time. A rate is a level, not a total, and is simply
          // compared with its target.
          let pct = null;
          let good = null;
          if (actual != null && target > 0) {
            if (t.rate) {
              pct = (target / actual) * 100;
              good = actual <= target;
            } else if (t.lowerIsBetter) {
              pct = (actual / target) * 100;
              good = actual <= target * Math.max(elapsed, 0.01);
            } else {
              pct = (actual / target) * 100;
              good = actual >= target * elapsed;
            }
          }

          return (
            <div key={t.key} style={{
              background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 14,
              padding: "14px 16px", flex: "1 1 210px", minWidth: 210,
            }}>
              <div style={{ fontSize: 11.5, color: C.inkDim, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 8 }}>
                {s.cfg.goals[t.key]}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 7, marginBottom: 9 }}>
                <span style={{ fontSize: 19, fontWeight: 600, fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(actual)}</span>
                <span style={{ fontSize: 12, color: C.inkFaint }}>/ {fmt(target)}</span>
              </div>
              <div style={{ background: "#1D222B", borderRadius: 6, height: 7, overflow: "hidden", marginBottom: 7 }}>
                <div style={{ width: `${Math.min(pct ?? 0, 100)}%`, height: "100%", borderRadius: 6, background: good == null ? C.inkFaint : good ? C.positive : C.negative }} />
              </div>
              <div style={{ fontSize: 11.5, color: good == null ? C.inkFaint : good ? C.positive : C.negative }}>
                {pct == null ? "—" : `${pct.toFixed(0)}% · ${good ? (t.rate || t.lowerIsBetter ? s.goalTrack.onPace : s.goalTrack.ahead) : s.goalTrack.behind}`}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
