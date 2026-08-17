import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { SectionHeading, Panel, Spinner, fmtDOP, EmptyState } from "../components/ui";

const TIER_COLORS = ["#8B93A3", "#B0555F", "#C9424F", "#E4022B", "#F03A57", "#F97A8F"];

export default function Vip({ s }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const { data: tiers, error: tierErr } = await supabase
          .from("vip_tiers")
          .select("tier_name, tier_order, wager_required_dop, cashback_pct")
          .order("tier_order");
        if (tierErr) throw tierErr;

        const { data: playerCounts, error: pErr } = await supabase
          .from("players")
          .select("vip_tier")
          .not("vip_tier", "is", null);
        if (pErr) throw pErr;

        const counts = new Map();
        for (const p of playerCounts) counts.set(p.vip_tier, (counts.get(p.vip_tier) || 0) + 1);

        if (!active) return;
        setRows((tiers || []).map((t, i) => ({
          ...t, pop: counts.get(t.tier_name) || 0, color: TIER_COLORS[i % TIER_COLORS.length],
        })));
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, []);

  const maxPop = Math.max(1, ...rows.map(r => r.pop));
  const hasData = rows.some(r => r.pop > 0);

  return (
    <>
      <SectionHeading title={s.vipTitle} subtitle={s.vipSub} />
      {loading && <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>}
      {error && <Panel style={{ color: C.negative }}>{error}</Panel>}
      {!loading && !error && (
        !hasData ? <EmptyState s={s} /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {rows.map(t => (
              <div key={t.tier_name} style={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ width: 12, height: 12, borderRadius: 99, background: t.color, flexShrink: 0 }} />
                <div style={{ width: 120, fontWeight: 600, fontSize: 13.5 }}>{t.tier_name}</div>
                <div style={{ width: 150, color: C.inkDim, fontSize: 12.5 }}>{fmtDOP(t.wager_required_dop)} req.</div>
                <div style={{ width: 90, color: C.inkDim, fontSize: 12.5 }}>{t.cashback_pct}% cashback</div>
                <div style={{ flex: 1, background: "#1D222B", borderRadius: 8, height: 20 }}><div style={{ width: `${(t.pop / maxPop) * 100}%`, height: "100%", borderRadius: 8, background: t.color, opacity: 0.85 }} /></div>
                <div style={{ width: 55, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>{t.pop}</div>
              </div>
            ))}
          </div>
        )
      )}
    </>
  );
}
