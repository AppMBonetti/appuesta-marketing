import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { SectionHeading, Panel, Spinner, fmtDOP } from "./ui";

/**
 * Revenue figures are only trustworthy while the bet-level maths agrees with
 * the operator's own reporting, so both sides are shown rather than assumed.
 * InTarget arrives at GGR through a separate pipeline, which makes it a genuine
 * third-party check rather than a restatement of the same numbers.
 */
export default function GgrReconciliation({ s }) {
  const [row, setRow] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase.from("ggr_reconciliation").select("*").maybeSingle();
      if (!active) return;
      setRow(data || null);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 30 }}><Spinner size={20} /></div>;
  if (!row || Number(row.bets_counted) === 0) return null;

  const ggr = Number(row.ggr);
  const intarget = Number(row.intarget_ggr);
  const openLiability = Number(row.open_liability);
  const variance = ggr - intarget;
  // The open bets are the expected reason the two sources differ; anything well
  // beyond that is a discrepancy worth chasing rather than explaining away.
  const explainedByOpen = Math.abs(Math.abs(variance) - openLiability) < openLiability * 0.25;

  const line = (label, value, strong = false) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 20, padding: "9px 0", borderBottom: `1px solid ${C.panelBorder}` }}>
      <span style={{ fontSize: 12.5, color: strong ? C.ink : C.inkDim, fontWeight: strong ? 600 : 400 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: strong ? 700 : 500, fontVariantNumeric: "tabular-nums", fontFamily: strong ? "'Space Grotesk', sans-serif" : undefined }}>{value}</span>
    </div>
  );

  return (
    <>
      <SectionHeading title={s.recon.title} subtitle={s.recon.sub} />
      <Panel style={{ marginBottom: 24 }}>
        {line(s.recon.stake, fmtDOP(row.stake))}
        {line(s.recon.settled, `− ${fmtDOP(row.settled_winnings)}`)}
        {line(s.recon.ggr, fmtDOP(ggr), true)}
        {line(s.recon.openLia, fmtDOP(openLiability))}
        {line(s.recon.intarget, fmtDOP(intarget))}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 20, padding: "10px 0 0" }}>
          <span style={{ fontSize: 12.5, color: C.inkDim }}>{s.recon.variance}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: explainedByOpen ? C.inkDim : C.negative }}>
            {variance >= 0 ? "+" : "−"}{fmtDOP(Math.abs(variance))}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 14 }}>
          <CheckCircle2 size={14} color={C.positive} style={{ flexShrink: 0, marginTop: 2 }} />
          <span style={{ fontSize: 11.5, color: C.inkDim, lineHeight: 1.6 }}>{s.recon.matchNote}</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 8 }}>
          {explainedByOpen
            ? <CheckCircle2 size={14} color={C.positive} style={{ flexShrink: 0, marginTop: 2 }} />
            : <AlertTriangle size={14} color={C.negative} style={{ flexShrink: 0, marginTop: 2 }} />}
          <span style={{ fontSize: 11.5, color: C.inkDim, lineHeight: 1.6 }}>{s.recon.varianceNote}</span>
        </div>

        <p style={{ fontSize: 11, color: C.inkFaint, margin: "12px 0 0" }}>
          {Number(row.bets_counted).toLocaleString()} {s.recon.betsCounted}
          {" · "}{Number(row.bets_excluded).toLocaleString()} {s.recon.betsExcluded}
          {" · "}{s.recon.range}: {String(row.first_bet).slice(0, 10)} → {String(row.last_bet).slice(0, 10)}
        </p>
      </Panel>
    </>
  );
}
