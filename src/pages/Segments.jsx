import { useEffect, useMemo, useState } from "react";
import { Download, Search, X, UserMinus, ShieldAlert, RotateCcw } from "lucide-react";
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

const WATCH_FLAGS = ["excluded", "internal", "duplicate"];
const WATCH_COLORS = { excluded: "#E4022B", internal: "#8B93A3", duplicate: "#D9A848" };

const WATCH_CSV_COLUMNS = [
  { label: "player_id", value: p => p.id },
  { label: "username", value: p => p.username },
  { label: "name", value: p => p.name },
  { label: "email", value: p => p.email },
  { label: "email_domain", value: p => p.email_domain },
  { label: "flag", value: p => p.flag },
  { label: "exclusion_reason", value: p => p.exclusion_reason },
  { label: "excluded_at", value: p => p.excluded_at },
  { label: "accounts_sharing_name", value: p => p.accounts_sharing_name },
  { label: "depositors_sharing_name", value: p => p.depositors_sharing_name },
  { label: "duplicate_suspect", value: p => (p.duplicate_suspect ? "yes" : "no") },
  { label: "registered_at", value: p => p.registered_at },
  { label: "last_login", value: p => p.last_login_at },
  { label: "days_since_login", value: p => p.days_since_login },
  { label: "last_deposit", value: p => p.last_deposit_date },
  { label: "deposit_count", value: p => p.total_deposit_count },
  { label: "total_deposited_dop", value: p => p.total_deposit_amount },
  { label: "ggr_dop", value: p => p.ggr },
  { label: "vip_tier", value: p => p.vip_tier },
];

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
  { label: "last_login", value: p => p.last_login_at },
  { label: "days_since_login", value: p => p.days_since_login },
  { label: "login_recency", value: p => p.login_recency },
  { label: "engaged_not_depositing", value: p => (p.engaged_not_depositing ? "yes" : "no") },
];

// Login-recency buckets in the order they read as a decay curve, so the filter
// and the summary row agree rather than sorting alphabetically.
const LOGIN_BUCKETS = ["0-1 days", "2-7 days", "8-14 days", "15-30 days", "30+ days", "Never logged in"];

const EMPTY_FILTERS = {
  stage: "", tier: "", sport: "", search: "", minDeposits: "", minBets: "",
  login: "", engaged: false,
};

export default function Segments({ s, lang }) {
  const [players, setPlayers] = useState([]);
  const [summary, setSummary] = useState([]);
  const [watchlist, setWatchlist] = useState([]);
  const [watchFlag, setWatchFlag] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [excluding, setExcluding] = useState(null);

  // Excluding a player removes them from every total on the dashboard, so it
  // asks for a reason and then reloads rather than hiding the row locally and
  // letting the figures above disagree with the list below.
  async function excludePlayer(player) {
    const reason = window.prompt(s.seg.excludePrompt.replace("{player}", player.username || player.name || player.id));
    if (reason === null) return;
    setExcluding(player.id);
    const { error: err } = await supabase.rpc("set_player_excluded", {
      p_player_id: player.id, p_excluded: true, p_reason: reason,
    });
    setExcluding(null);
    if (err) { setError(err.message); return; }
    load();
  }

  // PostgREST caps a response at 1,000 rows, so a plain select quietly returned
  // the top 1,000 players by deposits and nothing else -- the table, the filters
  // and the CSV export all described a truncated book without saying so. Page
  // through until a short page proves the end.
  async function loadAllPlayers() {
    const PAGE = 1000;
    const all = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("player_lifecycle")
        .select("*")
        .order("deposits", { ascending: false })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return { data: null, error };
      all.push(...(data || []));
      if (!data || data.length < PAGE) return { data: all, error: null };
    }
  }

  // A player held out of the book disappears from every figure at once, which
  // is the point -- and the reason they need somewhere to still be visible.
  async function loadWatchlist() {
    const { data, error } = await supabase
      .from("account_watchlist")
      .select("*")
      .order("duplicate_suspect", { ascending: false })
      .order("total_deposit_amount", { ascending: false });
    if (error) return { data: null, error };
    return { data: data || [], error: null };
  }

  async function restorePlayer(player) {
    setExcluding(player.id);
    const { error: err } = await supabase.rpc("set_player_excluded", {
      p_player_id: player.id, p_excluded: false, p_reason: null,
    });
    setExcluding(null);
    if (err) { setError(err.message); return; }
    load();
  }

  async function load() {
    const [p, sum, watch] = await Promise.all([
      loadAllPlayers(),
      supabase.from("lifecycle_summary").select("*"),
      loadWatchlist(),
    ]);
    if (p.error) setError(p.error.message);
    if (watch.error) setError(watch.error.message);
    setPlayers(p.data || []);
    setSummary(sum.data || []);
    setWatchlist(watch.data || []);
    setLoading(false);
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

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
      if (filters.login && p.login_recency !== filters.login) return false;
      if (filters.engaged && !p.engaged_not_depositing) return false;
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
  const totalPlayers = summary.reduce((sum, r) => sum + Number(r.players || 0), 0);

  const input = {
    background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 8,
    color: C.ink, padding: "7px 10px", fontSize: 12.5,
  };
  const th = { padding: "9px 12px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" };
  const td = { padding: "8px 12px", fontSize: 12.5, whiteSpace: "nowrap" };
  const dateOf = v => (v ? String(v).slice(0, 10) : s.seg.never);

  function exportSegment() {
    const parts = [filters.stage, filters.tier, filters.sport, filters.login,
      filters.engaged ? "engaged-not-depositing" : ""].filter(Boolean);
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
        <select value={filters.login} onChange={e => setFilters(f => ({ ...f, login: e.target.value }))} style={input}>
          <option value="">{s.seg.allLogins}</option>
          {LOGIN_BUCKETS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.inkDim, cursor: "pointer" }}>
          <input type="checkbox" checked={filters.engaged}
            onChange={e => setFilters(f => ({ ...f, engaged: e.target.checked }))} />
          {s.seg.engagedNotDepositing}
        </label>
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
                  s.seg.cols.lastActivity, s.seg.cols.daysInactive,
                  s.seg.cols.lastLogin, ""].map((h, i) => <th key={h || `act${i}`} style={th}>{h}</th>)}
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
                  <td style={{ ...td, color: C.inkDim }}>
                    {p.days_since_login == null ? "—" : (
                      <>
                        {s.seg.daysAgo.replace("{n}", String(p.days_since_login))}
                        {p.engaged_not_depositing && (
                          // Logged in this week but not paying: the one segment
                          // where the right action is an offer, not a win-back.
                          <span title={s.seg.engagedHint} style={{ color: "#4FA3D1", fontSize: 10, border: "1px solid #4FA3D155", borderRadius: 5, padding: "1px 5px", marginLeft: 6 }}>
                            {s.seg.engagedTag}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td style={{ ...td, width: "1%" }}>
                    {/* Removes the player from every figure on the dashboard,
                        not just from this list, so it asks for a reason. */}
                    <button
                      onClick={() => excludePlayer(p)}
                      disabled={excluding === p.id}
                      title={s.seg.excludeHint}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px", borderRadius: 7, border: `1px solid ${C.panelBorder}`, background: "transparent", color: C.inkFaint, fontSize: 11.5, cursor: excluding === p.id ? "default" : "pointer", opacity: excluding === p.id ? 0.5 : 1 }}
                    >
                      <UserMinus size={12} /> {s.seg.exclude}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {watchlist.length > 0 && (() => {
        const counts = Object.fromEntries(WATCH_FLAGS.map(f =>
          [f, watchlist.filter(w => w.flag === f).length]));
        const shown = watchFlag ? watchlist.filter(w => w.flag === watchFlag) : watchlist;
        // A self-excluded player whose name also carries an account that is
        // still depositing is the one row here that is not just a metrics
        // question.
        const reentry = watchlist.filter(w =>
          w.duplicate_suspect && !w.excluded && !w.is_internal
          && Number(w.total_deposit_count) > 0
          && watchlist.some(o => o.name_key === w.name_key && o.excluded));

        return (
          <div style={{ marginTop: 34 }}>
            <SectionHeading title={s.seg.watch.title} subtitle={s.seg.watch.sub} />

            {reentry.length > 0 && (
              <div style={{ display: "flex", gap: 9, alignItems: "flex-start", background: "#2C1B1A", border: `1px solid ${C.negative}55`, borderRadius: 12, padding: "12px 15px", marginBottom: 16, fontSize: 12.5, color: C.negative }}>
                <ShieldAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  {s.seg.watch.reentry.replace("{n}", String(reentry.length))}
                  <div style={{ color: C.ink, marginTop: 5 }}>
                    {reentry.map(w => `${w.username} (${w.id})`).join(" · ")}
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
              {WATCH_FLAGS.map(f => (
                <button key={f} onClick={() => setWatchFlag(watchFlag === f ? "" : f)}
                  title={s.seg.watch.desc[f]}
                  style={{ flex: "1 1 170px", minWidth: 170, textAlign: "left", cursor: "pointer", background: C.panel, borderRadius: 12, padding: "12px 14px", border: `1px solid ${watchFlag === f ? WATCH_COLORS[f] : C.panelBorder}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, color: C.inkDim, fontSize: 11.5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: WATCH_COLORS[f] }} />
                    {s.seg.watch.flags[f]}
                  </div>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 21, fontWeight: 600, marginTop: 5 }}>
                    {counts[f].toLocaleString()}
                  </div>
                </button>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 9, fontSize: 12, color: C.inkDim }}>
              <span>{s.seg.watch.count.replace("{n}", shown.length.toLocaleString())}</span>
              <button onClick={() => downloadCsv(
                  `appuesta-cuentas-senaladas-${new Date().toISOString().slice(0, 10)}.csv`,
                  WATCH_CSV_COLUMNS, shown)}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: "none", background: C.accent, color: "#fff", fontSize: 12, cursor: "pointer" }}>
                <Download size={13} /> {s.seg.watch.export}
              </button>
            </div>

            <Panel style={{ padding: 4, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {[s.seg.cols.id, s.seg.cols.player, s.seg.watch.cols.flag, s.seg.watch.cols.reason,
                      s.seg.watch.cols.sharing, s.seg.cols.deposits, s.seg.cols.depositCount,
                      s.seg.cols.lastLogin].map(h => <th key={h} style={th}>{h}</th>)}
                    <th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {shown.map(w => (
                    <tr key={w.id} style={{ borderTop: `1px solid ${C.panelBorder}` }}>
                      <td style={{ ...td, color: C.inkFaint, fontSize: 11.5 }}>{w.id}</td>
                      <td style={td}>
                        <div>{w.username || w.name || "—"}</div>
                        <div style={{ color: C.inkFaint, fontSize: 11 }}>{w.email}</div>
                      </td>
                      <td style={td}>
                        <span style={{ color: WATCH_COLORS[w.flag], fontSize: 11.5, border: `1px solid ${WATCH_COLORS[w.flag]}55`, borderRadius: 5, padding: "1px 7px" }}>
                          {s.seg.watch.flags[w.flag]}
                        </span>
                      </td>
                      <td style={{ ...td, color: C.inkDim, whiteSpace: "normal", maxWidth: 210 }}>
                        {w.exclusion_reason || (w.is_internal ? s.seg.watch.derived : "—")}
                      </td>
                      <td style={{ ...td, color: w.duplicate_suspect ? C.ink : C.inkDim }}>
                        {w.accounts_sharing_name
                          ? s.seg.watch.sharingValue
                              .replace("{n}", String(w.accounts_sharing_name))
                              .replace("{d}", String(w.depositors_sharing_name ?? 0))
                          : "—"}
                      </td>
                      <td style={td}>{fmtDOP(w.total_deposit_amount)}</td>
                      <td style={{ ...td, color: C.inkDim }}>{w.total_deposit_count}</td>
                      <td style={{ ...td, color: C.inkDim }}>
                        {w.days_since_login == null ? "—" : s.seg.daysAgo.replace("{n}", String(w.days_since_login))}
                      </td>
                      <td style={{ ...td, width: "1%" }}>
                        {/* Only a manual exclusion can be lifted here. is_internal
                            is derived and would come straight back on the next
                            import, so offering the button would be a lie. */}
                        {w.excluded && (
                          <button onClick={() => restorePlayer(w)} disabled={excluding === w.id}
                            title={s.seg.watch.restoreHint}
                            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px", borderRadius: 7, border: `1px solid ${C.panelBorder}`, background: "transparent", color: C.inkFaint, fontSize: 11.5, cursor: excluding === w.id ? "default" : "pointer", opacity: excluding === w.id ? 0.5 : 1 }}>
                            <RotateCcw size={12} /> {s.seg.watch.restore}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>
        );
      })()}
    </>
  );
}
