import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { monthOptions, currentBudgetMonth, formatMonth, weeksInMonth } from "../lib/period";
import { deriveWeeklyKpis } from "../lib/metrics";
import { SectionHeading, Panel, Spinner, fmtDOP } from "../components/ui";
import ManualCorrections from "../components/ManualCorrections";

// `lowerIsBetter` flips how attainment reads: hitting a CPA goal means coming in
// under it, so 100% there is not the same shape as 100% of a registrations goal.
const GOAL_DEFS = [
  { key: "monthly_budget", money: true, group: "budget" },
  { key: "new_registrations", money: false, group: "goals" },
  { key: "ftd_count", money: false, group: "goals" },
  { key: "cpl_target", money: true, lowerIsBetter: true, group: "goals" },
  { key: "cpa_target", money: true, lowerIsBetter: true, group: "goals" },
  { key: "deposit_target", money: true, group: "goals" },
  { key: "ggr_target", money: true, group: "goals" },
];

/** Month-to-date actuals, summed from the weeks whose Monday falls in the month. */
function actualsFor(month, weeklyRows) {
  const weeks = new Set(weeksInMonth(month));
  const inMonth = weeklyRows.filter(r => weeks.has(r.week_start)).map(deriveWeeklyKpis);
  const sum = key => inMonth.reduce((total, w) => total + (w[key] ?? 0), 0);
  const spend = sum("spend");
  const registrations = sum("registrations");
  const ftds = sum("ftds");
  return {
    monthly_budget: spend,
    new_registrations: registrations,
    ftd_count: ftds,
    cpl_target: registrations > 0 ? spend / registrations : null,
    cpa_target: ftds > 0 ? spend / ftds : null,
    deposit_target: sum("depositAmount"),
    ggr_target: sum("ggr"),
  };
}

export default function Settings({ s, lang }) {
  const [month, setMonth] = useState(currentBudgetMonth());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [goals, setGoals] = useState({});
  const [weeklyRows, setWeeklyRows] = useState([]);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [minDeposit, setMinDeposit] = useState("");
  const [minDepositSaving, setMinDepositSaving] = useState(false);
  const [minDepositSaved, setMinDepositSaved] = useState(false);
  const [excludedByFloor, setExcludedByFloor] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const [setting, health] = await Promise.all([
        supabase.from("app_settings").select("value").eq("key", "min_qualifying_deposit").maybeSingle(),
        supabase.from("dashboard_health").select("ftd_below_floor").maybeSingle(),
      ]);
      if (!active) return;
      if (setting.data?.value != null) setMinDeposit(String(setting.data.value));
      if (health.data) setExcludedByFloor(health.data.ftd_below_floor);
    })();
    return () => { active = false; };
  }, []);

  async function saveMinDeposit() {
    setMinDepositSaving(true);
    const value = String(Number(minDeposit) || 0);
    const { error: err } = await supabase.from("app_settings").upsert(
      { key: "min_qualifying_deposit", value, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    setMinDepositSaving(false);
    if (err) { setError(err.message); return; }
    setMinDepositSaved(true);
    setTimeout(() => setMinDepositSaved(false), 1800);
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      const [goalsRes, weeklyRes] = await Promise.all([
        supabase.from("goals").select("*").eq("period_start", month).eq("period_type", "month"),
        supabase.from("weekly_kpis").select("*"),
      ]);
      if (!active) return;
      if (goalsRes.error) setError(goalsRes.error.message);
      else {
        const byKey = {};
        for (const row of goalsRes.data || []) byKey[row.metric_name] = row.target_value;
        setGoals(byKey);
      }
      if (!weeklyRes.error) setWeeklyRows(weeklyRes.data || []);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [month]);

  async function saveAll() {
    setSaving(true);
    setError(null);
    const rows = GOAL_DEFS
      .filter(g => goals[g.key] !== "" && goals[g.key] != null)
      .map(g => ({
        period_start: month, period_type: "month", metric_name: g.key,
        target_value: Number(goals[g.key]) || 0,
      }));
    if (rows.length) {
      const { error: err } = await supabase.from("goals")
        .upsert(rows, { onConflict: "period_start,period_type,metric_name" });
      if (err) { setError(err.message); setSaving(false); return; }
    }
    setSaving(false);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2200);
  }

  const actuals = actualsFor(month, weeklyRows);
  const input = { background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 8, color: C.ink, padding: "8px 10px", width: 150, fontSize: 13 };
  const th = { padding: "11px 16px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 12 };
  const td = { padding: "9px 16px", fontSize: 13 };

  function attainment(def) {
    const target = Number(goals[def.key]);
    const actual = actuals[def.key];
    if (!target || actual == null) return null;
    // Under target is the win for cost metrics, over it for volume metrics.
    const pct = def.lowerIsBetter ? (target / actual) * 100 : (actual / target) * 100;
    return { pct, good: def.lowerIsBetter ? actual <= target : actual >= target };
  }

  function renderRows(group) {
    return GOAL_DEFS.filter(g => g.group === group).map(def => {
      const att = attainment(def);
      const actual = actuals[def.key];
      return (
        <tr key={def.key}>
          <td style={{ ...td, fontWeight: 500 }}>
            {s.cfg.goals[def.key]}
            {def.lowerIsBetter && <span style={{ color: C.inkFaint, fontSize: 11, marginLeft: 6 }}>({s.cfg.lowerIsBetter})</span>}
          </td>
          <td style={{ ...td, padding: "7px 16px" }}>
            <input
              type="number"
              value={goals[def.key] ?? ""}
              onChange={e => setGoals(prev => ({ ...prev, [def.key]: e.target.value }))}
              style={input}
            />
          </td>
          <td style={{ ...td, color: C.inkDim }}>
            {actual == null || actual === 0 ? s.cfg.noActual : (def.money ? fmtDOP(actual) : Math.round(actual).toLocaleString())}
          </td>
          <td style={td}>
            {att == null ? <span style={{ color: C.inkFaint }}>—</span> : (
              <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 150 }}>
                <span style={{ flex: 1, background: "#1D222B", borderRadius: 6, height: 7, minWidth: 60 }}>
                  <span style={{ display: "block", width: `${Math.min(att.pct, 100)}%`, height: "100%", borderRadius: 6, background: att.good ? C.positive : C.negative }} />
                </span>
                <span style={{ color: att.good ? C.positive : C.negative, fontSize: 12 }}>{att.pct.toFixed(0)}%</span>
              </span>
            )}
          </td>
        </tr>
      );
    });
  }

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>;

  return (
    <>
      <SectionHeading title={s.settingsTitle} subtitle={s.cfg.goalsSub} />
      {error && <Panel style={{ color: C.negative, marginBottom: 16 }}>{error}</Panel>}

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, color: C.inkDim }}>{s.cfg.month}</span>
        <select value={month} onChange={e => setMonth(e.target.value)}
          style={{ background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 8, color: C.ink, padding: "7px 10px", fontSize: 12.5, textTransform: "capitalize" }}>
          {monthOptions().map(m => <option key={m} value={m}>{formatMonth(m, lang)}</option>)}
        </select>
      </div>

      <SectionHeading title={s.cfg.budgetTitle} subtitle={s.cfg.budgetSub} />
      <Panel style={{ padding: 4, overflow: "auto", marginBottom: 26 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["", s.cfg.target, s.cfg.actual, s.cfg.attainment].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
          <tbody>{renderRows("budget")}</tbody>
        </table>
      </Panel>

      <SectionHeading title={s.cfg.goalsTitle} />
      <Panel style={{ padding: 4, overflow: "auto", marginBottom: 18 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["", s.cfg.target, s.cfg.actual, s.cfg.attainment].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
          <tbody>{renderRows("goals")}</tbody>
        </table>
      </Panel>

      <button onClick={saveAll} disabled={saving}
        style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 18px", borderRadius: 9, border: "none", background: savedFlash ? C.positive : C.accent, color: "#fff", fontSize: 13, fontWeight: 500, cursor: saving ? "default" : "pointer", opacity: saving ? 0.7 : 1 }}>
        {saving ? <Spinner /> : savedFlash ? <Check size={14} /> : null}
        {savedFlash ? s.cfg.saved : s.cfg.saveAll}
      </button>

      <div style={{ marginTop: 34 }}>
        <SectionHeading title={s.minDeposit.title} subtitle={s.minDeposit.sub} />
        <Panel style={{ marginBottom: 26 }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
            <div>
              <label htmlFor="min-deposit" style={{ display: "block", fontSize: 11.5, color: C.inkDim, marginBottom: 5 }}>
                {s.minDeposit.label}
              </label>
              <input
                id="min-deposit" inputMode="decimal" value={minDeposit}
                onChange={e => setMinDeposit(e.target.value)}
                style={{ width: 140, background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 8, color: C.ink, padding: "7px 10px", fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}
              />
            </div>
            <button onClick={saveMinDeposit} disabled={minDepositSaving}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 16px", borderRadius: 9, border: "none", background: minDepositSaved ? C.positive : C.accent, color: "#fff", fontSize: 12.5, fontWeight: 500, cursor: minDepositSaving ? "default" : "pointer", opacity: minDepositSaving ? 0.7 : 1 }}>
              {minDepositSaving ? <Spinner /> : minDepositSaved ? <Check size={14} /> : null}
              {minDepositSaved ? s.cfg.saved : s.cfg.saveAll}
            </button>
            {excludedByFloor != null && (
              <span style={{ fontSize: 12, color: C.inkDim, paddingBottom: 8 }}>
                {s.minDeposit.excluded.replace("{n}", Number(excludedByFloor).toLocaleString())}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 12, lineHeight: 1.5, maxWidth: 720 }}>
            {s.minDeposit.caveat}
          </div>
        </Panel>

        <SectionHeading title={s.manual.title} />
        <ManualCorrections s={s} lang={lang} />
      </div>
    </>
  );
}
