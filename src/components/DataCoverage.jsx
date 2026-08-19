import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CalendarClock } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { SectionHeading, Panel, Spinner, fmtDOP } from "./ui";

/**
 * Altenar exports are bounded by whatever date range the person running them
 * picked, so a day nobody exported looks identical to a day with no betting.
 * Neither gap is recoverable after the fact, so both are surfaced here rather
 * than left to be discovered in a wrong revenue figure weeks later.
 */
export default function DataCoverage({ s, lang }) {
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState([]);
  const [stale, setStale] = useState([]);

  useEffect(() => {
    let active = true;
    (async () => {
      const [coverageRes, staleRes] = await Promise.all([
        supabase.from("bet_coverage").select("*").eq("missing", true).order("day"),
        supabase.from("stale_open_bets").select("*").limit(25),
      ]);
      if (!active) return;
      setMissing(coverageRes.data || []);
      setStale(staleRes.data || []);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 30 }}><Spinner size={20} /></div>;

  const staleTotal = stale.reduce((sum, b) => sum + (Number(b.potential_payout) || 0), 0);
  const noteStyle = { fontSize: 11.5, color: C.inkFaint, margin: "8px 0 0", lineHeight: 1.6, maxWidth: 760 };

  return (
    <>
      <SectionHeading title={s.coverage.title} subtitle={s.coverage.sub} />

      {missing.length === 0 ? (
        <Panel style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.positive, marginBottom: 20, padding: "12px 16px" }}>
          <CheckCircle2 size={14} /> {s.coverage.allCovered}
        </Panel>
      ) : (
        <Panel style={{ marginBottom: 20, borderColor: `${C.negative}40` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.negative, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
            <AlertTriangle size={15} /> {missing.length} {s.coverage.missingDays}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {missing.map(d => (
              <span key={d.day} style={{ background: "#2C1B1A", border: `1px solid ${C.negative}40`, color: C.negative, borderRadius: 7, padding: "4px 9px", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                {d.day}
              </span>
            ))}
          </div>
          <p style={noteStyle}>{s.coverage.missingHint}</p>
        </Panel>
      )}

      <SectionHeading title={s.coverage.staleTitle} />
      {stale.length === 0 ? (
        <Panel style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.positive, marginBottom: 24, padding: "12px 16px" }}>
          <CheckCircle2 size={14} /> {s.coverage.staleNone}
        </Panel>
      ) : (
        <Panel style={{ marginBottom: 24, borderColor: `${C.negative}40` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.negative, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
            <CalendarClock size={15} /> {stale.length} · {fmtDOP(staleTotal)} {s.coverage.potentialCol.toLowerCase()}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                {[s.playerCol, s.coverage.dayCol, s.coverage.stakeCol, s.coverage.potentialCol, ""].map((h, i) => (
                  <th key={i} style={{ padding: "8px 12px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stale.map(b => (
                <tr key={b.bet_id}>
                  <td style={{ padding: "7px 12px" }}>{b.player_username || b.external_user_id || "—"}</td>
                  <td style={{ padding: "7px 12px", color: C.inkDim }}>{String(b.bet_date).slice(0, 10)}</td>
                  <td style={{ padding: "7px 12px" }}>{fmtDOP(b.stake)}</td>
                  <td style={{ padding: "7px 12px" }}>{fmtDOP(b.potential_payout)}</td>
                  <td style={{ padding: "7px 12px", color: C.negative }}>{b.days_open} {s.coverage.openDays}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={noteStyle}>{s.coverage.staleHint}</p>
        </Panel>
      )}
    </>
  );
}
