import { useEffect, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { SectionHeading, Panel, Spinner, fmtDOP, EmptyState } from "../components/ui";

const TIER_COLORS = ["#8B93A3", "#B0555F", "#C9424F", "#E4022B", "#F03A57", "#F97A8F"];

function fmtDate(value, s, lang) {
  if (!value) return s.tierDrill.never;
  return new Date(value).toLocaleDateString(lang === "es" ? "es-DO" : "en-US", {
    day: "numeric", month: "short", year: "numeric",
  });
}

/** How far a player has come from their tier's floor toward the next one. */
function ProgressToNext({ player, color, s }) {
  const pct = Math.round((Number(player.progress_to_next) || 0) * 100);
  const atTop = !player.next_tier;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 220 }}>
      <div style={{ flex: 1, background: "#1D222B", borderRadius: 6, height: 8, overflow: "hidden" }}>
        <div style={{ width: `${atTop ? 100 : pct}%`, height: "100%", borderRadius: 6, background: atTop ? C.positive : color, transition: "width .2s" }} />
      </div>
      <div style={{ width: 168, fontSize: 11.5, color: C.inkDim, whiteSpace: "nowrap" }}>
        {atTop
          ? <span style={{ color: C.positive }}>{s.tierDrill.maxTier}</span>
          : <>{pct}% · <strong style={{ color: C.ink }}>{fmtDOP(player.wager_to_next)}</strong> {s.tierDrill.toNext} {player.next_tier}</>}
      </div>
    </div>
  );
}

export default function Vip({ s, lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);
  const [players, setPlayers] = useState([]);
  const [openTier, setOpenTier] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [tiersRes, playersRes] = await Promise.all([
          supabase.from("vip_tier_summary").select("*").order("tier_order"),
          supabase.from("player_tier_progress").select("*").order("trailing_wager", { ascending: false }),
        ]);
        if (tiersRes.error) throw tiersRes.error;
        if (playersRes.error) throw playersRes.error;

        if (!active) return;
        setRows((tiersRes.data || []).map((t, i) => ({ ...t, color: TIER_COLORS[i % TIER_COLORS.length] })));
        setPlayers(playersRes.data || []);
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
  const thStyle = { padding: "9px 14px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" };
  const tdStyle = { padding: "9px 14px", fontSize: 12.5, whiteSpace: "nowrap" };

  return (
    <>
      <SectionHeading title={s.vipTitle} subtitle={s.vipSub} />
      {loading && <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>}
      {error && <Panel style={{ color: C.negative }}>{error}</Panel>}
      {!loading && !error && (
        !hasData ? <EmptyState s={s} /> : (
          <>
            <p style={{ color: C.inkFaint, fontSize: 12, margin: "0 0 12px" }}>{s.tierDrill.hint}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rows.map(t => {
                const count = Number(t.players);
                const share = totalPlayers > 0 ? (count / totalPlayers) * 100 : 0;
                const open = openTier === t.tier_name;
                const tierPlayers = players.filter(p => p.vip_tier === t.tier_name);
                const Chevron = open ? ChevronDown : ChevronRight;

                return (
                  <div key={t.tier_name}>
                    <button
                      onClick={() => setOpenTier(open ? null : t.tier_name)}
                      style={{
                        width: "100%", background: C.panel, border: `1px solid ${open ? t.color : C.panelBorder}`,
                        borderRadius: open ? "12px 12px 0 0" : 12, padding: "14px 18px", display: "flex",
                        alignItems: "center", gap: 16, cursor: "pointer", textAlign: "left", color: C.ink,
                      }}
                    >
                      <Chevron size={15} color={C.inkFaint} style={{ flexShrink: 0 }} />
                      <div style={{ width: 12, height: 12, borderRadius: 99, background: t.color, flexShrink: 0 }} />
                      <div style={{ width: 120, fontWeight: 600, fontSize: 13.5 }}>{t.tier_name}</div>
                      <div style={{ width: 150, color: C.inkDim, fontSize: 12.5 }}>{fmtDOP(t.wager_required_dop)} req.</div>
                      <div style={{ width: 90, color: C.inkDim, fontSize: 12.5 }}>{t.cashback_pct}% cashback</div>
                      <div style={{ flex: 1, background: "#1D222B", borderRadius: 8, height: 20, minWidth: 60 }}>
                        <div style={{ width: `${(count / maxPop) * 100}%`, height: "100%", borderRadius: 8, background: t.color, opacity: 0.85 }} />
                      </div>
                      <div style={{ width: 50, textAlign: "right", color: C.inkFaint, fontSize: 12 }}>{share.toFixed(0)}%</div>
                      <div style={{ width: 55, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>{count.toLocaleString()}</div>
                    </button>

                    {open && (
                      <div style={{ border: `1px solid ${t.color}`, borderTop: "none", borderRadius: "0 0 12px 12px", background: C.panel, padding: 4, overflowX: "auto" }}>
                        {tierPlayers.length === 0 ? (
                          <div style={{ padding: "20px 16px", fontSize: 12.5, color: C.inkDim }}>{s.tierDrill.noPlayers}</div>
                        ) : (
                          <table style={{ width: "100%", borderCollapse: "collapse" }}>
                            <thead>
                              <tr>
                                {[s.tierDrill.cols.player, s.tierDrill.cols.deposits, s.tierDrill.cols.count,
                                  s.tierDrill.cols.lastDeposit, s.tierDrill.cols.ggr, s.tierDrill.cols.wagered,
                                  s.tierDrill.cols.progress].map(h => <th key={h} style={thStyle}>{h}</th>)}
                              </tr>
                            </thead>
                            <tbody>
                              {tierPlayers.map(p => (
                                <tr key={p.id}>
                                  <td style={{ ...tdStyle, fontWeight: 500 }}>{p.name || p.id}</td>
                                  <td style={tdStyle}>{fmtDOP(p.total_deposit_amount)}</td>
                                  <td style={{ ...tdStyle, color: C.inkDim }}>{p.total_deposit_count ?? 0}</td>
                                  <td style={{ ...tdStyle, color: C.inkDim }}>{fmtDate(p.last_deposit_date, s, lang)}</td>
                                  <td style={tdStyle}>{fmtDOP(p.total_ggr_sportsbook)}</td>
                                  <td style={tdStyle}>{fmtDOP(p.trailing_wager)}</td>
                                  <td style={{ ...tdStyle, width: "1%" }}>
                                    <ProgressToNext player={p} color={t.color} s={s} />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
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
