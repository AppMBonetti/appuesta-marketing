import { Fragment, useState } from "react";
import { C } from "../lib/theme";
import { weekRangeLabel, previousWeek } from "../lib/period";
import { WEEKLY_KPI_GROUPS, wowChange } from "../lib/metrics";
import { fmtMoney } from "../lib/currency";
import { Spinner } from "./ui";
import PlayerDrill, { DRILLABLE } from "./PlayerDrill";

function formatValue(value, format) {
  if (value == null || Number.isNaN(value)) return "—";
  switch (format) {
    case "money":
      return fmtMoney(value);
    case "money2":
      return fmtMoney(value, { decimals: 2 });
    case "pct":
      return `${(Number(value) * 100).toFixed(2)}%`;
    case "x":
      return `${Number(value).toFixed(2)}x`;
    default:
      return Number(value).toLocaleString();
  }
}

// Mirrors the spreadsheet's red/green wash. `better` decides which sign is good,
// so a falling cost per acquisition reads as an improvement rather than a loss.
function deltaStyle(change, better) {
  if (change == null || better == null) return { color: C.inkFaint, background: "transparent" };
  const good = better === "up" ? change >= 0 : change <= 0;
  return {
    color: good ? C.positive : C.negative,
    background: good ? "rgba(62, 203, 158, 0.10)" : "rgba(242, 153, 74, 0.10)",
  };
}

export default function WeeklyKpiGrid({ s, lang, weeks, rowsByWeek, onEditSpend, savingWeek }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState("");
  const [drill, setDrill] = useState(null);

  const labelCell = {
    position: "sticky", left: 0, zIndex: 2, background: C.panel,
    padding: "9px 14px", fontSize: 12.5, whiteSpace: "nowrap",
    borderRight: `1px solid ${C.panelBorder}`,
  };
  const headCell = {
    padding: "8px 12px", fontSize: 11.5, fontWeight: 600, color: C.inkDim,
    textAlign: "right", whiteSpace: "nowrap",
  };

  function commitSpend(week) {
    const raw = draft.trim();
    setEditing(null);
    if (raw === "") return;
    const value = Number(raw.replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(value)) return;
    onEditSpend(week, value);
  }

  return (
    <>
    {drill && (
      <PlayerDrill s={s} lang={lang} metric={drill.metric} week={drill.week} onClose={() => setDrill(null)} />
    )}
    <div style={{ overflowX: "auto", border: `1px solid ${C.panelBorder}`, borderRadius: 14, background: C.panel }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 620 }}>
        <thead>
          <tr>
            <th style={{ ...labelCell, ...headCell, textAlign: "left", zIndex: 3, color: C.inkDim }}>{s.wk.kpi}</th>
            {weeks.map(week => (
              <th key={week} colSpan={2} style={{ ...headCell, textAlign: "center", borderLeft: `1px solid ${C.panelBorder}` }}>
                {weekRangeLabel(week, lang)}
              </th>
            ))}
          </tr>
          <tr>
            <th style={{ ...labelCell, ...headCell, textAlign: "left", zIndex: 3 }} />
            {weeks.map(week => [
              <th key={`${week}-v`} style={{ ...headCell, borderLeft: `1px solid ${C.panelBorder}`, fontSize: 10.5, fontWeight: 500 }}>{s.wk.value}</th>,
              <th key={`${week}-d`} style={{ ...headCell, fontSize: 10.5, fontWeight: 500 }}>{s.wk.wow}</th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {WEEKLY_KPI_GROUPS.map(group => (
            <Fragment key={group.id}>
              <tr>
                <td
                  colSpan={1 + weeks.length * 2}
                  style={{
                    ...labelCell, position: "static", background: "#1B2029",
                    fontWeight: 700, fontSize: 11, letterSpacing: 0.5,
                    textTransform: "uppercase", color: C.inkDim,
                    borderTop: `1px solid ${C.panelBorder}`,
                  }}
                >
                  {s.wk.groups[group.id]}
                </td>
              </tr>
              {group.rows.map(row => (
                <tr key={row.key}>
                  <td style={{ ...labelCell, fontWeight: 500 }}>{s.wk.rows[row.key]}</td>
                  {weeks.map(week => {
                    const current = rowsByWeek[week]?.[row.key] ?? null;
                    const change = wowChange(current, rowsByWeek[previousWeek(week)]?.[row.key] ?? null);
                    const style = deltaStyle(change, row.better);
                    const isEditing = editing === week && row.editable;
                    const drillable = Boolean(DRILLABLE[row.key]) && current != null && current > 0;

                    return [
                      <td
                        key={`${week}-${row.key}-v`}
                        onClick={
                          row.editable ? () => { setEditing(week); setDraft(current == null ? "" : String(current)); }
                          : drillable ? () => setDrill({ metric: row.key, week })
                          : undefined
                        }
                        title={row.editable ? s.wk.editSpendHint : drillable ? s.drill.hint : undefined}
                        style={{
                          padding: "8px 12px", fontSize: 12.5, textAlign: "right",
                          borderLeft: `1px solid ${C.panelBorder}`, whiteSpace: "nowrap",
                          cursor: row.editable || drillable ? "pointer" : "default",
                          textDecoration: drillable ? "underline dotted" : "none",
                          textUnderlineOffset: 3,
                          textDecorationColor: C.inkFaint,
                          fontVariantNumeric: "tabular-nums",
                          color: current == null ? C.inkFaint : C.ink,
                        }}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            type="number"
                            value={draft}
                            onChange={e => setDraft(e.target.value)}
                            onBlur={() => commitSpend(week)}
                            onKeyDown={e => {
                              if (e.key === "Enter") commitSpend(week);
                              if (e.key === "Escape") setEditing(null);
                            }}
                            style={{ width: 92, background: "#1D222B", border: `1px solid ${C.accent}`, borderRadius: 6, color: C.ink, padding: "4px 6px", fontSize: 12.5, textAlign: "right" }}
                          />
                        ) : savingWeek === week && row.editable ? (
                          <Spinner />
                        ) : (
                          <>
                            {formatValue(current, row.format)}
                            {row.coverageOf && current != null && (() => {
                              const known = rowsByWeek[week]?.[row.coverageCount];
                              const total = rowsByWeek[week]?.[row.coverageOf];
                              if (known == null || total == null || known >= total) return null;
                              // Partial coverage must be visible, or an incomplete
                              // sum gets read as the week's full FTD revenue.
                              return (
                                <span title={s.wk.coverageHint} style={{ color: C.negative, fontSize: 10.5, marginLeft: 5 }}>
                                  {known}/{total}
                                </span>
                              );
                            })()}
                          </>
                        )}
                      </td>,
                      <td
                        key={`${week}-${row.key}-d`}
                        style={{
                          padding: "8px 12px", fontSize: 11.5, textAlign: "right",
                          whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...style,
                        }}
                      >
                        {change == null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`}
                      </td>,
                    ];
                  })}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}
