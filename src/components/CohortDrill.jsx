import { useEffect, useState } from "react";
import { X, Download } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { dateRangeLabel, formatWeek } from "../lib/period";
import { downloadCsv } from "../lib/csv";
import { Spinner, fmtDOP } from "./ui";

const CSV_COLUMNS = [
  { label: "player_id", value: p => p.id },
  { label: "username", value: p => p.username },
  { label: "email", value: p => p.email },
  { label: "vip_tier", value: p => p.vip_tier },
  { label: "first_deposit_date", value: p => p.first_deposit_date },
  { label: "first_deposit_amount_dop", value: p => p.first_deposit_amount },
  { label: "deposits_in_period", value: p => p.deposits_in_period },
  { label: "amount_in_period_dop", value: p => p.amount_in_period },
  { label: "retained", value: p => (p.retained ? "yes" : "no") },
  { label: "last_deposit", value: p => p.last_deposit_date },
  { label: "days_since_deposit", value: p => p.days_since_deposit },
  { label: "last_login", value: p => p.last_login_at },
  { label: "days_since_login", value: p => p.days_since_login },
  { label: "total_deposit_amount_dop", value: p => p.total_deposit_amount },
  { label: "total_deposit_count", value: p => p.total_deposit_count },
  { label: "ggr_dop", value: p => p.ggr },
];

/**
 * The players behind one retention cell.
 *
 * Last deposit and last login sit next to each other on purpose: a cohort at 35%
 * says nothing about why. Someone still logging in every day and not depositing
 * needs an offer; someone who stopped doing both needs winning back. The
 * percentage cannot tell those apart and this list can.
 */
export default function CohortDrill({ s, lang, cohortWeek, period, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [only, setOnly] = useState("all"); // all | retained | lapsed

  useEffect(() => {
    if (!cohortWeek || !period) return undefined;
    let active = true;
    setLoading(true);
    (async () => {
      const { data, error: err } = await supabase
        .from("cohort_deposit_detail")
        .select("*")
        .eq("cohort_week", cohortWeek)
        .eq("period_start", period.start)
        .eq("period_end", period.end)
        .order("amount_in_period", { ascending: false });
      if (!active) return;
      if (err) setError(err.message);
      setRows(data || []);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [cohortWeek, period]);

  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = rows.filter(r =>
    only === "all" ? true : only === "retained" ? r.retained : !r.retained);

  const th = { padding: "9px 12px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" };
  const td = { padding: "8px 12px", fontSize: 12.5, whiteSpace: "nowrap" };
  const date = v => (v ? String(v).slice(0, 10) : "—");
  const ago = d => (d == null ? "—" : s.ret.drill.daysAgo.replace("{n}", String(d)));

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(8,10,14,0.72)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 14, width: "min(1180px, 100%)", maxHeight: "86vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 18px", borderBottom: `1px solid ${C.panelBorder}` }}>
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 600 }}>
              {s.ret.drill.title.replace("{cohort}", formatWeek(cohortWeek, lang))}
            </div>
            <div style={{ fontSize: 12, color: C.inkDim, marginTop: 2 }}>
              {dateRangeLabel(period.start, period.end, lang)} · {shown.length}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ display: "flex", background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2 }}>
              {["all", "retained", "lapsed"].map(k => (
                <button key={k} onClick={() => setOnly(k)}
                  style={{ padding: "5px 11px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, background: only === k ? "#2A303B" : "transparent", color: only === k ? C.ink : C.inkDim }}>
                  {s.ret.drill[k]}
                </button>
              ))}
            </div>
            {shown.length > 0 && (
              <button onClick={() => downloadCsv(`appuesta-cohorte-${cohortWeek}-${period.start}.csv`, CSV_COLUMNS, shown)}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: "#1D222B", color: C.ink, fontSize: 12.5, cursor: "pointer" }}>
                <Download size={13} /> {s.drill.export}
              </button>
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
            : shown.length === 0 ? <div style={{ padding: 20, color: C.inkDim, fontSize: 12.5 }}>{s.drill.none}</div>
            : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {[s.drill.cols.player, s.drill.cols.tier, s.ret.drill.colDepositsInPeriod,
                      s.ret.drill.colAmountInPeriod, s.ret.drill.colLastDeposit, s.ret.drill.colLastLogin,
                      s.drill.cols.deposits, s.drill.cols.ggr].map(h => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {shown.map(p => (
                    <tr key={p.id} style={{ background: p.retained ? "transparent" : "rgba(214,72,72,0.05)" }}>
                      <td style={{ ...td, fontWeight: 500 }}>
                        {p.username || p.name || p.id}
                        <div style={{ fontSize: 11, color: C.inkFaint }}>{p.email || ""}</div>
                      </td>
                      <td style={{ ...td, color: C.inkDim }}>{p.vip_tier}</td>
                      <td style={{ ...td, color: p.retained ? C.positive : C.inkFaint, fontWeight: p.retained ? 600 : 400 }}>
                        {p.deposits_in_period}
                      </td>
                      <td style={td}>{p.amount_in_period > 0 ? fmtDOP(p.amount_in_period) : "—"}</td>
                      <td style={{ ...td, color: C.inkDim }}>
                        {date(p.last_deposit_date)}
                        <div style={{ fontSize: 11, color: C.inkFaint }}>{ago(p.days_since_deposit)}</div>
                      </td>
                      {/* The column that explains a low cell: still turning up, or gone entirely. */}
                      <td style={{ ...td, color: p.days_since_login != null && p.days_since_login <= 7 ? C.positive : C.inkDim }}>
                        {date(p.last_login_at)}
                        <div style={{ fontSize: 11, color: C.inkFaint }}>{ago(p.days_since_login)}</div>
                      </td>
                      <td style={td}>{fmtDOP(p.total_deposit_amount)}</td>
                      <td style={td}>{fmtDOP(p.ggr)}</td>
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
