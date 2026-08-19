import { useEffect, useState } from "react";
import { X, Download } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { addDays, formatWeek } from "../lib/period";
import { downloadCsv } from "../lib/csv";
import { Spinner, fmtDOP } from "./ui";

// Only metrics whose members are individually identifiable are drillable.
// Deposit counts come from snapshot deltas rather than per-deposit rows, so
// there is no list of players to show behind them and those cells stay inert.
export const DRILLABLE = {
  registrations: { column: "registered_at", titleKey: "registrations" },
  ftds: { column: "first_deposit_date", titleKey: "ftds" },
};

const CSV_COLUMNS = [
  { label: "player_id", value: p => p.id },
  { label: "name", value: p => p.name },
  { label: "email", value: p => p.email },
  { label: "vip_tier", value: p => p.vip_tier },
  { label: "registered_at", value: p => p.registered_at },
  { label: "first_deposit_date", value: p => p.first_deposit_date },
  { label: "first_deposit_amount_dop", value: p => p.first_deposit_amount },
  { label: "total_deposit_amount_dop", value: p => p.total_deposit_amount },
  { label: "total_deposit_count", value: p => p.total_deposit_count },
  { label: "total_ggr_dop", value: p => p.total_ggr_sportsbook },
];

export default function PlayerDrill({ s, lang, metric, week, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const spec = DRILLABLE[metric];

  useEffect(() => {
    if (!spec || !week) return undefined;
    let active = true;
    setLoading(true);
    (async () => {
      const { data, error: err } = await supabase
        .from("players")
        .select("id, name, email, vip_tier, registered_at, first_deposit_date, first_deposit_amount, total_deposit_amount, total_deposit_count, total_ggr_sportsbook")
        .gte(spec.column, week)
        .lt(spec.column, addDays(week, 7))
        .order(spec.column);
      if (!active) return;
      if (err) setError(err.message);
      setRows(data || []);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [metric, week, spec]);

  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!spec) return null;

  const th = { padding: "9px 12px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" };
  const td = { padding: "8px 12px", fontSize: 12.5, whiteSpace: "nowrap" };
  const date = v => (v ? String(v).slice(0, 10) : "—");

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(8,10,14,0.72)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 14, width: "min(1000px, 100%)", maxHeight: "84vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 18px", borderBottom: `1px solid ${C.panelBorder}` }}>
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 600 }}>{s.drill[spec.titleKey]}</div>
            <div style={{ fontSize: 12, color: C.inkDim, marginTop: 2 }}>
              {formatWeek(week, lang)} – {formatWeek(addDays(week, 6), lang)} · {rows.length}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {rows.length > 0 && (
              <button
                onClick={() => downloadCsv(`appuesta-${metric}-${week}.csv`, CSV_COLUMNS, rows)}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: "#1D222B", color: C.ink, fontSize: 12.5, cursor: "pointer" }}
              ><Download size={13} /> {s.drill.export}</button>
            )}
            <button onClick={onClose} aria-label={s.drill.close}
              style={{ display: "inline-flex", alignItems: "center", padding: 7, borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: "transparent", color: C.inkDim, cursor: "pointer" }}>
              <X size={15} />
            </button>
          </div>
        </div>

        <div style={{ overflow: "auto", padding: 4 }}>
          {loading ? <div style={{ display: "flex", justifyContent: "center", padding: 40 }}><Spinner size={20} /></div>
            : error ? <div style={{ padding: 20, color: C.negative, fontSize: 12.5 }}>{error}</div>
            : rows.length === 0 ? <div style={{ padding: 20, color: C.inkDim, fontSize: 12.5 }}>{s.drill.none}</div>
            : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {[s.drill.cols.player, s.drill.cols.email, s.drill.cols.tier, s.drill.cols.registered,
                      s.drill.cols.ftdDate, s.drill.cols.ftdAmount, s.drill.cols.deposits,
                      s.drill.cols.count, s.drill.cols.ggr].map(h => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(p => (
                    <tr key={p.id}>
                      <td style={{ ...td, fontWeight: 500 }}>{p.name || p.id}</td>
                      <td style={{ ...td, color: C.inkDim }}>{p.email || "—"}</td>
                      <td style={{ ...td, color: C.inkDim }}>{p.vip_tier || "—"}</td>
                      <td style={{ ...td, color: C.inkDim }}>{date(p.registered_at)}</td>
                      <td style={{ ...td, color: C.inkDim }}>{date(p.first_deposit_date)}</td>
                      <td style={td}>
                        {p.first_deposit_amount == null
                          ? <span style={{ color: C.inkFaint }}>{s.drill.unknownAmount}</span>
                          : fmtDOP(p.first_deposit_amount)}
                      </td>
                      <td style={td}>{fmtDOP(p.total_deposit_amount)}</td>
                      <td style={{ ...td, color: C.inkDim }}>{p.total_deposit_count ?? 0}</td>
                      <td style={td}>{fmtDOP(p.total_ggr_sportsbook)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      </div>
    </div>
  );
}
