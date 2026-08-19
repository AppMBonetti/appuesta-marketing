import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { formatWeek, formatMonth } from "../lib/period";
import { SectionHeading, Panel, Spinner, EmptyState } from "../components/ui";

const WEEK_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8];
const MONTH_INDEXES = [1, 2, 3];

/** Heat scale for a retention percentage; immature cells never get a colour. */
function cellStyle(pct, mature) {
  if (!mature) {
    return { background: "#171B22", color: C.inkFaint, border: `1px dashed ${C.panelBorder}` };
  }
  const value = Number(pct) || 0;
  if (value === 0) return { background: "#161A21", color: C.inkFaint, border: `1px solid ${C.panelBorder}` };
  // 0-100% mapped onto the accent, floored so a low-but-real value stays visible.
  const alpha = 0.14 + Math.min(value, 100) / 100 * 0.66;
  return {
    background: `rgba(228, 2, 43, ${alpha.toFixed(3)})`,
    color: value > 45 ? "#fff" : C.ink,
    border: `1px solid ${C.panelBorder}`,
  };
}

function Grid({ rows, indexes, keyField, labelFor, indexLabel, s }) {
  const th = { padding: "9px 12px", fontSize: 11.5, color: C.inkDim, fontWeight: 500, whiteSpace: "nowrap" };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "separate", borderSpacing: 3, minWidth: 560 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>{s.ret.cohort}</th>
            <th style={{ ...th, textAlign: "right" }}>{s.ret.players}</th>
            {indexes.map(i => <th key={i} style={th}>{indexLabel} {i}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row[keyField]}>
              <td style={{ padding: "8px 12px", fontSize: 12.5, whiteSpace: "nowrap", color: C.ink }}>{labelFor(row[keyField])}</td>
              <td style={{ padding: "8px 12px", fontSize: 12.5, textAlign: "right", color: C.inkDim }}>{row.players}</td>
              {indexes.map(i => {
                const cell = row.cells[i];
                const style = cellStyle(cell?.pct, cell?.mature);
                return (
                  <td key={i} style={{
                    ...style, padding: "8px 10px", fontSize: 12, textAlign: "center",
                    borderRadius: 7, minWidth: 54, fontVariantNumeric: "tabular-nums",
                  }}
                  title={cell?.mature ? `${cell.retained} / ${row.players}` : s.maturing}>
                    {cell?.mature ? `${Number(cell.pct).toFixed(0)}%` : "·"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Collapses the flat (cohort, index) rows the view returns into one row per cohort. */
function pivot(flatRows, keyField, indexField) {
  const byCohort = new Map();
  for (const row of flatRows) {
    const key = row[keyField];
    if (!byCohort.has(key)) byCohort.set(key, { [keyField]: key, players: row.players, cells: {} });
    byCohort.get(key).cells[row[indexField]] = {
      pct: row.pct, retained: row.retained, mature: row.mature,
    };
  }
  return [...byCohort.values()].sort((a, b) => String(a[keyField]).localeCompare(String(b[keyField])));
}

export default function Retention({ s, lang }) {
  const [view, setView] = useState("total");
  const [granularity, setGranularity] = useState("week");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [weekly, setWeekly] = useState([]);
  const [monthly, setMonthly] = useState([]);
  const [byTier, setByTier] = useState([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      const [w, m, t] = await Promise.all([
        supabase.from("cohort_retention_weekly").select("*").order("cohort_week"),
        supabase.from("cohort_retention_monthly").select("*").order("cohort_month"),
        supabase.from("cohort_retention_by_tier").select("*").order("tier_order"),
      ]);
      if (!active) return;
      const failure = w.error || m.error || t.error;
      if (failure) setError(failure.message);
      setWeekly(pivot(w.data || [], "cohort_week", "week_index"));
      setMonthly(pivot(m.data || [], "cohort_month", "month_index"));
      setByTier(t.data || []);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  const hasWeekly = weekly.some(r => r.players > 0);
  const hasMonthly = monthly.some(r => r.players > 0);
  const matureTiers = byTier.filter(r => r.players > 0);
  const note = { color: C.inkFaint, fontSize: 11.5, lineHeight: 1.6, margin: "10px 0 0", maxWidth: 760 };

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <SectionHeading title={s.retTitle} subtitle={`${s.retSub} · ${s.ret.anchored}`} />
        <div style={{ display: "flex", gap: 8 }}>
          {view === "total" && (
            <div style={{ display: "flex", background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2 }}>
              {["week", "month"].map(g => (
                <button key={g} onClick={() => setGranularity(g)} style={{ padding: "6px 14px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 500, background: granularity === g ? "#2A303B" : "transparent", color: granularity === g ? C.ink : C.inkDim }}>{s.granToggle[g]}</button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2 }}>
            {["total", "segment"].map(v => (
              <button key={v} onClick={() => setView(v)} style={{ padding: "6px 14px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 500, background: view === v ? C.accent : "transparent", color: view === v ? "#fff" : C.inkDim }}>{v === "total" ? s.retToggle.total : s.retToggle.bySegment}</button>
            ))}
          </div>
        </div>
      </div>

      {loading && <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>}
      {error && <Panel style={{ color: C.negative, marginTop: 12 }}>{error}</Panel>}

      {!loading && !error && view === "total" && (
        granularity === "week" ? (
          !hasWeekly ? <EmptyState s={s} /> : (
            <Panel>
              <Grid rows={weekly} indexes={WEEK_INDEXES} keyField="cohort_week"
                labelFor={v => formatWeek(v, lang)} indexLabel={s.ret.week} s={s} />
              <p style={note}>{s.ret.activityNote}</p>
              <p style={note}>{s.ret.maturingNote}</p>
            </Panel>
          )
        ) : (
          !hasMonthly ? <EmptyState s={s} /> : (
            <Panel>
              <Grid rows={monthly} indexes={MONTH_INDEXES} keyField="cohort_month"
                labelFor={v => formatMonth(v, lang)} indexLabel={s.ret.month} s={s} />
              <p style={note}>{s.ret.activityNote}</p>
              <p style={note}>{s.ret.maturingNote}</p>
            </Panel>
          )
        )
      )}

      {!loading && !error && view === "segment" && (
        <>
          <SectionHeading title={s.retByTierSub} />
          {matureTiers.length === 0 ? (
            <Panel style={{ color: C.inkDim, fontSize: 12.5 }}>{s.ret.noMature}</Panel>
          ) : (
            <Panel style={{ padding: 4, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr>{[s.vipCols.tier, s.ret.players, s.retByTierSub].map(h => (
                  <th key={h} style={{ padding: "11px 16px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 12 }}>{h}</th>
                ))}</tr></thead>
                <tbody>
                  {matureTiers.map(row => (
                    <tr key={row.tier_name}>
                      <td style={{ padding: "10px 16px", fontWeight: 500 }}>{row.tier_name}</td>
                      <td style={{ padding: "10px 16px", color: C.inkDim }}>{row.players}</td>
                      <td style={{ padding: "10px 16px" }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 10, maxWidth: 320 }}>
                          <span style={{ flex: 1, background: "#1D222B", borderRadius: 6, height: 8 }}>
                            <span style={{ display: "block", width: `${Number(row.pct) || 0}%`, height: "100%", borderRadius: 6, background: C.accent }} />
                          </span>
                          <strong>{row.pct == null ? "—" : `${Number(row.pct).toFixed(0)}%`}</strong>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
          <p style={note}>{s.ret.tierNote}</p>
        </>
      )}
    </>
  );
}
