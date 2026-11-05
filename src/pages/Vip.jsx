import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ChevronDown, Download } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { SectionHeading, Panel, Spinner, fmtDOP, EmptyState } from "../components/ui";
import { downloadCsv } from "../lib/csv";
import { STAGE_COLORS } from "../lib/lifecycle";
import { useSortedRows } from "../lib/sortRows";
import { SortHeader } from "../components/SortHeader";
import RestrictButton from "../components/RestrictButton";
import VipTracker from "../components/VipTracker";
import { useSticky } from "../lib/sticky";

// What a tier shows for a window it has no rows in. The views cross join every
// tier against every window, so this is a belt-and-braces default rather than
// something expected to be reached.
const EMPTY_TIER_FIGURES = {
  players: 0, total_deposits: 0, deposit_count: 0, avg_deposit_ticket: null,
  tickets: 0, ticket_value: 0, bonus_stake: 0, avg_ticket: null, net_cash: 0, bettors: 0,
};

const TIER_COLORS = ["#8B93A3", "#B0555F", "#C9424F", "#E4022B", "#F03A57", "#F97A8F"];

// Raw values, not display-formatted ones: a CRM import wants 295986.87, not
// "DOP 295,987", and dates in ISO so any system parses them the same way.
const CSV_COLUMNS = [
  { label: "player_id", value: p => p.id },
  { label: "name", value: p => p.name },
  { label: "email", value: p => p.email },
  { label: "vip_tier", value: p => p.vip_tier },
  { label: "lifecycle", value: p => p.lifecycle },
  { label: "restricted", value: p => (p.restricted ? "yes" : "no") },
  { label: "registered_at", value: p => p.registered_at },
  { label: "first_deposit_date", value: p => p.first_deposit_date },
  { label: "last_deposit_date", value: p => p.last_deposit_date },
  { label: "days_since_deposit", value: p => p.days_since_deposit },
  { label: "last_login", value: p => p.last_login_at },
  { label: "days_since_login", value: p => p.days_since_login },
  { label: "total_deposit_amount_dop", value: p => p.total_deposit_amount },
  { label: "total_deposit_count", value: p => p.total_deposit_count },
  { label: "total_ggr_dop", value: p => p.total_ggr_sportsbook },
  { label: "total_withdrawal_dop", value: p => p.total_withdrawal_amount },
  { label: "wagered_90d_dop", value: p => p.trailing_wager },
  { label: "bets", value: p => p.bets },
  { label: "total_stake_dop", value: p => p.total_stake },
  { label: "avg_bet_dop", value: p => p.avg_stake },
  { label: "median_bet_dop", value: p => p.median_stake },
  { label: "sports_played", value: p => p.sports_played },
  { label: "top_sport", value: p => p.top_sport },
  { label: "top_sport_share_pct", value: p => p.top_sport_share },
  { label: "next_tier", value: p => p.next_tier },
  { label: "wager_to_next_tier_dop", value: p => p.wager_to_next },
  { label: "progress_to_next_pct", value: p => (p.progress_to_next == null ? "" : Math.round(p.progress_to_next * 100)) },
];

/** Case- and accent-insensitive, so "beisbol" finds "Béisbol". */
function normalize(text) {
  return String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function matchesSearch(player, needle) {
  if (!needle) return true;
  return [player.id, player.name, player.email, player.top_sport]
    .some(field => normalize(field).includes(needle));
}

function exportPlayers(rows, label) {
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = label.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-");
  downloadCsv(`appuesta-${slug}-${stamp}.csv`, CSV_COLUMNS, rows);
}

function fmtMonth(value, lang) {
  return new Date(`${String(value).slice(0, 10)}T12:00:00Z`).toLocaleDateString(
    lang === "es" ? "es-DO" : "en-GB",
    { month: "long", year: "numeric", timeZone: "UTC" });
}

function fmtShortDay(value, lang) {
  if (!value) return "";
  return new Date(`${String(value).slice(0, 10)}T12:00:00Z`).toLocaleDateString(
    lang === "es" ? "es-DO" : "en-GB",
    { day: "numeric", month: "short", timeZone: "UTC" });
}

function fmtDate(value, s, lang) {
  if (!value) return s.tierDrill.never;
  return new Date(value).toLocaleDateString(lang === "es" ? "es-DO" : "en-US", {
    day: "numeric", month: "short", year: "numeric",
  });
}

/** One labelled figure in a tier's header row. */
function Metric({ label, value, sub }) {
  return (
    <div style={{ width: 104, flexShrink: 0, textAlign: "right" }}>
      <div style={{ color: C.inkFaint, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 13, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ color: C.inkFaint, fontSize: 10.5, marginTop: 1 }}>{sub}</div>}
    </div>
  );
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

// The drill-down under an open tier. Its own component because each tier keeps
// its own column sort, and a hook cannot live inside the .map over tiers.
const TIER_SORT_COLUMNS = [
  { key: "player", kind: "text", label: s => s.tierDrill.cols.player, value: p => p.name || p.id },
  { key: "playerId", kind: "text", label: s => s.tierDrill.cols.playerId, value: p => p.id },
  // The tier says what a player is worth; this says whether they are still
  // here. A Leyenda who went cold is the one row worth calling today.
  { key: "lifecycle", kind: "text", label: s => s.seg.cols.lifecycle, value: p => p.lifecycle },
  { key: "deposits", label: s => s.tierDrill.cols.deposits, value: p => p.total_deposit_amount },
  { key: "count", label: s => s.tierDrill.cols.count, value: p => p.total_deposit_count },
  { key: "lastDeposit", kind: "date", label: s => s.tierDrill.cols.lastDeposit, value: p => p.last_deposit_date },
  { key: "lastLogin", kind: "date", label: s => s.tierDrill.cols.lastLogin, value: p => p.last_login_at },
  { key: "ggr", label: s => s.tierDrill.cols.ggr, value: p => p.total_ggr_sportsbook },
  { key: "bets", label: s => s.tierDrill.cols.bets, value: p => p.bets },
  { key: "avgBet", label: s => s.tierDrill.cols.avgBet, value: p => p.avg_stake },
  { key: "topSport", kind: "text", label: s => s.tierDrill.cols.topSport, value: p => p.top_sport },
  { key: "wagered", label: s => s.tierDrill.cols.wagered, value: p => p.trailing_wager },
  { key: "progress", label: s => s.tierDrill.cols.progress, value: p => p.progress_to_next },
];

function TierPlayers({ players, tier, s, lang, thStyle, tdStyle, onChanged }) {
  const { sorted, sort, toggle } = useSortedRows(players, TIER_SORT_COLUMNS);
  return (
    <>
    <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 12px 4px" }}>
      <button
        onClick={() => exportPlayers(sorted, tier.tier_name)}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: "#1D222B", color: C.ink, fontSize: 12, cursor: "pointer" }}
      >
        <Download size={12} /> {s.tierDrill.exportTier} ({sorted.length})
      </button>
    </div>
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <SortHeader columns={TIER_SORT_COLUMNS} sort={sort} toggle={toggle} s={s} th={thStyle} trailing={1} />
      </thead>
      <tbody>
        {sorted.map(p => (
          <tr key={p.id}>
            <td style={{ ...tdStyle, fontWeight: 500 }}>{p.name || p.id}</td>
            <td style={{ ...tdStyle, color: C.inkFaint, fontFamily: "monospace", fontSize: 11.5 }}>{p.id}</td>
            <td style={tdStyle}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: STAGE_COLORS[p.lifecycle] || C.inkFaint }} />
                {s.seg.lifecycle[p.lifecycle] || p.lifecycle || "—"}
                {/* Banned, limited or self-excluded: their money still counts,
                    which is why they are in this list, but nobody should call
                    them. */}
                {p.restricted && (
                  <span title={p.restriction_reason || s.seg.restrictedHint}
                    style={{ color: C.accent, fontSize: 10, border: `1px solid ${C.accent}66`, borderRadius: 5, padding: "1px 5px" }}>
                    {s.seg.restricted}
                  </span>
                )}
              </span>
            </td>
            <td style={tdStyle}>{fmtDOP(p.total_deposit_amount)}</td>
            <td style={{ ...tdStyle, color: C.inkDim }}>{p.total_deposit_count ?? 0}</td>
            <td style={{ ...tdStyle, color: C.inkDim }}>{fmtDate(p.last_deposit_date, s, lang)}</td>
            {/* A quiet depositor who still logs in is a different problem from
                one who has gone. */}
            <td style={{ ...tdStyle, color: p.days_since_login != null && p.days_since_login <= 7 ? C.positive : C.inkDim }}>
              {fmtDate(p.last_login_at, s, lang)}
            </td>
            <td style={tdStyle}>{fmtDOP(p.total_ggr_sportsbook)}</td>
            <td style={{ ...tdStyle, color: C.inkDim }}>{Number(p.bets) || 0}</td>
            <td style={tdStyle}>{p.avg_stake == null ? "—" : fmtDOP(p.avg_stake)}</td>
            <td style={{ ...tdStyle, color: C.inkDim }}>
              {p.top_sport
                ? <>{p.top_sport}{p.top_sport_share == null ? "" : ` · ${Math.round(Number(p.top_sport_share))}%`}</>
                : "—"}
            </td>
            <td style={tdStyle}>{fmtDOP(p.trailing_wager)}</td>
            <td style={{ ...tdStyle, width: "1%" }}>
              <ProgressToNext player={p} color={tier.color} s={s} />
            </td>
            {/* Same flag as the badge two columns back, set from here. */}
            <td style={{ ...tdStyle, width: "1%" }}>
              <RestrictButton player={p} s={s} onDone={onChanged} compact />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}

export default function Vip({ s, lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);
  const [players, setPlayers] = useState([]);
  const [openTier, setOpenTier] = useState(null);
  const [search, setSearch] = useState("");
  // Same contact filter as the tracker and Segments: narrows the lists, never
  // the tier counts, because a restricted player's money still counts. One
  // remembered key behind all three, so the choice holds across screens.
  const [hideRestricted, setHideRestricted] = useSticky("appuesta.hideRestricted", false);
  // Bumped when a player is restricted or released from either view. Both the
  // tier table and the tracker read the flag, so both reload: the tracker's own
  // fetch re-runs because `tiers` comes back as a new array.
  const [tick, setTick] = useState(0);
  // Tracking first: opening this page, the question is almost always "how are my
  // VIPs doing", not "what does the ladder look like".
  const [view, setView] = useState("track");
  // Which window the ladder's figures cover. "all" is the lifetime aggregate it
  // has always shown; "m:<month>" and "p:<start>|<end>" are a month and a
  // single deposit period. Not a free date range on purpose: the payments
  // report is one aggregate per player per period with no dates inside it, so
  // a whole period is the smallest window deposits can be attributed to.
  const [scope, setScope] = useState("all");
  const [monthRows, setMonthRows] = useState([]);
  const [periodRows, setPeriodRows] = useState([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [tiersRes, playersRes, monthsRes, periodsRes] = await Promise.all([
          supabase.from("vip_tier_summary").select("*").order("tier_order"),
          supabase.from("player_tier_progress").select("*").order("trailing_wager", { ascending: false }),
          supabase.from("vip_tier_month_summary").select("*")
            .order("month_start", { ascending: false }).order("tier_order"),
          supabase.from("vip_tier_period_summary").select("*")
            .order("period_start", { ascending: false }).order("tier_order"),
        ]);
        if (tiersRes.error) throw tiersRes.error;
        if (playersRes.error) throw playersRes.error;
        if (monthsRes.error) throw monthsRes.error;
        if (periodsRes.error) throw periodsRes.error;

        if (!active) return;
        setRows((tiersRes.data || []).map((t, i) => ({ ...t, color: TIER_COLORS[i % TIER_COLORS.length] })));
        setPlayers(playersRes.data || []);
        setMonthRows(monthsRes.data || []);
        setPeriodRows(periodsRes.data || []);
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [tick]);

  // Search narrows the lists and the exports, but never the tier counts above
  // them — those state the real size of each tier regardless of what is filtered.
  const needle = normalize(search.trim());
  const visiblePlayers = players.filter(
    p => matchesSearch(p, needle) && !(hideRestricted && p.restricted)
  );
  const restrictedCount = players.filter(p => p.restricted).length;

  // The windows the data can actually answer, newest first. Deduplicated on the
  // key rather than on the tier rows, which arrive six-deep per window.
  const months = useMemo(
    () => [...new Map(monthRows.map(r => [r.month_start, r])).values()],
    [monthRows]
  );
  const periods = useMemo(
    () => [...new Map(periodRows.map(r => [`${r.period_start}|${r.period_end}`, r])).values()],
    [periodRows]
  );

  // The selected window's figures, renamed onto the columns the lifetime row
  // uses so one renderer serves both. `players` becomes depositors: a tier has
  // the same population whatever window is asked about, and what changes is how
  // many of them paid in it.
  const scoped = useMemo(() => {
    if (scope === "all") return null;
    const key = scope.slice(2);
    const src = scope.startsWith("m:")
      ? monthRows.filter(r => r.month_start === key)
      : periodRows.filter(r => `${r.period_start}|${r.period_end}` === key);
    if (!src.length) return null;
    return {
      meta: src[0],
      byTier: Object.fromEntries(src.map(r => [r.tier_name, {
        players: r.depositors,
        total_deposits: r.deposits,
        deposit_count: r.deposit_count,
        avg_deposit_ticket: r.avg_deposit_ticket,
        tickets: r.tickets,
        ticket_value: r.ticket_value,
        bonus_stake: r.bonus_stake,
        avg_ticket: r.avg_ticket,
        net_cash: r.net_cash,
        bettors: r.bettors,
      }])),
    };
  }, [scope, monthRows, periodRows]);

  // Tier metadata (floor, cashback, colour) always comes from the ladder
  // itself; only the figures are overlaid.
  const ladder = scoped
    ? rows.map(t => ({ ...t, ...(scoped.byTier[t.tier_name] || EMPTY_TIER_FIGURES) }))
    : rows;

  // In lifetime mode the bar is share of players, which is what it has always
  // been. In a window that reads wrong -- a tier's population does not change
  // by month -- so it becomes share of what was deposited, and the caption
  // underneath says which one it is.
  const barOf = t => Number(scoped ? t.total_deposits : t.players) || 0;
  const maxBar = Math.max(1, ...ladder.map(barOf));
  const barTotal = ladder.reduce((sum, t) => sum + barOf(t), 0);

  // hasData stays on the lifetime rows: an empty month must not make the page
  // look like there is no data at all.
  const totalPlayers = rows.reduce((sum, r) => sum + Number(r.players), 0);
  const hasData = totalPlayers > 0;
  const thStyle = { padding: "9px 14px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" };
  const tdStyle = { padding: "9px 14px", fontSize: 12.5, whiteSpace: "nowrap" };

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <SectionHeading
          title={view === "track" ? s.vipTrack.title : s.vipTitle}
          subtitle={view === "track" ? s.vipTrack.sub : s.vipSub}
        />
        {/* Two different jobs behind two one-word labels read as the same
            screen twice. Each side now says what it answers. */}
        <div style={{ display: "flex", background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 12, padding: 4, gap: 4 }}>
          {[
            ["track", s.vipToggle.track, s.vipToggle.trackHint],
            ["ladder", s.vipToggle.ladder, s.vipToggle.ladderHint],
          ].map(([v, label, hint]) => (
            <button key={v} onClick={() => setView(v)}
              style={{
                padding: "9px 16px", borderRadius: 9, border: "none", cursor: "pointer",
                textAlign: "left", minWidth: 150,
                background: view === v ? C.accent : "transparent",
                color: view === v ? "#fff" : C.inkDim,
              }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
              <div style={{ fontSize: 11, opacity: view === v ? 0.85 : 0.7, marginTop: 2 }}>{hint}</div>
            </button>
          ))}
        </div>
      </div>
      {loading && <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>}
      {error && <Panel style={{ color: C.negative }}>{error}</Panel>}
      {!loading && !error && !hasData && <EmptyState s={s} />}
      {!loading && !error && hasData && view === "track" && (
        <VipTracker s={s} lang={lang} tiers={rows} progress={players}
          onChanged={() => setTick(t => t + 1)} />
      )}
      {!loading && !error && hasData && view === "ladder" && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
              <p style={{ color: C.inkFaint, fontSize: 12, margin: 0 }}>{s.tierDrill.hint}</p>
              {/* Periods, not a free date range: deposits arrive as one
                  aggregate per player per period with no dates inside, so a
                  whole period is the smallest window they can be attributed
                  to. Bets in the same window are exact. */}
              <select value={scope} onChange={e => { setScope(e.target.value); setOpenTier(null); }}
                title={s.tierPeriod.hint}
                style={{ padding: "7px 11px", borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: C.panel, color: C.ink, fontSize: 12.5, fontWeight: 500 }}>
                <option value="all">{s.tierPeriod.allTime}</option>
                {months.length > 0 && (
                  <optgroup label={s.tierPeriod.byMonth}>
                    {months.map(m => (
                      <option key={m.month_start} value={`m:${m.month_start}`}>
                        {fmtMonth(m.month_start, lang)}
                        {m.complete ? "" : ` · ${s.tierPeriod.partial.replace("{d}", fmtShortDay(m.covered_to, lang))}`}
                      </option>
                    ))}
                  </optgroup>
                )}
                {periods.length > 0 && (
                  <optgroup label={s.tierPeriod.byPeriod}>
                    {periods.map(r => (
                      <option key={`${r.period_start}|${r.period_end}`} value={`p:${r.period_start}|${r.period_end}`}>
                        {fmtShortDay(r.period_start, lang)} – {fmtShortDay(r.period_end, lang)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={s.tierDrill.searchPlaceholder}
                style={{ flex: "1 1 240px", maxWidth: 340, padding: "7px 11px", borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: C.panel, color: C.ink, fontSize: 12.5 }}
              />
              {restrictedCount > 0 && (
                <label title={s.vipTrack.hideRestrictedHint}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.inkDim, cursor: "pointer" }}>
                  <input type="checkbox" checked={hideRestricted}
                    onChange={e => { setHideRestricted(e.target.checked); setOpenTier(null); }} />
                  {s.vipTrack.hideRestricted.replace("{n}", String(restrictedCount))}
                </label>
              )}
              <button
                onClick={() => exportPlayers(visiblePlayers, search ? "busqueda" : "todos")}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 13px", borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: "#1D222B", color: C.ink, fontSize: 12.5, cursor: "pointer" }}
              >
                <Download size={13} /> {s.tierDrill.exportAll} ({visiblePlayers.length})
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {ladder.map(t => {
                const count = Number(t.players);
                const bar = barOf(t);
                const share = barTotal > 0 ? (bar / barTotal) * 100 : 0;
                const open = openTier === t.tier_name;
                const tierPlayers = visiblePlayers.filter(p => p.vip_tier === t.tier_name);
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
                      <div style={{ width: 128, flexShrink: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.tier_name}</div>
                        <div style={{ color: C.inkFaint, fontSize: 11, marginTop: 2 }}>
                          {fmtDOP(t.wager_required_dop)} · {t.cashback_pct}%
                        </div>
                      </div>
                      <div style={{ flex: 1, minWidth: 60, display: "flex", flexDirection: "column", gap: 5 }}>
                        <div style={{ background: "#1D222B", borderRadius: 8, height: 14 }}>
                          <div style={{ width: `${(bar / maxBar) * 100}%`, height: "100%", borderRadius: 8, background: t.color, opacity: 0.85 }} />
                        </div>
                        <div style={{ color: C.inkFaint, fontSize: 11 }}>
                          {share.toFixed(0)}% {scoped ? s.tierPeriod.ofDeposits : s.tierLadder.ofPlayers}
                        </div>
                      </div>
                      {/* What each segment is actually worth: what comes in, and
                          what gets played. */}
                      {/* Lifetime: how many players are in the tier. A window:
                          how many of them deposited in it. Two different
                          questions, so the label changes with the mode. */}
                      <Metric label={scoped ? s.tierPeriod.depositors : s.vipCols.players}
                        value={count.toLocaleString()}
                        sub={scoped && Number(t.bettors) > 0
                          ? s.tierPeriod.bettorsSub.replace("{n}", Number(t.bettors).toLocaleString())
                          : null} />
                      <Metric label={s.tierMetrics.deposited} value={fmtDOP(t.total_deposits)} />
                      <Metric label={s.tierMetrics.depositCount} value={Number(t.deposit_count).toLocaleString()} />
                      <Metric label={s.tierMetrics.avgDeposit}
                        value={t.avg_deposit_ticket == null ? "—" : fmtDOP(t.avg_deposit_ticket)} />
                      <Metric label={s.tierMetrics.tickets} value={Number(t.tickets).toLocaleString()} />
                      <Metric label={s.tierMetrics.avgTicket}
                        value={t.avg_ticket == null ? "—" : fmtDOP(t.avg_ticket)}
                        sub={Number(t.ticket_value) > 0
                          ? s.tierLadder.bonusShare.replace("{p}", String(Math.round((Number(t.bonus_stake) / Number(t.ticket_value)) * 100)))
                          : null} />
                      {/* Only in a window, and only because it can be negative:
                          Leyenda took out DOP 150,763 more than it put in during
                          October, which the deposit column alone cannot show.
                          Lifetime has no payout figure to pair with it -- the
                          payments report only carries payouts per period. */}
                      {scoped && (
                        <Metric label={s.tierPeriod.netCash}
                          value={fmtDOP(t.net_cash)}
                          sub={Number(t.net_cash) < 0 ? s.tierPeriod.negative : null} />
                      )}
                    </button>

                    {open && (
                      <div style={{ border: `1px solid ${t.color}`, borderTop: "none", borderRadius: "0 0 12px 12px", background: C.panel, padding: 4, overflowX: "auto" }}>
                        {tierPlayers.length === 0 ? (
                          <div style={{ padding: "20px 16px", fontSize: 12.5, color: C.inkDim }}>{s.tierDrill.noPlayers}</div>
                        ) : (
                          <TierPlayers players={tierPlayers} tier={t} s={s} lang={lang}
                            thStyle={thStyle} tdStyle={tdStyle}
                            onChanged={() => setTick(n => n + 1)} />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Three things a window cannot be read correctly without. They
                only appear in a window, because none of them is true of the
                lifetime view. */}
            {scoped && (
              <div style={{ border: `1px solid ${C.panelBorder}`, borderRadius: 12, background: C.panel, padding: "12px 15px", margin: "14px 0 0", maxWidth: 760, display: "flex", flexDirection: "column", gap: 7 }}>
                {scoped.meta.month_start && !scoped.meta.complete && (
                  <div style={{ fontSize: 11.5, color: "#D9A848" }}>
                    {s.tierPeriod.monthPartial
                      .replace("{from}", fmtShortDay(scoped.meta.covered_from, lang))
                      .replace("{to}", fmtShortDay(scoped.meta.covered_to, lang))}
                  </div>
                )}
                {scoped.meta.straddles_month && (
                  <div style={{ fontSize: 11.5, color: "#D9A848" }}>{s.tierPeriod.straddles}</div>
                )}
                <div style={{ fontSize: 11.5, color: C.inkDim }}>{s.tierPeriod.tierIsToday}</div>
                <div style={{ fontSize: 11.5, color: C.inkDim }}>{s.tierPeriod.drillIsWholeTier}</div>
                <div style={{ fontSize: 11.5, color: C.inkFaint }}>{s.tierPeriod.sourceNote}</div>
              </div>
            )}
            <p style={{ color: C.inkFaint, fontSize: 11.5, margin: "14px 0 0", maxWidth: 620 }}>
              {lang === "es"
                ? "El nivel se recalcula en cada importación a partir de la apuesta acumulada de los últimos 90 días. Sin apuestas registradas en ese periodo, un jugador queda en Prospecto — el nivel base, que no exige apuesta mínima."
                : "Tiers are recalculated on every import from the trailing 90-day wagered amount. With no bets recorded in that window a player sits in Prospecto — the base tier, which has no minimum wager."}
            </p>
          </>
      )}
    </>
  );
}
