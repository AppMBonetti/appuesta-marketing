import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { SectionHeading, Panel, Spinner } from "../components/ui";

const GOAL_DEFS = [
  { key: "new_registrations", nameEs: "Nuevos registros", nameEn: "New registrations" },
  { key: "ftd_count", nameEs: "FTDs", nameEn: "FTDs" },
  { key: "retention_30d", nameEs: "Retención 30d (%)", nameEn: "30d retention (%)" },
  { key: "cac_ltv_target", nameEs: "CAC : LTV (meta ≥)", nameEn: "CAC : LTV (target ≥)" },
];

function monthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}

export default function Settings({ s, lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [goals, setGoals] = useState({});
  const [savedFlash, setSavedFlash] = useState(false);
  const [saving, setSaving] = useState(false);
  const period_start = monthStart();

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("goals")
        .select("*")
        .eq("period_start", period_start)
        .eq("period_type", "month");
      if (!active) return;
      if (error) setError(error.message);
      else {
        const byKey = {};
        for (const row of data || []) byKey[row.metric_name] = row.target_value;
        setGoals(byKey);
      }
      setLoading(false);
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateGoal(key, value) {
    setGoals(prev => ({ ...prev, [key]: value === "" ? "" : Number(value) }));
  }

  async function saveAll() {
    setSaving(true);
    setError(null);
    const rows = GOAL_DEFS.map(g => ({
      period_start, period_type: "month", metric_name: g.key,
      target_value: goals[g.key] === "" || goals[g.key] == null ? 0 : goals[g.key],
    }));
    const { error } = await supabase.from("goals").upsert(rows, { onConflict: "period_start,period_type,metric_name" });
    setSaving(false);
    if (error) { setError(error.message); return; }
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1400);
  }

  return (
    <>
      <SectionHeading title={s.settingsTitle} subtitle={s.settingsSub} />
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: C.inkDim }}>{s.settingsGoals}</div>

      {error && <Panel style={{ color: C.negative, marginBottom: 16 }}>{error}</Panel>}
      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 40 }}><Spinner size={22} /></div>
      ) : (
        <>
          <Panel style={{ marginBottom: 20, display: "flex", flexDirection: "column", gap: 12 }}>
            {GOAL_DEFS.map(g => (
              <div key={g.key} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 220, fontSize: 13 }}>{lang === "es" ? g.nameEs : g.nameEn}</div>
                <input type="number" value={goals[g.key] ?? ""} onChange={e => updateGoal(g.key, e.target.value)} style={{ background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 8, color: C.ink, padding: "8px 10px", width: 140, fontSize: 13 }} />
              </div>
            ))}
          </Panel>
          <button onClick={saveAll} disabled={saving} style={{ padding: "9px 18px", borderRadius: 9, border: "none", cursor: saving ? "default" : "pointer", background: savedFlash ? C.positive : C.accent, color: "#fff", fontSize: 13, fontWeight: 500, opacity: saving ? 0.7 : 1 }}>
            {savedFlash ? s.saved : s.save}
          </button>
        </>
      )}
    </>
  );
}
