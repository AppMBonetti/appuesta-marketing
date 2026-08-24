import { useEffect, useMemo, useState } from "react";
import { Download, Search, X } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { downloadCsv } from "../lib/csv";
import { SectionHeading, Panel, Spinner, fmtDOP, EmptyState } from "../components/ui";

// Ordered by where a player sits in the funnel, not alphabetically, so the
// strip reads as a lifecycle rather than a list.
const STAGES = ["Registered", "New", "Casual", "Active", "Cooling", "At risk", "Churned"];
const STAGE_COLORS = {
  Registered: "#8B93A3", New: "#6E9BF2", Casual: "#B073F0", Active: "#3ECB9E",
  Cooling: "#D9A848", "At risk": "#F2994A", Churned: "#E4022B",
};

const CSV_COLUMNS = [
  { label: "player_id", value: p => p.id },
  { label: "name", value: p => p.name },
  { label: "email", value: p => p.email },
  { label: "lifecycle", value: p => p.lifecycle },
  { label: "vip_tier", value: p => p.vip_tier },
  { label: "registered_at", value: p => p.registered_at },
  { label: "first_deposit_date", value: p => p.first_deposit_date },
  { label: "last_deposit_date", value: p => p.last_deposit_date },
  { label: "last_bet_date", value: p => p.last_bet_date },
  { label: "days_inactive", value: p => p.days_inactive },
  { label: "total_deposited_dop", value: p => p.deposits },
  { label: "deposit_count", value: p => p.deposit_count },
  { label: "total_ggr_dop", value: p => p.ggr },
  { label: "bets", value: p => p.bets },
  { label: "total_stake_dop", value: p => p.total_stake },
  { label: "avg_stake_dop", value: p => p.avg_stake },
  { label: "median_stake_dop", value: p => p.median_stake },
  { label: "last_settlement", value: p => p.last_settlement_date },
  { label: "open_bets", value: p => p.open_bets },
  { label: "has_live_hook", value: p => (p.has_live_hook ? "yes" : "no") },
  { label: "top_sport", value: p => p.top_sport },
  { label: "top_sport_share_pct", value: p => p.top_sport_share },
  { label: "sports_played", value: p => p.sports_played },
];

const EMPTY_FILTERS = { stage: "", tier: "", sport: "", search: "", minDeposits: "", minBets: "" };

export default function Segments({ s, lang }) {
  const [players, setPlayers] = useState([]);
  const [summary, setSummary] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);

  useEffect(() => {
    let active = true;
    (async () => {
      const [p, sum] = await Promise.all([
        supabase.from("player_lifecycle").select("*").order("deposits", { ascending: false }),
        supabase.from("lifecycle_summary").select("*"),
      ]);
      if (!active) return;
      if (p.error) setError(p.error.message);
      setPlayers(p.data || []);
      setSummary(sum.data || []);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  const tiers = useMemo(
    () => [...new Set(players.map(p => p.vip_tier).filter(Boolean))].sort(),
    [players]
  );
  const sports = useMemo(
    () => [...new Set(players.map(p => p.top_sport).filter(Boolean))].sort(),
    [players]
  );

  const filtered = useMemo(() => {
    const needle = filters.search.trim().toLowerCase();
    const minDeposits = filters.minDeposits === "" ? null : Number(filters.minDeposits);
    const minBets = filters.minBets === "" ? null : Number(filters.minBets);
    return players.filter(p => {
      if (filters.stage && p.lifecycle !== filters.stage) return false;
      if (filters.tier && p.vip_tier !== filters.tier) return false;
      if (filters.sport && p.top_sport !== filters.sport) return false;
      if (minDeposits != null && Number(p.deposits || 0) < minDeposits) return false;
      if (minBets != null && Number(p.bets || 0) < minBets) return false;
      if (needle) {
        const haystack = `${p.name || ""} ${p.email || ""} ${p.id}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [players, filters]);

  const byStage = Object.fromEntries(summary.map(r => [r.lifecycle, r]));
  const totalPlayers = players.length;

  const input = {
    background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 8,
    color: C.ink, padding: "7px 10px", fontSize: 12.5,
  };
  const th = { padding: "9px 12px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" };
  const td = { padding: "8px 12px", fontSize: 12.5, whiteSpace: "nowrap" };
  const dateOf = v => (v ? String(v).slice(0, 10) : s.seg.never);

  function exportSegment() {
    const parts = [filters.stage, filters.tier, filters.sport].filter(Boolean);
    const label = parts.length ? parts.join("-") : "todos";
    const slug = label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-");
    downloadCsv(`appuesta-segmento-${slug}-${new Date().toISOString().slice(0, 10)}.csv`, CSV_COLUMNS, filtered);
  }

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>;
  if (error) return <Panel style={{ color: C.negative }}>{error}</Panel>;
  if (!players.length) return (<><SectionHeading title={s.seg.title} subtitle={s.seg.sub} /><EmptyState s={s} /></>);

  return (
    <>
      <SectionHeading title={s.seg.title} subtitle={s.seg.sub} />

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        {STAGES.map(stage => {
          const row = byStage[stage];
          const count = row ? Number(row.players) : 0;
          const selected = filters.stage === stage;
          const share = totalPlayers > 0 ? (count / totalPlayers) * 100 : 0;
          return (
            <button
              key={stage}
              onClick={() => setFilters(f => ({ ...f, stage: selected ? "" : stage }))}
              title={s.seg.desc[stage]}
              style={{
                flex: "1 1 150px", minWidth: 150, textAlign: "left", cursor: "pointer",
                background: C.panel, borderRadius: 12, padding: "12px 14px",
                border: `1px solid ${selected ? STAGE_COLORS[stage] : C.panelBorder}`,
                color: C.ink,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                <span style={{ width: 9, height: 9, borderRadius: 99, background: STAGE_COLORS[stage] }} />
                <span style={{ fontSize: 12, color: C.inkDim }}>{s.seg.lifecycle[stage]}</span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, fontFamily: "'Space Grotesk', sans-serif" }}>{count}</div>
              <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 3 }}>
                {share.toFixed(0)}% · {fmtDOP(row?.ggr ?? 0)} GGR
              </div>
            </button>
          );
        })}
      </div>

      {filters.stage && (
        <Panel style={{ padding: "11px 14px", marginBottom: 14, fontSize: 12.5, color: C.inkDim, borderColor: `${STAGE_COLORS[filters.stage]}66` }}>
          <strong style={{ color: C.ink }}>{s.seg.lifecycle[filters.stage]}</strong> — {s.seg.desc[filters.stage]}
        </Panel>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
          <Search size={13} color={C.inkFaint} style={{ position: "absolute", left: 9 }} />
          <input
            value={filters.search}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
            placeholder={s.seg.search}
            style={{ ...input, paddingLeft: 28, width: 250 }}
          />
        </span>
        <select value={filters.tier} onChange={e => setFilters(f => ({ ...f, tier: e.target.value }))} style={input}>
          <option value="">{s.seg.allTiers}</option>
          {tiers.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={filters.sport} onChange={e => setFilters(f => ({ ...f, sport: e.target.value }))} style={input}>
          <option value="">{s.seg.allSports}</option>
          {sports.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input type="number" value={filters.minDeposits} placeholder={s.seg.minDeposits}
          onChange={e => setFilters(f => ({ ...f, minDeposits: e.target.value }))} style={{ ...input, width: 130 }} />
        <input type="number" value={filters.minBets} placeholder={s.seg.minBets}
          onChange={e => setFilters(f => ({ ...f, minBets: e.target.value }))} style={{ ...input, width: 115 }} />

        <button onClick={() => setFilters(EMPTY_FILTERS)}
          style={{ ...input, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5, background: "transparent", color: C.inkDim }}>
          <X size={12} /> {s.seg.clear}
        </button>

        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12.5, color: C.inkDim }}>
            <strong style={{ color: C.ink }}>{filtered.length}</strong> {s.seg.matching}
          </span>
          <button onClick={exportSegment} disabled={filtered.length === 0}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 13px", borderRadius: 8, border: "none", background: C.accent, color: "#fff", fontSize: 12.5, fontWeight: 500, cursor: filtered.length ? "pointer" : "default", opacity: filtered.length ? 1 : 0.5 }}>
            <Download size={13} /> {s.seg.exportSegment}
          </button>
        </span>
      </div>

      {filtered.length === 0 ? (
        <Panel style={{ color: C.inkDim, fontSize: 12.5 }}>{s.seg.noMatch}</Panel>
      ) : (
        <Panel style={{ padding: 4, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {[s.seg.cols.id, s.seg.cols.player, s.seg.cols.lifecycle, s.seg.cols.tier,
                  s.seg.cols.deposits, s.seg.cols.depositCount, s.seg.cols.ggr, s.seg.cols.bets,
                  s.seg.cols.stake, s.seg.cols.avgStake, s.seg.cols.topSport,
                  s.seg.cols.lastActivity, s.seg.cols.daysInactive].map(h => <th key={h} style={th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id}>
                  <td style={{ ...td, color: C.inkFaint, fontVariantNumeric: "tabular-nums" }}>{p.id}</td>
                  <td style={{ ...td, fontWeight: 500 }}>
                    {p.name || "—"}
                    <div style={{ fontSize: 11, color: C.inkFaint }}>{p.email || ""}</div>
                  </td>
                  <td style={td}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 99, background: STAGE_COLORS[p.lifecycle] }} />
                      {s.seg.lifecycle[p.lifecycle] || p.lifecycle}
                      {p.has_live_hook && (
                        // The segment reflects what the player did; this flags a
                        // reason to contact them anyway — a bet the house just
                        // settled, or one still running.
                        <span title={s.seg.liveHookHint} style={{ color: "#D9A848", fontSize: 10, border: "1px solid #D9A84855", borderRadius: 5, padding: "1px 5px" }}>
                          {s.seg.liveHook}
                        </span>
                      )}
                    </span>
                  </td>
                  <td style={{ ...td, color: C.inkDim }}>{p.vip_tier || "—"}</td>
                  <td style={td}>{fmtDOP(p.deposits)}</td>
                  <td style={{ ...td, color: C.inkDim }}>{p.deposit_count}</td>
                  <td style={td}>{fmtDOP(p.ggr)}</td>
                  <td style={{ ...td, color: C.inkDim }}>{p.bets ?? 0}</td>
                  <td style={td}>{fmtDOP(p.total_stake)}</td>
                  <td style={td}>{fmtDOP(p.avg_stake)}</td>
                  <td style={{ ...td, color: C.inkDim }}>
                    {p.top_sport
                      ? <>{p.top_sport}{p.top_sport_share != null && (
                          <span style={{ color: C.inkFaint, fontSize: 11, marginLeft: 5 }}>
                            {Number(p.top_sport_share).toFixed(0)}%{Number(p.sports_played) === 1 ? ` ${s.seg.onlyOneSport}` : ""}
                          </span>)}</>
                      : "—"}
                  </td>
                  <td style={{ ...td, color: C.inkDim }}>{dateOf(p.last_activity)}</td>
                  <td style={{ ...td, color: p.days_inactive >= 15 ? C.negative : C.inkDim }}>
                    {p.days_inactive ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}
