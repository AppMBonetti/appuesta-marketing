import { useEffect, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { Panel, Spinner } from "./ui";

// Every column of manual_daily_metrics a person can fill in, in the order the
// table renders them.
const FIELDS = [
  { key: "registrations", labelKey: "registrations", kind: "int" },
  { key: "ftds", labelKey: "ftds", kind: "int" },
  { key: "ftd_revenue", labelKey: "ftdRevenue", kind: "num" },
  { key: "deposit_count", labelKey: "depositCount", kind: "int" },
  { key: "deposit_amount", labelKey: "depositAmount", kind: "num" },
  { key: "depositors", labelKey: "depositors", kind: "int" },
  { key: "active_players", labelKey: "activePlayers", kind: "int" },
];

const todayISO = () => new Date().toISOString().slice(0, 10);

// "" and "   " mean "no correction for this metric", which is not the same as
// zero — a blank must stay null so the derived figure keeps showing through.
function parseCell(raw, kind) {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return kind === "int" ? Math.round(n) : n;
}

/**
 * Per-day overrides for the figures a source report gets wrong.
 *
 * Entered by day rather than by week so one bad day never forces restating a
 * whole month, and so the same entries roll up correctly whether the dashboard
 * is showing a week, a month or a custom span.
 */
export default function ManualCorrections({ s, lang }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    const { data, error: err } = await supabase
      .from("manual_daily_metrics").select("*").order("date", { ascending: false });
    if (err) setError(err.message);
    else setRows((data || []).map(r => ({ ...r, _saved: true })));
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function updateCell(date, key, value) {
    setRows(prev => prev.map(r => (r.date === date ? { ...r, [key]: value, _saved: false } : r)));
  }

  function addRow() {
    setError(null);
    let date = todayISO();
    // Stepping back a day at a time keeps the new row from colliding with one
    // already on screen — date is the primary key.
    const taken = new Set(rows.map(r => r.date));
    while (taken.has(date)) {
      date = new Date(new Date(date).getTime() - 86400000).toISOString().slice(0, 10);
    }
    setRows(prev => [{ date, note: "", _saved: false }, ...prev]);
  }

  async function removeRow(date) {
    setError(null);
    const row = rows.find(r => r.date === date);
    if (row?._saved) {
      const { error: err } = await supabase.from("manual_daily_metrics").delete().eq("date", date);
      if (err) { setError(err.message); return; }
    }
    setRows(prev => prev.filter(r => r.date !== date));
  }

  async function save() {
    setSaving(true);
    setError(null);
    const payload = rows.map(r => {
      const out = { date: r.date, note: r.note || null, updated_at: new Date().toISOString() };
      for (const f of FIELDS) out[f.key] = parseCell(r[f.key], f.kind);
      return out;
    });
    const { error: err } = await supabase
      .from("manual_daily_metrics").upsert(payload, { onConflict: "date" });
    setSaving(false);
    if (err) { setError(err.message); return; }
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1800);
    load();
  }

  const th = { padding: "9px 10px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11, whiteSpace: "nowrap" };
  const input = { width: "100%", minWidth: 74, background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 7, color: C.ink, padding: "6px 8px", fontSize: 12, fontVariantNumeric: "tabular-nums" };

  if (loading) return <Panel style={{ marginBottom: 22 }}><Spinner size={18} /></Panel>;

  return (
    <>
      <div style={{ fontSize: 12, color: C.inkFaint, marginBottom: 12, lineHeight: 1.5, maxWidth: 720 }}>
        {s.manual.sub}
      </div>

      {error && <Panel style={{ color: C.negative, marginBottom: 14, fontSize: 12.5 }}>{error}</Panel>}

      {rows.length === 0 ? (
        <Panel style={{ padding: "26px 24px", color: C.inkDim, fontSize: 12.5, marginBottom: 14 }}>
          {s.manual.empty}
        </Panel>
      ) : (
        <Panel style={{ padding: 4, overflowX: "auto", marginBottom: 14 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={th}>{s.manual.date}</th>
                {FIELDS.map(f => <th key={f.key} style={th}>{s.manual[f.labelKey]}</th>)}
                <th style={th}>{s.manual.note}</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.date} style={{ borderTop: `1px solid ${C.panelBorder}` }}>
                  <td style={{ padding: "6px 10px" }}>
                    <input
                      type="date" value={r.date}
                      onChange={e => {
                        const next = e.target.value;
                        if (!next || rows.some(x => x.date === next)) return;
                        setRows(prev => prev.map(x => (x.date === r.date ? { ...x, date: next, _saved: false } : x)));
                      }}
                      style={{ ...input, minWidth: 130 }}
                    />
                  </td>
                  {FIELDS.map(f => (
                    <td key={f.key} style={{ padding: "6px 10px" }}>
                      <input
                        inputMode="decimal" value={r[f.key] ?? ""}
                        onChange={e => updateCell(r.date, f.key, e.target.value)}
                        style={input}
                      />
                    </td>
                  ))}
                  <td style={{ padding: "6px 10px" }}>
                    <input
                      value={r.note ?? ""} onChange={e => updateCell(r.date, "note", e.target.value)}
                      style={{ ...input, minWidth: 150 }}
                    />
                  </td>
                  <td style={{ padding: "6px 10px" }}>
                    <button
                      onClick={() => removeRow(r.date)}
                      title={s.manual.remove}
                      style={{ background: "transparent", border: "none", color: C.inkFaint, cursor: "pointer", padding: 4, display: "flex" }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
        <button onClick={addRow}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 15px", borderRadius: 9, border: `1px solid ${C.panelBorder}`, background: "#1D222B", color: C.ink, fontSize: 12.5, cursor: "pointer" }}>
          <Plus size={14} /> {s.manual.add}
        </button>
        <button onClick={save} disabled={saving || !rows.length}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 17px", borderRadius: 9, border: "none", background: savedFlash ? C.positive : C.accent, color: "#fff", fontSize: 12.5, fontWeight: 500, cursor: saving || !rows.length ? "default" : "pointer", opacity: saving || !rows.length ? 0.6 : 1 }}>
          {saving ? <Spinner /> : savedFlash ? <Check size={14} /> : null}
          {savedFlash ? s.manual.saved : s.manual.save}
        </button>
      </div>

      <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 12, lineHeight: 1.5, maxWidth: 720 }}>
        {lang === "es"
          ? "Cada métrica es independiente: si solo llenas registros, los FTDs siguen viniendo de InTarget. Las celdas corregidas aparecen marcadas en el reporte semanal."
          : "Each metric is independent: fill in only registrations and FTDs keep coming from InTarget. Corrected cells are badged in the weekly report."}
      </div>
    </>
  );
}
