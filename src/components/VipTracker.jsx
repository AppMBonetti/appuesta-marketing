import { useEffect, useMemo, useState } from "react";
import { Download, ChevronRight, ChevronDown, Mail, Pin, MessageSquare } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { downloadCsv } from "../lib/csv";
import { useSortedRows } from "../lib/sortRows";
import { SortHeader } from "./SortHeader";
import PlayerNotes, { pinnedNote, countLabel } from "./PlayerNotes";
import { Panel, Spinner, fmtDOP } from "./ui";

/**
 * The people at the top of the VIP ladder, and whether each one is still here.
 *
 * A named list rather than a chart: there are 23 of them, grouped by lifecycle
 * stage so the ones worth a call sit together at the top. Each row opens into
 * everything the dashboard holds about that player, because the question this
 * page answers is not "how are VIPs doing" but "who do I ring, and what do I
 * say".
 *
 * Two numbers here are not in the Segments table and change the picture:
 *
 * - **Net** is deposits minus withdrawals. Tomas36 has deposited 395,858 and
 *   withdrawn 600,000; the deposit column alone ranks him fifth-best.
 * - **Cushion** is how much wagering a player can lose before dropping a tier.
 *   Tiers come from trailing 90-day wagering, so a VIP who goes quiet does not
 *   sit here looking inactive — they leave the list.
 */
const STAGE_COLORS = {
  Registered: "#8B93A3", New: "#6E9BF2", Casual: "#B073F0", Active: "#3ECB9E",
  Cooling: "#D9A848", "At risk": "#F2994A", Churned: "#E4022B",
};

// Worst first: this page is read to decide who needs chasing today.
const STAGE_ORDER = ["Churned", "At risk", "Cooling", "Casual", "New", "Active", "Registered"];
const NEEDS_ATTENTION = ["Churned", "At risk", "Cooling"];

/** A cushion thinner than this share of the tier floor counts as "about to drop". */
const THIN_CUSHION = 0.25;

const CSV_COLUMNS = [
  { label: "player_id", value: p => p.id },
  { label: "username", value: p => p.username },
  { label: "email", value: p => p.email },
  { label: "vip_tier", value: p => p.vip_tier },
  { label: "lifecycle", value: p => p.lifecycle },
  { label: "last_deposit_date", value: p => p.last_deposit_date },
  { label: "days_since_deposit", value: p => p.days_since_deposit },
  { label: "last_login", value: p => p.last_login_at },
  { label: "days_since_login", value: p => p.days_since_login },
  { label: "last_bet_date", value: p => p.last_bet_date },
  { label: "last_withdrawal_date", value: p => p.last_withdrawal_date },
  { label: "deposited_dop", value: p => p.deposits },
  { label: "deposit_count", value: p => p.deposit_count },
  { label: "withdrawn_dop", value: p => p.withdrawn },
  { label: "withdrawal_count", value: p => p.total_withdrawal_count },
  { label: "net_dop", value: p => p.net },
  { label: "ggr_dop", value: p => p.ggr },
  { label: "cashback_dop", value: p => p.cashback },
  { label: "bonus_to_cash_dop", value: p => p.bonus_to_cash },
  { label: "bets", value: p => p.bets },
  { label: "total_stake_dop", value: p => p.total_stake },
  { label: "avg_bet_dop", value: p => p.avg_stake },
  { label: "median_bet_dop", value: p => p.median_stake },
  { label: "cashed_out_count", value: p => p.cashed_out_count },
  { label: "open_bets", value: p => p.open_bets },
  { label: "sports", value: p => (p.sports || []).map(s => `${s.sport} ${s.share_pct}%`).join(" | ") },
  { label: "wagered_90d_dop", value: p => p.trailing_wager },
  { label: "tier_floor_dop", value: p => p.tierFloor },
  { label: "cushion_dop", value: p => p.cushion },
  { label: "country", value: p => p.country },
  { label: "registered_at", value: p => p.registered_at },
  { label: "notes", value: p => p.notes.length },
  // The pinned note is the one that changes whether you contact someone, so it
  // belongs in the export too and not only on screen.
  { label: "pinned_note", value: p => p.pinned?.body || "" },
];

/**
 * "MVP and above" read off the ladder rather than hardcoded, so renaming or
 * adding a tier above MVP does not quietly empty this page.
 */
export function vipTierNames(tiers) {
  if (!tiers?.length) return [];
  const ordered = [...tiers].sort((a, b) => Number(a.tier_order) - Number(b.tier_order));
  const mvp = ordered.find(t => t.tier_name?.toUpperCase() === "MVP");
  const from = mvp ? Number(mvp.tier_order) : Number(ordered[Math.max(0, ordered.length - 3)]?.tier_order);
  return ordered.filter(t => Number(t.tier_order) >= from).map(t => t.tier_name);
}

function fmtDay(value, lang) {
  if (!value) return null;
  return new Date(`${String(value).slice(0, 10)}T12:00:00Z`).toLocaleDateString(
    lang === "es" ? "es-DO" : "en-GB",
    { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function Tile({ label, value, tone, note }) {
  return (
    <Panel style={{ flex: "1 1 170px", minWidth: 150 }}>
      <div style={{ fontSize: 11, color: C.inkDim }}>{label}</div>
      <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 24, fontWeight: 600, marginTop: 4, color: tone || C.ink }}>
        {value}
      </div>
      {note && <div style={{ fontSize: 11.5, color: C.inkDim, marginTop: 2 }}>{note}</div>}
    </Panel>
  );
}

function Chip({ label, color, subtle }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 99,
      background: subtle ? "transparent" : `${color}1F`, color,
      border: subtle ? `1px solid ${color}55` : "none",
      fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap",
    }}>
      {!subtle && <span style={{ width: 6, height: 6, borderRadius: 99, background: color }} />}
      {label}
    </span>
  );
}

/** A date with how long ago it was, which is the pair that drives a decision. */
function WhenCell({ date, days, s, lang, warnOver }) {
  if (!date) return <span style={{ color: C.inkFaint }}>—</span>;
  const late = warnOver != null && days != null && days > warnOver;
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div style={{ color: late ? C.negative : C.ink }}>{fmtDay(date, lang)}</div>
      <div style={{ fontSize: 11, color: late ? C.negative : C.inkFaint }}>
        {days == null ? "" : s.seg.daysAgo.replace("{n}", String(days))}
      </div>
    </div>
  );
}

function Field({ label, value, tone }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 12.5, color: tone || C.ink, marginTop: 2 }}>
        {value == null || value === "" ? <span style={{ color: C.inkFaint }}>—</span> : value}
      </div>
    </div>
  );
}

const SORT_COLUMNS = [
  { key: "tier", kind: "text", label: s => s.vipTrack.cols.tier, value: p => p.tierOrder },
  { key: "player", kind: "text", label: s => s.vipTrack.cols.player, value: p => p.username || p.name || p.id },
  { key: "lastDeposit", kind: "date", label: s => s.vipTrack.cols.lastDeposit, value: p => p.last_deposit_date },
  { key: "lastLogin", kind: "date", label: s => s.vipTrack.cols.lastLogin, value: p => p.last_login_at },
  { key: "deposited", align: "right", label: s => s.vipTrack.cols.deposited, value: p => p.deposits },
  { key: "withdrawn", align: "right", label: s => s.vipTrack.cols.withdrawn, value: p => p.withdrawn },
  { key: "net", align: "right", label: s => s.vipTrack.cols.net, value: p => p.net },
  { key: "ggr", align: "right", label: s => s.vipTrack.cols.ggr, value: p => p.ggr },
  { key: "sports", kind: "text", label: s => s.vipTrack.cols.sports, value: p => p.top_sport },
  { key: "cushion", align: "right", label: s => s.vipTrack.cols.cushion, value: p => p.cushion },
];

export default function VipTracker({ s, lang, tiers, progress }) {
  const [rows, setRows] = useState(null);
  const [sports, setSports] = useState({});
  const [extra, setExtra] = useState({});
  const [notes, setNotes] = useState({});
  const [ids, setIds] = useState([]);
  // Bumped when a note is added, pinned or removed, which re-runs the notes
  // fetch alone rather than reloading player_lifecycle behind it.
  const [notesTick, setNotesTick] = useState(0);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  const names = useMemo(() => vipTierNames(tiers), [tiers]);

  useEffect(() => {
    if (!names.length) return undefined;
    let active = true;
    (async () => {
      // Filtered server-side: 23 rows out of several thousand, and
      // player_lifecycle is the expensive view on this dashboard.
      const { data, error: err } = await supabase
        .from("player_lifecycle").select("*").in("vip_tier", names);
      if (!active) return;
      if (err) { setError(err.message); return; }
      const list = data || [];
      setRows(list);

      const ids = list.map(r => r.id);
      if (!ids.length) return;
      setIds(ids);

      // The sport mix and the withdrawal/bonus columns live outside
      // player_lifecycle; both are fetched only for the handful shown here.
      const [mix, pl] = await Promise.all([
        supabase.from("player_sport_mix").select("*").in("id", ids),
        supabase.from("players")
          .select("id, country, total_withdrawal_amount, total_withdrawal_count, last_withdrawal_date, cashed_out_count, bonus_to_cash, first_deposit_amount")
          .in("id", ids),
      ]);
      if (!active) return;
      if (!mix.error) {
        const byPlayer = {};
        for (const row of mix.data || []) (byPlayer[row.id] ||= []).push(row);
        for (const key of Object.keys(byPlayer)) {
          byPlayer[key].sort((a, b) => Number(b.bets) - Number(a.bets));
        }
        setSports(byPlayer);
      }
      if (!pl.error) setExtra(Object.fromEntries((pl.data || []).map(p => [p.id, p])));
    })();
    return () => { active = false; };
  }, [names]);

  // Notes load on their own so that adding one re-reads a tiny table rather
  // than player_lifecycle, which is the expensive view on this dashboard.
  useEffect(() => {
    if (!ids.length) return undefined;
    let active = true;
    (async () => {
      const { data, error: err } = await supabase
        .from("player_notes").select("*").in("player_id", ids)
        .order("pinned", { ascending: false })
        .order("happened_on", { ascending: false })
        .order("id", { ascending: false });
      if (!active || err) return;
      const byPlayer = {};
      for (const row of data || []) (byPlayer[row.player_id] ||= []).push(row);
      setNotes(byPlayer);
    })();
    return () => { active = false; };
  }, [ids, notesTick]);

  const enriched = useMemo(() => {
    if (!rows) return null;
    const byTier = Object.fromEntries((tiers || []).map(t => [t.tier_name, t]));
    const byId = Object.fromEntries((progress || []).map(p => [p.id, p]));
    return rows.map(r => {
      const tier = byTier[r.vip_tier];
      const prog = byId[r.id];
      const ex = extra[r.id] || {};
      const floor = Number(tier?.wager_required_dop) || 0;
      const wagered = prog?.trailing_wager == null ? null : Number(prog.trailing_wager);
      const withdrawn = ex.total_withdrawal_amount == null ? null : Number(ex.total_withdrawal_amount);
      return {
        ...r, ...ex,
        tierOrder: Number(tier?.tier_order) || 0,
        tierColor: tier?.color || C.accent,
        tierFloor: floor,
        trailing_wager: wagered,
        next_tier: prog?.next_tier ?? null,
        wager_to_next: prog?.wager_to_next ?? null,
        cushion: wagered == null ? null : wagered - floor,
        thinCushion: wagered != null && floor > 0 && (wagered - floor) < floor * THIN_CUSHION,
        withdrawn,
        // Deposits alone overstate what a player is worth once they take money
        // back out, so the net sits beside it rather than replacing it.
        net: withdrawn == null ? null : Number(r.deposits || 0) - withdrawn,
        sports: sports[r.id] || [],
        notes: notes[r.id] || [],
        pinned: pinnedNote(notes[r.id]),
      };
    });
  }, [rows, tiers, progress, sports, extra, notes]);

  const { sorted, sort, toggle } = useSortedRows(enriched || [], SORT_COLUMNS);

  if (error) return <Panel style={{ color: C.negative }}>{error}</Panel>;
  if (!enriched) return <div style={{ display: "flex", justifyContent: "center", padding: 50 }}><Spinner size={20} /></div>;
  if (!enriched.length) return <Panel style={{ color: C.inkDim, fontSize: 12.5 }}>{s.vipTrack.none}</Panel>;

  const through = enriched[0]?.data_through;
  const attention = enriched.filter(p => NEEDS_ATTENTION.includes(p.lifecycle));
  const dropping = enriched.filter(p => p.thinCushion);
  const groupNet = enriched.reduce((sum, p) => sum + (Number(p.net) || 0), 0);
  const negativeNet = enriched.filter(p => Number(p.net) < 0);

  // Grouped rather than one flat list: the stage is the first thing that
  // decides whether a player needs anything at all. Sorting still applies, but
  // inside each group.
  const groups = STAGE_ORDER
    .map(stage => ({ stage, players: sorted.filter(p => p.lifecycle === stage) }))
    .filter(g => g.players.length);

  const th = { padding: "9px 12px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" };
  const td = { padding: "9px 12px", fontSize: 12.5, whiteSpace: "nowrap", verticalAlign: "top" };
  const num = { textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const colCount = SORT_COLUMNS.length + 1;

  return (
    <>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 16 }}>
        <Tile label={s.vipTrack.kpi.count} value={enriched.length.toLocaleString()} note={names.join(" · ")} />
        <Tile label={s.vipTrack.kpi.attention} value={attention.length.toLocaleString()}
          tone={attention.length ? C.negative : C.positive} note={s.vipTrack.kpi.attentionNote} />
        <Tile label={s.vipTrack.kpi.dropping} value={dropping.length.toLocaleString()}
          tone={dropping.length ? "#D9A848" : C.positive} note={s.vipTrack.kpi.droppingNote} />
        <Tile label={s.vipTrack.kpi.net} value={fmtDOP(groupNet)}
          tone={groupNet < 0 ? C.negative : C.ink}
          note={negativeNet.length ? s.vipTrack.kpi.negativeNet.replace("{n}", String(negativeNet.length)) : s.vipTrack.kpi.netNote} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 9, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {through && (
            <span title={s.dataThroughHint}
              style={{ fontSize: 11.5, color: C.inkDim, border: `1px solid ${C.panelBorder}`, borderRadius: 99, padding: "4px 11px", whiteSpace: "nowrap" }}>
              {s.dataThrough.replace("{d}", fmtDay(through, lang))}
            </span>
          )}
          <p style={{ fontSize: 11.5, color: C.inkFaint, margin: 0, maxWidth: 520 }}>{s.vipTrack.rowHint}</p>
        </div>
        <button
          onClick={() => downloadCsv(`appuesta-vip-${new Date().toISOString().slice(0, 10)}.csv`, CSV_COLUMNS, sorted)}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: "#1D222B", color: C.ink, fontSize: 12, cursor: "pointer" }}>
          <Download size={13} /> {s.vipTrack.export}
        </button>
      </div>

      <Panel style={{ padding: 4, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <SortHeader columns={SORT_COLUMNS} sort={sort} toggle={toggle} s={s} th={th} trailing={1} />
          </thead>
          {groups.map(({ stage, players }) => {
            const color = STAGE_COLORS[stage] || C.inkDim;
            return (
              <tbody key={stage}>
                <tr>
                  <td colSpan={colCount} style={{ padding: "14px 12px 7px", borderTop: `1px solid ${C.panelBorder}` }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                      <Chip label={s.seg.lifecycle[stage] || stage} color={color} />
                      <span style={{ fontSize: 12, color: C.inkDim }}>
                        {players.length} · {s.seg.desc[stage]?.split(".")[0] || ""}
                      </span>
                    </span>
                  </td>
                </tr>
                {players.map(p => {
                  const isOpen = open === p.id;
                  return (
                    <Row key={p.id} p={p} s={s} lang={lang} td={td} num={num}
                      isOpen={isOpen} colCount={colCount}
                      onNotesChanged={() => setNotesTick(t => t + 1)}
                      onToggle={() => setOpen(isOpen ? null : p.id)} />
                  );
                })}
              </tbody>
            );
          })}
        </table>
      </Panel>
      <p style={{ fontSize: 11.5, color: C.inkFaint, margin: "12px 0 6px", maxWidth: 760 }}>{s.vipTrack.windowNote}</p>
      <p style={{ fontSize: 11.5, color: C.inkFaint, margin: "0 0 24px", maxWidth: 760 }}>{s.vipTrack.missingNote}</p>
    </>
  );
}

function Row({ p, s, lang, td, num, isOpen, onToggle, onNotesChanged, colCount }) {
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  const top = p.sports[0];
  const rest = p.sports.length - 1;
  return (
    <>
      <tr onClick={onToggle}
        style={{ borderTop: `1px solid ${C.panelBorder}`, cursor: "pointer", background: isOpen ? "#1A1F28" : "transparent" }}>
        <td style={td}><Chip label={p.vip_tier} color={p.tierColor} /></td>
        <td style={{ ...td, fontWeight: 500, maxWidth: 230 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Chevron size={13} color={C.inkFaint} style={{ flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p.username || p.name || p.id}</span>
            {p.has_live_hook && (
              <span title={s.seg.liveHookHint} style={{ color: "#D9A848", fontSize: 10.5 }}>{s.seg.liveHook}</span>
            )}
            {p.notes.length > 0 && !p.pinned && (
              <span title={countLabel(p.notes.length, s.vipTrack.notes)}
                style={{ display: "inline-flex", alignItems: "center", gap: 2, color: C.inkFaint, fontSize: 10.5 }}>
                <MessageSquare size={11} /> {p.notes.length}
              </span>
            )}
          </span>
          <div style={{ fontSize: 11, color: C.inkFaint, marginLeft: 19, overflow: "hidden", textOverflow: "ellipsis" }}>
            {p.email || ""}
          </div>
          {/* A pinned note is the whole point of pinning: it has to be readable
              without opening the row, or the person who needed it will not see
              it before picking up the phone. */}
          {p.pinned && (
            <div title={p.pinned.body}
              style={{
                display: "flex", alignItems: "center", gap: 4, marginLeft: 19, marginTop: 3,
                fontSize: 11, color: "#D9A848", maxWidth: 210,
              }}>
              <Pin size={10} style={{ flexShrink: 0 }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.pinned.body}
              </span>
            </div>
          )}
        </td>
        <td style={td}><WhenCell date={p.last_deposit_date} days={p.days_since_deposit} s={s} lang={lang} warnOver={7} /></td>
        <td style={td}><WhenCell date={p.last_login_at} days={p.days_since_login} s={s} lang={lang} /></td>
        <td style={{ ...td, ...num }}>
          {fmtDOP(p.deposits)}
          <div style={{ fontSize: 11, color: C.inkFaint }}>×{p.deposit_count ?? 0}</div>
        </td>
        <td style={{ ...td, ...num, color: C.inkDim }}>
          {fmtDOP(p.withdrawn)}
          <div style={{ fontSize: 11, color: C.inkFaint }}>×{p.total_withdrawal_count ?? 0}</div>
        </td>
        {/* Net is the one that says what a player is actually worth. */}
        <td style={{ ...td, ...num, fontWeight: 600, color: Number(p.net) < 0 ? C.negative : C.ink }}>{fmtDOP(p.net)}</td>
        <td style={{ ...td, ...num, color: Number(p.ggr) < 0 ? C.negative : C.ink }}>{fmtDOP(p.ggr)}</td>
        <td style={td}>
          {top
            ? <>
                {top.sport} <span style={{ color: C.inkFaint }}>{Math.round(Number(top.share_pct))}%</span>
                {rest > 0 && <span style={{ color: C.inkFaint }}> {s.vipTrack.moreSports.replace("{n}", String(rest))}</span>}
              </>
            : <span style={{ color: C.inkFaint }}>—</span>}
        </td>
        <td style={{ ...td, ...num, color: p.thinCushion ? "#D9A848" : C.inkDim }}>
          {p.cushion == null ? "—" : fmtDOP(p.cushion)}
          <div style={{ fontSize: 11, color: C.inkFaint }}>{s.vipTrack.floorShort} {fmtDOP(p.tierFloor)}</div>
        </td>
        <td style={td} />
      </tr>
      {isOpen && (
        <tr style={{ background: "#1A1F28" }}>
          <td colSpan={colCount} style={{ padding: "4px 12px 18px 31px" }}>
            <Detail p={p} s={s} lang={lang} onNotesChanged={onNotesChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ p, s, lang, onNotesChanged }) {
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "14px 18px", marginTop: 10 };
  const heading = { fontSize: 11, fontWeight: 600, color: C.inkDim, marginTop: 16, letterSpacing: 0.3 };
  const d = s.vipTrack.detail;
  return (
    <div style={{ maxWidth: 1100 }}>
      {/* First, not last: what someone wrote about this player changes how you
          read everything underneath it. */}
      <PlayerNotes playerId={p.id} notes={p.notes} s={s} lang={lang} onChanged={onNotesChanged} />

      <div style={heading}>{d.contact}</div>
      <div style={grid}>
        <Field label={d.email} value={p.email
          ? <a href={`mailto:${p.email}`} onClick={e => e.stopPropagation()}
              style={{ color: C.accent, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Mail size={12} /> {p.email}
            </a>
          : null} />
        <Field label={d.username} value={p.username} />
        <Field label={d.country} value={p.country} />
        <Field label={d.playerId} value={p.id} />
      </div>

      <div style={heading}>{d.money}</div>
      <div style={grid}>
        <Field label={d.deposited} value={`${fmtDOP(p.deposits)} · ×${p.deposit_count ?? 0}`} />
        <Field label={d.withdrawn} value={`${fmtDOP(p.withdrawn)} · ×${p.total_withdrawal_count ?? 0}`} />
        <Field label={d.net} value={fmtDOP(p.net)} tone={Number(p.net) < 0 ? C.negative : C.positive} />
        <Field label={d.ggr} value={fmtDOP(p.ggr)} tone={Number(p.ggr) < 0 ? C.negative : null} />
        <Field label={d.firstDeposit} value={p.first_deposit_amount == null ? null : fmtDOP(p.first_deposit_amount)} />
        <Field label={d.cashback} value={fmtDOP(p.cashback)} />
        <Field label={d.bonusToCash} value={p.bonus_to_cash == null ? null : fmtDOP(p.bonus_to_cash)} />
      </div>

      <div style={heading}>{d.betting}</div>
      <div style={grid}>
        <Field label={d.bets} value={Number(p.bets || 0).toLocaleString()} />
        <Field label={d.stake} value={fmtDOP(p.total_stake)} />
        <Field label={d.avgBet} value={fmtDOP(p.avg_stake)} />
        <Field label={d.medianBet} value={fmtDOP(p.median_stake)} />
        <Field label={d.cashouts} value={p.cashed_out_count == null ? null : Number(p.cashed_out_count).toLocaleString()} />
        <Field label={d.openBets} value={Number(p.open_bets || 0).toLocaleString()} />
        <Field label={d.wager90} value={fmtDOP(p.trailing_wager)} />
        <Field label={d.toNext} value={p.next_tier ? `${fmtDOP(p.wager_to_next)} → ${p.next_tier}` : d.topTier} />
      </div>

      <div style={heading}>{d.dates}</div>
      <div style={grid}>
        <Field label={d.registered} value={fmtDay(p.registered_at, lang)} />
        <Field label={d.firstDepositDate} value={fmtDay(p.first_deposit_date, lang)} />
        <Field label={d.lastDeposit} value={fmtDay(p.last_deposit_date, lang)} />
        <Field label={d.lastWithdrawal} value={fmtDay(p.last_withdrawal_date, lang)} />
        <Field label={d.lastBet} value={fmtDay(p.last_bet_date, lang)} />
        <Field label={d.lastLogin} value={fmtDay(p.last_login_at, lang)} />
      </div>

      {p.sports.length > 0 && (
        <>
          <div style={heading}>{d.sports}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10, maxWidth: 520 }}>
            {p.sports.map(sp => (
              <div key={sp.sport} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                <span style={{ width: 130, color: C.ink }}>{sp.sport}</span>
                <span style={{ flex: 1, background: "#242933", borderRadius: 6, height: 7 }}>
                  <span style={{ display: "block", width: `${Math.min(Number(sp.share_pct), 100)}%`, height: "100%", borderRadius: 6, background: C.accent }} />
                </span>
                <span style={{ width: 46, textAlign: "right", color: C.inkDim, fontVariantNumeric: "tabular-nums" }}>
                  {Math.round(Number(sp.share_pct))}%
                </span>
                <span style={{ width: 92, textAlign: "right", color: C.inkFaint, fontVariantNumeric: "tabular-nums" }}>
                  {fmtDOP(sp.stake)}
                </span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11, color: C.inkFaint, margin: "8px 0 0", maxWidth: 520 }}>{d.sportsNote}</p>
        </>
      )}
    </div>
  );
}
