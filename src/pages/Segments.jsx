import { useEffect, useMemo, useState } from "react";
import { Download, Search, X, UserMinus, ShieldAlert, RotateCcw } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { downloadCsv } from "../lib/csv";
import { addDays } from "../lib/period";
import { useSortedRows } from "../lib/sortRows";
import { SortHeader } from "../components/SortHeader";
import { SectionHeading, Panel, Spinner, fmtDOP, EmptyState } from "../components/ui";
import RestrictButton from "../components/RestrictButton";
import { STAGES, STAGE_COLORS } from "../lib/lifecycle";
import { fullPlayerId, playerIdHaystack } from "../lib/playerId";
import { useSticky } from "../lib/sticky";

// Ordered by where a player sits in the funnel, not alphabetically, so the
// strip reads as a lifecycle rather than a list.
// Which header sorts on what. Keys line up with the header row below; a column
// with no key (the action button) is not sortable.
const SORT_COLUMNS = [
  { key: "id", kind: "text", label: s => s.seg.cols.id, value: p => fullPlayerId(p.id) },
  { key: "player", kind: "text", label: s => s.seg.cols.player, value: p => p.name || p.username || p.email },
  { key: "lifecycle", kind: "text", label: s => s.seg.cols.lifecycle, value: p => p.lifecycle },
  { key: "tier", kind: "text", label: s => s.seg.cols.tier, value: p => p.vip_tier },
  { key: "deposits", label: s => s.seg.cols.deposits, value: p => p.deposits },
  { key: "depositCount", label: s => s.seg.cols.depositCount, value: p => p.deposit_count },
  // Sits beside deposits on purpose: those say what a player has been worth,
  // this says what is still in the account, which is what decides how hard to
  // chase someone who has gone quiet.
  { key: "balance", label: s => s.seg.cols.balance, value: p => p.total_balance },
  { key: "ggr", label: s => s.seg.cols.ggr, value: p => p.ggr },
  { key: "bets", label: s => s.seg.cols.bets, value: p => p.bets },
  { key: "stake", label: s => s.seg.cols.stake, value: p => p.total_stake },
  { key: "avgStake", label: s => s.seg.cols.avgStake, value: p => p.avg_stake },
  { key: "topSport", kind: "text", label: s => s.seg.cols.topSport, value: p => p.top_sport },
  { key: "lastLogin", kind: "date", label: s => s.seg.cols.lastLogin, value: p => p.last_login_at },
  { key: "lastBet", kind: "date", label: s => s.seg.cols.lastBet, value: p => p.last_bet_date },
  { key: "lastDeposit", kind: "date", label: s => s.seg.cols.lastDeposit, value: p => p.last_deposit_date },
  { key: "daysSinceDeposit", label: s => s.seg.cols.daysSinceDeposit, value: p => p.days_since_deposit },
];

const WATCH_SORT_COLUMNS = [
  { key: "id", kind: "text", label: s => s.seg.cols.id, value: w => fullPlayerId(w.id) },
  { key: "player", kind: "text", label: s => s.seg.cols.player, value: w => w.username || w.name || w.email },
  { key: "flag", kind: "text", label: s => s.seg.watch.cols.flag, value: w => w.flag },
  { key: "reason", kind: "text", label: s => s.seg.watch.cols.reason, value: w => w.exclusion_reason },
  { key: "sharing", label: s => s.seg.watch.cols.sharing, value: w => w.accounts_sharing_name },
  { key: "deposits", label: s => s.seg.cols.deposits, value: w => w.total_deposit_amount },
  { key: "depositCount", label: s => s.seg.cols.depositCount, value: w => w.total_deposit_count },
  { key: "lastLogin", kind: "date", label: s => s.seg.cols.lastLogin, value: w => w.last_login_at },
];

// Stage names, colours and health order live in one place now; the VIP tier
// drill-down shows the same badge.
const STAGE_MOVE_COLORS = { up: "#3ECB9E", down: "#F2994A", sideways: "#8B93A3" };

const WATCH_FLAGS = ["excluded", "internal", "duplicate"];
const WATCH_COLORS = { excluded: "#E4022B", internal: "#8B93A3", duplicate: "#D9A848" };

const WATCH_CSV_COLUMNS = [
  { label: "player_id", value: p => fullPlayerId(p.id) },
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
  { label: "player_id", value: p => fullPlayerId(p.id) },
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
  { label: "cash_balance_dop", value: p => p.cash_balance },
  { label: "bonus_balance_dop", value: p => p.bonus_balance },
  { label: "total_balance_dop", value: p => p.total_balance },
  { label: "wallet_updated_at", value: p => p.wallet_updated_at },
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
  { label: "last_deposit", value: p => p.last_deposit_date },
  { label: "days_since_deposit", value: p => p.days_since_deposit },
  { label: "days_since_bet", value: p => p.days_since_bet },
  { label: "engaged_not_depositing", value: p => (p.engaged_not_depositing ? "yes" : "no") },
];

// Login-recency buckets in the order they read as a decay curve, so the filter
// and the summary row agree rather than sorting alphabetically.
const LOGIN_BUCKETS = ["0-1 days", "2-7 days", "8-14 days", "15-30 days", "30+ days", "Never logged in"];

function fmtDay(value, lang) {
  if (!value) return "";
  return new Date(`${String(value).slice(0, 10)}T12:00:00Z`).toLocaleDateString(
    lang === "es" ? "es-DO" : "en-GB",
    { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

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
  // Outside `filters`, and so outside "clear filters", on purpose: a player is
  // marked restricted because they must never be contacted again, which makes
  // hiding them a standing preference rather than something you are exploring
  // with. Remembered across visits for the same reason.
  const [hideRestricted, setHideRestricted] = useSticky("appuesta.hideRestricted", false);
  const [excluding, setExcluding] = useState(null);
  const [trend, setTrend] = useState([]);
  const [moves, setMoves] = useState([]);
  // Which capture's movers are listed. All of them together are 1,147 rows and
  // PostgREST caps a response at 1,000, so fetching "every move" would silently
  // drop the oldest weeks. One week at a time is both smaller and the question
  // actually being asked.
  const [moveWeek, setMoveWeek] = useState(null);
  // "players" is the list this screen is opened for; "moves" is the history.
  const [tab, setTab] = useState("players");
  // Which earlier import the stage counts are read against. Changes the number
  // on each card and nothing else -- the player list below is always the book
  // as it stands now, so comparing a period never re-buckets anybody.
  const [compareTo, setCompareTo] = useState("week");
  const [moveFilter, setMoveFilter] = useState("");

  // Excluding a player removes them from every total on the dashboard, so it
  // asks for a reason and then reloads rather than hiding the row locally and
  // letting the figures above disagree with the list below.
  async function excludePlayer(player) {
    const reason = window.prompt(s.seg.excludePrompt.replace("{player}", player.username || player.name || fullPlayerId(player.id)));
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
    const [p, sum, watch, trend] = await Promise.all([
      loadAllPlayers(),
      supabase.from("lifecycle_summary").select("*"),
      loadWatchlist(),
      // One row per stage per weekly cut. The cuts before 1 November are
      // reconstructed rather than captured -- `estimated` says which, and
      // `uncertain` counts the players whose stage that week the data cannot
      // settle either way.
      supabase.from("lifecycle_trend").select("*").order("captured_on"),
    ]);
    if (p.error) setError(p.error.message);
    if (watch.error) setError(watch.error.message);
    setPlayers(p.data || []);
    setSummary(sum.data || []);
    setWatchlist(watch.data || []);
    setTrend(trend.data || []);
    setLoading(false);
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Movers for one capture at a time, refetched when the week changes.
  useEffect(() => {
    if (!moveWeek) return undefined;
    let active = true;
    (async () => {
      const { data, error: err } = await supabase
        .from("player_stage_moves").select("*")
        .eq("captured_on", moveWeek)
        .order("deposits", { ascending: false });
      if (!active) return;
      if (err) { setError(err.message); return; }
      setMoves(data || []);
    })();
    return () => { active = false; };
  }, [moveWeek]);

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
      // A contact filter, not a financial one. Restricted players stay in every
      // total -- their money is real -- but when the list is being read to
      // decide who to call, they are noise at best and a mistake at worst.
      if (hideRestricted && p.restricted) return false;
      if (minDeposits != null && Number(p.deposits || 0) < minDeposits) return false;
      if (minBets != null && Number(p.bets || 0) < minBets) return false;
      if (needle) {
        const haystack = `${p.name || ""} ${p.email || ""} ${playerIdHaystack(p.id)}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [players, filters, hideRestricted]);

  const { sorted, sort, toggle } = useSortedRows(filtered, SORT_COLUMNS);

  const watchShown = watchFlag ? watchlist.filter(w => w.flag === watchFlag) : watchlist;
  const { sorted: watchSorted, sort: watchSort, toggle: watchToggle } =
    useSortedRows(watchShown, WATCH_SORT_COLUMNS);

  const byStage = Object.fromEntries(summary.map(r => [r.lifecycle, r]));
  const totalPlayers = summary.reduce((sum, r) => sum + Number(r.players || 0), 0);

  // The capture the cards are compared against: the newest one at least a week
  // (or a month) older than the latest. Reports land weekly, so "a week ago"
  // is usually the previous import and "a month ago" the one four back --
  // picked by date rather than by position so a skipped week cannot pass for a
  // week of change.
  const captures = useMemo(
    () => [...new Set(trend.map(r => r.captured_on))].sort(),
    [trend]
  );
  const latestCapture = captures.length ? captures[captures.length - 1] : null;
  const baselineCapture = useMemo(() => {
    if (!latestCapture) return null;
    const target = addDays(latestCapture, compareTo === "month" ? -28 : -6);
    // The newest capture at or before the target, and never the latest itself.
    const earlier = captures.filter(c => c < latestCapture && c <= target);
    return earlier.length ? earlier[earlier.length - 1] : null;
  }, [captures, latestCapture, compareTo]);

  useEffect(() => {
    if (!moveWeek && latestCapture) setMoveWeek(latestCapture);
  }, [latestCapture, moveWeek]);

  const baselineByStage = useMemo(() => Object.fromEntries(
    trend.filter(r => r.captured_on === baselineCapture)
      .map(r => [r.lifecycle, Number(r.players) || 0])
  ), [trend, baselineCapture]);

  // The movers already belong to one capture, because that is how they were
  // fetched. The newest week is the default; the picker below changes it.
  const latestMoves = moves;
  const shownMoves = moveFilter
    ? latestMoves.filter(m => m.direction === moveFilter)
    : latestMoves;

  // Every week except the first has a previous one to be compared against, so
  // the picker lists all but the oldest capture.
  const moveWeeks = useMemo(
    () => captures.slice(1).reverse(),
    [captures]
  );
  // capture -> stage -> players, for the grid below the cards.
  const byCapture = useMemo(() => {
    const by = {};
    for (const r of trend) {
      (by[r.captured_on] ||= {})[r.lifecycle] = Number(r.players) || 0;
    }
    return by;
  }, [trend]);
  const estimatedOn = useMemo(() => Object.fromEntries(
    trend.map(r => [r.captured_on, r.estimated])
  ), [trend]);
  const uncertainOn = useMemo(() => {
    const by = {};
    for (const r of trend) by[r.captured_on] = (by[r.captured_on] || 0) + Number(r.uncertain || 0);
    return by;
  }, [trend]);

  const input = {
    background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 8,
    color: C.ink, padding: "7px 10px", fontSize: 12.5,
  };
  const th = { padding: "9px 12px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" };
  const td = { padding: "8px 12px", fontSize: 12.5, whiteSpace: "nowrap" };
  const dateOf = v => (v ? String(v).slice(0, 10) : s.seg.never);

  function exportSegment() {
    const parts = [filters.stage, filters.tier, filters.sport, filters.login,
      filters.engaged ? "engaged-not-depositing" : "",
      hideRestricted ? "sin-restringidos" : ""].filter(Boolean);
    const label = parts.length ? parts.join("-") : "todos";
    const slug = label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-");
    downloadCsv(`appuesta-segmento-${slug}-${new Date().toISOString().slice(0, 10)}.csv`, CSV_COLUMNS, sorted);
  }

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>;
  if (error) return <Panel style={{ color: C.negative }}>{error}</Panel>;
  if (!players.length) return (<><SectionHeading title={s.seg.title} subtitle={s.seg.sub} /><EmptyState s={s} /></>);

  // Every stage is a threshold on days since the last deposit, counted from the
  // last day of data rather than from today -- otherwise the funnel decays on
  // its own between weekly imports. Saying which day that is keeps the counts
  // from looking like they drifted.
  const through = players[0]?.data_through;

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <SectionHeading title={s.seg.title} subtitle={s.seg.sub} />
        {through && (
          <span title={s.dataThroughHint}
            style={{ fontSize: 11.5, color: C.inkDim, border: `1px solid ${C.panelBorder}`, borderRadius: 99, padding: "4px 11px", whiteSpace: "nowrap" }}>
            {s.dataThrough.replace("{d}", fmtDay(through, lang))}
          </span>
        )}
      </div>
      {/* Two jobs, two tabs. They were stacked on one page and the movement
          list grew from a two-line box to 299 rows, which pushed the player
          table -- the reason this screen exists -- below a screen and a half
          of scrolling. Players is the default, exactly as before. */}
      <div style={{ display: "flex", gap: 4, background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 11, padding: 4, marginBottom: 14, width: "fit-content" }}>
        {[["players", s.seg.tabs.players], ["moves", s.seg.tabs.moves]].map(([v, label]) => (
          <button key={v} onClick={() => setTab(v)}
            style={{
              padding: "8px 16px", borderRadius: 8, border: "none", cursor: "pointer",
              fontSize: 13, fontWeight: tab === v ? 600 : 500,
              background: tab === v ? C.accent : "transparent",
              color: tab === v ? "#fff" : C.inkDim,
            }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "players" && (<>

      {/* Changes only the figure on each card. The list below is always the
          book as it stands, so switching this never re-sorts anybody into a
          different segment. */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ display: "flex", background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2 }}>
          {[["week", s.seg.compare.week], ["month", s.seg.compare.month]].map(([v, label]) => (
            <button key={v} onClick={() => setCompareTo(v)}
              style={{ padding: "5px 13px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, background: compareTo === v ? C.accent : "transparent", color: compareTo === v ? "#fff" : C.inkDim }}>
              {label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 11.5, color: C.inkFaint }}>
          {baselineCapture
            ? s.seg.compare.against.replace("{d}", fmtDay(baselineCapture, lang))
            : s.seg.compare.noHistory}
          {/* The delta on every card hangs off this baseline, so if the
              baseline is a reconstructed week it has to say so here, not only
              in the grid below. */}
          {baselineCapture && estimatedOn[baselineCapture] && (
            <span title={s.seg.history.estimatedHint} style={{ color: "#D9A848", marginLeft: 4 }}>*</span>
          )}
        </span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        {STAGES.map(stage => {
          const row = byStage[stage];
          const count = row ? Number(row.players) : 0;
          const selected = filters.stage === stage;
          const share = totalPlayers > 0 ? (count / totalPlayers) * 100 : 0;
          // Plain arithmetic colouring, as Marcos asked: + green, - red. It
          // used to follow the stage's meaning instead -- growth in Churned
          // painted red -- which made every delta on the page red at once and
          // read as broken. The cost is that "Perdido +44" is now green, so
          // the sign says direction and the stage says whether that is good.
          const before = baselineCapture ? baselineByStage[stage] ?? 0 : null;
          const change = before == null ? null : count - before;
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
              <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                <span style={{ fontSize: 20, fontWeight: 600, fontFamily: "'Space Grotesk', sans-serif" }}>{count}</span>
                {change != null && change !== 0 && (
                  <span style={{
                    fontSize: 12, fontWeight: 600,
                    color: change > 0 ? C.positive : C.negative,
                  }}>
                    {change > 0 ? "+" : ""}{change}
                  </span>
                )}
                {change === 0 && (
                  <span style={{ fontSize: 12, color: C.inkFaint }}>±0</span>
                )}
              </div>
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
        <label title={s.seg.hideRestrictedHint}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.inkDim, cursor: "pointer" }}>
          <input type="checkbox" checked={hideRestricted}
            onChange={e => setHideRestricted(e.target.checked)} />
          {s.seg.hideRestricted}
          <span style={{ color: C.inkFaint }}>({players.filter(p => p.restricted).length})</span>
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
              <SortHeader columns={SORT_COLUMNS} sort={sort} toggle={toggle}
                s={s} th={th} trailing={1} />
            </thead>
            <tbody>
              {sorted.map(p => (
                <tr key={p.id}>
                  <td style={{ ...td, color: C.inkFaint, fontVariantNumeric: "tabular-nums" }}>{fullPlayerId(p.id)}</td>
                  <td style={{ ...td, fontWeight: 500 }}>
                    {p.name || "—"}
                    <div style={{ fontSize: 11, color: C.inkFaint }}>{p.email || ""}</div>
                  </td>
                  <td style={td}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 99, background: STAGE_COLORS[p.lifecycle] }} />
                      {s.seg.lifecycle[p.lifecycle] || p.lifecycle}
                      {/* A banned, limited or self-excluded player is a real
                          customer whose money counts, so they are in this list
                          -- but nobody should be calling them. */}
                      {p.restricted && (
                        <span title={p.restriction_reason || s.seg.restrictedHint}
                          style={{ color: C.accent, fontSize: 10, border: `1px solid ${C.accent}66`, borderRadius: 5, padding: "1px 5px" }}>
                          {s.seg.restricted}
                        </span>
                      )}
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
                  <td style={{ ...td, color: Number(p.total_balance) > 0 ? C.positive : C.inkDim }}>
                    {p.total_balance == null ? "—" : fmtDOP(p.total_balance)}
                    {Number(p.bonus_balance) > 0 && (
                      <span style={{ color: C.inkFaint, fontSize: 11, marginLeft: 5 }}>
                        {s.vipTrack.bonusOf.replace("{amt}", fmtDOP(p.bonus_balance))}
                      </span>
                    )}
                  </td>
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
                  <td style={{ ...td, color: C.inkDim }}>
                    {dateOf(p.last_login_at)}
                    {p.days_since_login != null && (
                      <span style={{ color: C.inkFaint, fontSize: 11, marginLeft: 5 }}>
                        {s.seg.daysAgo.replace("{n}", String(p.days_since_login))}
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, color: C.inkDim }}>
                    {dateOf(p.last_bet_date)}
                    {p.days_since_bet != null && (
                      <span style={{ color: C.inkFaint, fontSize: 11, marginLeft: 5 }}>
                        {s.seg.daysAgo.replace("{n}", String(p.days_since_bet))}
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, color: C.inkDim }}>
                    {dateOf(p.last_deposit_date)}
                    {p.engaged_not_depositing && (
                          // Logged in this week but not paying: the one segment
                          // where the right action is an offer, not a win-back.
                      // Turns up but has not paid in over a week. The one case
                      // where the right move is an offer, not a win-back.
                      <span title={s.seg.engagedHint} style={{ color: "#4FA3D1", fontSize: 10, border: "1px solid #4FA3D155", borderRadius: 5, padding: "1px 5px", marginLeft: 6 }}>
                        {s.seg.engagedTag}
                      </span>
                    )}
                  </td>
                  <td style={{
                    ...td,
                    // The number the stage is now built on. Amber from eight
                    // days, red from thirty: the points where the ladder moves
                    // a player to Cooling and to Churned.
                    color: p.days_since_deposit == null ? C.inkFaint
                      : p.days_since_deposit >= 30 ? C.negative
                      : p.days_since_deposit >= 8 ? "#D9A848" : C.inkDim,
                    fontWeight: p.days_since_deposit >= 8 ? 600 : 400,
                  }}>
                    {p.days_since_deposit == null ? "—" : s.seg.daysAgo.replace("{n}", String(p.days_since_deposit))}
                  </td>
                  <td style={{ ...td, width: "1%" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {/* Two different decisions, side by side on purpose.
                          Restringir keeps the player's money in every total and
                          takes them out of the contact lists; Excluir says they
                          were never a customer and removes them from every
                          figure, backwards. */}
                      <RestrictButton player={p} s={s} onDone={load} />
                      <button
                        onClick={() => excludePlayer(p)}
                        disabled={excluding === p.id}
                        title={s.seg.excludeHint}
                        style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px", borderRadius: 7, border: `1px solid ${C.panelBorder}`, background: "transparent", color: C.inkFaint, fontSize: 11.5, cursor: excluding === p.id ? "default" : "pointer", opacity: excluding === p.id ? 0.5 : 1 }}
                      >
                        <UserMinus size={12} /> {s.seg.exclude}
                      </button>
                    </span>
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
                    {reentry.map(w => `${w.username} (${fullPlayerId(w.id)})`).join(" · ")}
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
              <span>{s.seg.watch.count.replace("{n}", watchSorted.length.toLocaleString())}</span>
              <button onClick={() => downloadCsv(
                  `appuesta-cuentas-senaladas-${new Date().toISOString().slice(0, 10)}.csv`,
                  WATCH_CSV_COLUMNS, watchSorted)}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: "none", background: C.accent, color: "#fff", fontSize: 12, cursor: "pointer" }}>
                <Download size={13} /> {s.seg.watch.export}
              </button>
            </div>

            <Panel style={{ padding: 4, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <SortHeader columns={WATCH_SORT_COLUMNS} sort={watchSort} toggle={watchToggle}
                    s={s} th={th} trailing={1} />
                </thead>
                <tbody>
                  {watchSorted.map(w => (
                    <tr key={w.id} style={{ borderTop: `1px solid ${C.panelBorder}` }}>
                      <td style={{ ...td, color: C.inkFaint, fontSize: 11.5 }}>{fullPlayerId(w.id)}</td>
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
      </>)}

      {tab === "moves" && (<>
      {/* The cards give one delta. This gives the shape: whether Active is
          still climbing or has flattened, and whether At risk is filling up
          behind it. Nine weekly cuts, the last one captured at import time and
          the rest reconstructed. */}
      {captures.length > 1 && (
        <Panel style={{ padding: 4, marginBottom: 14, overflowX: "auto" }}>
          <div style={{ padding: "10px 12px 4px", display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 13 }}>{s.seg.history.title}</strong>
            <span style={{ fontSize: 11.5, color: C.inkFaint }}>{s.seg.history.sub}</span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, position: "sticky", left: 0, background: C.panel }}>{s.seg.cols.lifecycle}</th>
                {captures.map(c => (
                  <th key={c} style={{ ...th, textAlign: "right" }}>
                    {fmtDay(c, lang).replace(/ \d{4}$/, "")}
                    {estimatedOn[c] && (
                      <span title={s.seg.history.estimatedHint} style={{ color: "#D9A848", marginLeft: 3 }}>*</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {STAGES.map(stage => {
                return (
                  <tr key={stage} style={{ borderTop: `1px solid ${C.panelBorder}` }}>
                    <td style={{ ...td, position: "sticky", left: 0, background: C.panel }}>
                      <span style={{ width: 8, height: 8, borderRadius: 99, background: STAGE_COLORS[stage], display: "inline-block", marginRight: 7 }} />
                      {s.seg.lifecycle[stage]}
                    </td>
                    {captures.map((c, i) => {
                      const n = byCapture[c]?.[stage] ?? 0;
                      const before = i === 0 ? null : (byCapture[captures[i - 1]]?.[stage] ?? 0);
                      const delta = before == null ? null : n - before;
                      return (
                        <td key={c} style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {n.toLocaleString()}
                          {delta != null && delta !== 0 && (
                            <span style={{ marginLeft: 6, fontSize: 11, color: delta > 0 ? C.positive : C.negative }}>
                              {delta > 0 ? "+" : ""}{delta}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p style={{ fontSize: 11, color: C.inkFaint, margin: "9px 12px 10px", maxWidth: 820 }}>
            {s.seg.history.note}
          </p>
        </Panel>
      )}

      {/* Who crossed a line since the previous import, and which way. The
          counts above say the funnel changed shape; this says who did it, which
          is what makes the cause findable. */}
      <div style={{ marginBottom: 20 }}>
        <SectionHeading title={s.seg.moves.title} subtitle={s.seg.moves.sub} />
        {latestMoves.length === 0 ? (
          <Panel style={{ padding: "13px 16px", fontSize: 12.5, color: C.inkDim, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span>{captures.length < 2 ? s.seg.moves.needsTwo : s.seg.moves.none}</span>
            {moveWeeks.length > 1 && (
              <select value={moveWeek || ""} onChange={e => { setMoveWeek(e.target.value); setMoveFilter(""); }}
                style={{ ...input, padding: "5px 9px", fontSize: 12 }}>
                {moveWeeks.map(c => (
                  <option key={c} value={c}>
                    {s.seg.history.weekTo.replace("{d}", fmtDay(c, lang))}{estimatedOn[c] ? " *" : ""}
                  </option>
                ))}
              </select>
            )}
          </Panel>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
              {["up", "down"].map(dir => {
                const n = latestMoves.filter(m => m.direction === dir).length;
                const on = moveFilter === dir;
                return (
                  <button key={dir} onClick={() => setMoveFilter(on ? "" : dir)}
                    style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 13px", borderRadius: 9, cursor: "pointer", background: C.panel, border: `1px solid ${on ? STAGE_MOVE_COLORS[dir] : C.panelBorder}`, color: C.ink, fontSize: 12.5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 99, background: STAGE_MOVE_COLORS[dir] }} />
                    {s.seg.moves[dir]}
                    <strong style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{n}</strong>
                  </button>
                );
              })}
              <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                {uncertainOn[moveWeek] > 0 && (
                  <span title={s.seg.history.estimatedHint} style={{ fontSize: 11.5, color: "#D9A848" }}>
                    {s.seg.history.uncertain.replace("{n}", String(uncertainOn[moveWeek]))}
                  </span>
                )}
                <span style={{ fontSize: 11.5, color: C.inkFaint }}>
                  {s.seg.moves.between
                    .replace("{from}", fmtDay(latestMoves[0].prev_captured_on, lang))
                    .replace("{to}", fmtDay(latestMoves[0].captured_on, lang))}
                </span>
                {/* Every week, not only the newest: the question is what the
                    funnel did week by week, which one capture cannot answer. */}
                {moveWeeks.length > 1 && (
                  <select value={moveWeek || ""} onChange={e => { setMoveWeek(e.target.value); setMoveFilter(""); }}
                    style={{ ...input, padding: "5px 9px", fontSize: 12 }}>
                    {moveWeeks.map(c => (
                      <option key={c} value={c}>
                        {s.seg.history.weekTo.replace("{d}", fmtDay(c, lang))}
                        {estimatedOn[c] ? " *" : ""}
                      </option>
                    ))}
                  </select>
                )}
              </span>
            </div>
            <Panel style={{ padding: 4, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {[s.seg.cols.player, s.seg.moves.from, s.seg.moves.to, s.seg.cols.tier,
                      s.seg.moves.depositsAdded, s.seg.cols.balance, s.seg.cols.lastDeposit]
                      .map(h => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {shownMoves.map(m => (
                    <tr key={`${m.player_id}|${m.captured_on}`} style={{ borderTop: `1px solid ${C.panelBorder}` }}>
                      <td style={{ ...td, fontWeight: 500 }}>
                        {m.name || m.username || fullPlayerId(m.player_id)}
                        {m.restricted && (
                          <span title={m.restriction_reason || s.seg.restrictedHint}
                            style={{ color: C.accent, fontSize: 10, border: `1px solid ${C.accent}66`, borderRadius: 5, padding: "1px 5px", marginLeft: 6 }}>
                            {s.seg.restricted}
                          </span>
                        )}
                        <div style={{ fontSize: 11, color: C.inkFaint }}>{m.email || ""}</div>
                      </td>
                      <td style={{ ...td, color: C.inkDim }}>
                        <span style={{ width: 7, height: 7, borderRadius: 99, background: STAGE_COLORS[m.prev_lifecycle], display: "inline-block", marginRight: 6 }} />
                        {s.seg.lifecycle[m.prev_lifecycle] || m.prev_lifecycle}
                      </td>
                      <td style={{ ...td, color: STAGE_MOVE_COLORS[m.direction], fontWeight: 500 }}>
                        <span style={{ width: 7, height: 7, borderRadius: 99, background: STAGE_COLORS[m.lifecycle], display: "inline-block", marginRight: 6 }} />
                        {s.seg.lifecycle[m.lifecycle] || m.lifecycle}
                      </td>
                      <td style={{ ...td, color: C.inkDim }}>{m.vip_tier || "—"}</td>
                      <td style={td}>
                        {Number(m.deposits_added) > 0 ? fmtDOP(m.deposits_added) : "—"}
                      </td>
                      <td style={{ ...td, color: Number(m.total_balance) > 0 ? C.positive : C.inkDim }}>
                        {m.total_balance == null ? "—" : fmtDOP(m.total_balance)}
                      </td>
                      <td style={{ ...td, color: C.inkDim }}>{dateOf(m.last_deposit_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <p style={{ color: C.inkFaint, fontSize: 11.5, margin: "10px 0 0", maxWidth: 700 }}>
              {s.seg.moves.note}
            </p>
          </>
        )}
      </div>
      </>)}

    </>
  );
}
