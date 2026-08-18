import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { SectionHeading, Panel, Spinner, fmtDOP, EmptyState } from "../components/ui";

const TIER_COLORS = ["#8B93A3", "#B0555F", "#C9424F", "#E4022B", "#F03A57", "#F97A8F"];

export default function Vip({ s, lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // vip_tier_summary already left-joins players onto the tier ladder, so
        // tiers with nobody in them still render as empty rungs.
        const { data, error: viewErr } = await supabase
          .from("vip_tier_summary")
          .select("*")
          .order("tier_order");
        if (viewErr) throw viewErr;

        if (!active) return;
        setRows((data || []).map((t, i) => ({ ...t, color: TIER_COLORS[i % TIER_COLORS.length] })));
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, []);

  const maxPop = Math.max(1, ...rows.map(r => Number(r.players)));
  const totalPlayers = rows.reduce((sum, r) => sum + Number(r.players), 0);
  const hasData = totalPlayers > 0;

  return (
    <>
      <SectionHeading title={s.vipTitle} subtitle={s.vipSub} />
      {loading && <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>}
      {error && <Panel style={{ color: C.negative }}>{error}</Panel>}
      {!loading && !error && (
        !hasData ? <EmptyState s={s} /> : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rows.map(t => {
                const players = Number(t.players);
                const share = totalPlayers > 0 ? (players / totalPlayers) * 100 : 0;
                return (
                  <div key={t.tier_name} style={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", gap: 16 }}>
                    <div style={{ width: 12, height: 12, borderRadius: 99, background: t.color, flexShrink: 0 }} />
                    <div style={{ width: 120, fontWeight: 600, fontSize: 13.5 }}>{t.tier_name}</div>
                    <div style={{ width: 150, color: C.inkDim, fontSize: 12.5 }}>{fmtDOP(t.wager_required_dop)} req.</div>
                    <div style={{ width: 90, color: C.inkDim, fontSize: 12.5 }}>{t.cashback_pct}% cashback</div>
                    <div style={{ flex: 1, background: "#1D222B", borderRadius: 8, height: 20 }}><div style={{ width: `${(players / maxPop) * 100}%`, height: "100%", borderRadius: 8, background: t.color, opacity: 0.85 }} /></div>
                    <div style={{ width: 50, textAlign: "right", color: C.inkFaint, fontSize: 12 }}>{share.toFixed(0)}%</div>
                    <div style={{ width: 55, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>{players.toLocaleString()}</div>
                  </div>
                );
              })}
            </div>
            <p style={{ color: C.inkFaint, fontSize: 11.5, margin: "14px 0 0", maxWidth: 620 }}>
              {lang === "es"
                ? "El nivel se recalcula en cada importación a partir de la apuesta acumulada de los últimos 90 días. Sin apuestas registradas en ese periodo, un jugador queda en Prospecto — el nivel base, que no exige apuesta mínima."
                : "Tiers are recalculated on every import from the trailing 90-day wagered amount. With no bets recorded in that window a player sits in Prospecto — the base tier, which has no minimum wager."}
            </p>
          </>
        )
      )}
    </>
  );
}
