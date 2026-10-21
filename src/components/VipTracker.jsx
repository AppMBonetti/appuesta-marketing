import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { downloadCsv } from "../lib/csv";
import { useSortedRows } from "../lib/sortRows";
import { SortHeader } from "./SortHeader";
import { Panel, Spinner, fmtDOP } from "./ui";

/**
 * The people at the top of the VIP ladder, and whether each one is still here.
 *
 * This is a named list, not a chart: there are 23 of them. The question it
 * answers is "who do I call today", so the rows are ordered by how much trouble
 * each player is in rather than by how much they are worth, and the default
 * order comes back on a third click of any header.
 *
 * The cushion column is the point of the page. A tier is recomputed on every
 * import from the trailing 90-day wagered amount, so a VIP who goes quiet does
 * not simply sit here looking inactive — they drop a tier and leave the list
 * entirely, exactly when they are the one worth a phone call. The cushion is
 * how much wagering a player can lose before that happens, so the ones about to
 * vanish are visible before they do.
 */
const STAGE_COLORS = {
  Registered: "#8B93A3", New: "#6E9BF2", Casual: "#B073F0", Active: "#3ECB9E",
  Cooling: "#D9A848", "At risk": "#F2994A", Churned: "#E4022B",
};

// Worst first: this list is read to decide who needs chasing.
const STAGE_PRIORITY = { Churned: 0, "At risk": 1, Cooling: 2, Casual: 3, New: 4, Active: 5, Registered: 6 };

const NEEDS_ATTENTION = ["Churned", "At risk", "Cooling"];

/** A cushion thinner than this share of the tier floor counts as "about to drop". */
const THIN_CUSHION = 0.25;

const CSV_COLUMNS = [
  { label: "player_id", value: p => p.id },
  { label: "username", value: p => p.username },
  { label: "email", value: p => p.email },
  { label: "vip_tier", value: p => p.vip_tier },
  { label: "lifecycle", value: p => p.lifecycle },
  { label: "days_since_deposit", value: p => p.days_since_deposit },
  { label: "days_since_login", value: p => p.days_since_login },
  { label: "days_since_bet", value: p => p.days_since_bet },
  { label: "last_deposit_date", value: p => p.last_deposit_date },
  { label: "total_deposit_amount_dop", value: p => p.deposits },
  { label: "total_deposit_count", value: p => p.deposit_count },
  { label: "ggr_dop", value: p => p.ggr },
  { label: "wagered_90d_dop", value: p => p.trailing_wager },
  { label: "tier_floor_dop", value: p => p.tierFloor },
  { label: "cushion_above_floor_dop", value: p => p.cushion },
  { label: "next_tier", value: p => p.next_tier },
  { label: "wager_to_next_tier_dop", value: p => p.wager_to_next },
];

/**
 * "MVP and above" read off the ladder rather than hardcoded, so renaming or
 * adding a tier above MVP does not quietly empty this page. Falls back to the
 * top three tiers if nothing is called MVP any more.
 */
export function vipTierNames(tiers) {
  if (!tiers?.length) return [];
  const ordered = [...tiers].sort((a, b) => Number(a.tier_order) - Number(b.tier_order));
  const mvp = ordered.find(t => t.tier_name?.toUpperCase() === "MVP");
  const from = mvp ? Number(mvp.tier_order) : Number(ordered[Math.max(0, ordered.length - 3)]?.tier_order);
  return ordered.filter(t => Number(t.tier_order) >= from).map(t => t.tier_name);
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

function Chip({ label, color }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 99,
      background: `${color}1F`, color, fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: color }} />
      {label}
    </span>
  );
}

/** "hace 3 d", or a dash when the player has never done it at all. */
function days(n, s) {
  if (n == null) return <span style={{ color: C.inkFaint }}>—</span>;
  return s.seg.daysAgo.replace("{n}", String(n));
}

const SORT_COLUMNS = [
  { key: "tier", kind: "text", label: s => s.vipTrack.cols.tier, value: p => p.tierOrder },
  { key: "player", kind: "text", label: s => s.vipTrack.cols.player, value: p => p.username || p.name || p.id },
  { key: "stage", kind: "text", label: s => s.vipTrack.cols.stage, value: p => STAGE_PRIORITY[p.lifecycle] ?? 99 },
  { key: "sinceDeposit", align: "right", label: s => s.vipTrack.cols.sinceDeposit, value: p => p.days_since_deposit },
  { key: "sinceLogin", align: "right", label: s => s.vipTrack.cols.sinceLogin, value: p => p.days_since_login },
  { key: "deposited", align: "right", label: s => s.vipTrack.cols.deposited, value: p => p.deposits },
  { key: "ggr", align: "right", label: s => s.vipTrack.cols.ggr, value: p => p.ggr },
  { key: "wager90", align: "right", label: s => s.vipTrack.cols.wager90, value: p => p.trailing_wager },
  { key: "cushion", align: "right", label: s => s.vipTrack.cols.cushion, value: p => p.cushion },
];

export default function VipTracker({ s, tiers, progress }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  const names = useMemo(() => vipTierNames(tiers), [tiers]);

  useEffect(() => {
    if (!names.length) return undefined;
    let active = true;
    (async () => {
      // Filtered server-side: this is 20-odd rows out of several thousand, and
      // player_lifecycle is the expensive view on the dashboard.
      const { data, error: err } = await supabase
        .from("player_lifecycle").select("*").in("vip_tier", names);
      if (!active) return;
      if (err) setError(err.message);
      setRows(data || []);
    })();
    return () => { active = false; };
  }, [names]);

  // The tier ladder and the progress view carry what player_lifecycle does not:
  // the floor each tier starts at, and the trailing wager measured against it.
  const enriched = useMemo(() => {
    if (!rows) return null;
    const byTier = Object.fromEntries((tiers || []).map(t => [t.tier_name, t]));
    const byId = Object.fromEntries((progress || []).map(p => [p.id, p]));
    return rows.map(r => {
      const tier = byTier[r.vip_tier];
      const prog = byId[r.id];
      const floor = Number(tier?.wager_required_dop) || 0;
      const wagered = prog?.trailing_wager == null ? null : Number(prog.trailing_wager);
      return {
        ...r,
        tierOrder: Number(tier?.tier_order) || 0,
        tierColor: tier?.color || C.accent,
        tierFloor: floor,
        trailing_wager: wagered,
        next_tier: prog?.next_tier ?? null,
        wager_to_next: prog?.wager_to_next ?? null,
        cushion: wagered == null ? null : wagered - floor,
        thinCushion: wagered != null && floor > 0 && (wagered - floor) < floor * THIN_CUSHION,
      };
    }).sort((a, b) =>
      (STAGE_PRIORITY[a.lifecycle] ?? 99) - (STAGE_PRIORITY[b.lifecycle] ?? 99)
      || Number(b.deposits || 0) - Number(a.deposits || 0));
  }, [rows, tiers, progress]);

  const { sorted, sort, toggle } = useSortedRows(enriched || [], SORT_COLUMNS);

  if (error) return <Panel style={{ color: C.negative }}>{error}</Panel>;
  if (!enriched) return <div style={{ display: "flex", justifyContent: "center", padding: 50 }}><Spinner size={20} /></div>;
  if (!enriched.length) return <Panel style={{ color: C.inkDim, fontSize: 12.5 }}>{s.vipTrack.none}</Panel>;

  const attention = enriched.filter(p => NEEDS_ATTENTION.includes(p.lifecycle));
  const dropping = enriched.filter(p => p.thinCushion);
  const groupGgr = enriched.reduce((sum, p) => sum + (Number(p.ggr) || 0), 0);
  const winning = enriched.filter(p => Number(p.ggr) < 0);

  const th = { padding: "9px 12px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" };
  const td = { padding: "9px 12px", fontSize: 12.5, whiteSpace: "nowrap" };
  const num = { textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 16 }}>
        <Tile label={s.vipTrack.kpi.count} value={enriched.length.toLocaleString()}
          note={names.join(" · ")} />
        <Tile label={s.vipTrack.kpi.attention} value={attention.length.toLocaleString()}
          tone={attention.length ? C.negative : C.positive}
          note={s.vipTrack.kpi.attentionNote} />
        <Tile label={s.vipTrack.kpi.dropping} value={dropping.length.toLocaleString()}
          tone={dropping.length ? "#D9A848" : C.positive}
          note={s.vipTrack.kpi.droppingNote} />
        <Tile label={s.vipTrack.kpi.ggr} value={fmtDOP(groupGgr)}
          tone={groupGgr < 0 ? C.negative : C.ink}
          note={winning.length ? s.vipTrack.kpi.winning.replace("{n}", String(winning.length)) : null} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 9, flexWrap: "wrap" }}>
        <p style={{ fontSize: 11.5, color: C.inkFaint, margin: 0, maxWidth: 620 }}>{s.vipTrack.windowNote}</p>
        <button
          onClick={() => downloadCsv(`appuesta-vip-${new Date().toISOString().slice(0, 10)}.csv`, CSV_COLUMNS, sorted)}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: "#1D222B", color: C.ink, fontSize: 12, cursor: "pointer" }}>
          <Download size={13} /> {s.vipTrack.export}
        </button>
      </div>

      <Panel style={{ padding: 4, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <SortHeader columns={SORT_COLUMNS} sort={sort} toggle={toggle} s={s} th={th} />
          </thead>
          <tbody>
            {sorted.map(p => (
              <tr key={p.id} style={{ borderTop: `1px solid ${C.panelBorder}` }}>
                <td style={td}><Chip label={p.vip_tier} color={p.tierColor} /></td>
                <td style={{ ...td, fontWeight: 500, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {p.username || p.name || p.id}
                  {p.has_live_hook && (
                    <span title={s.seg.liveHookHint} style={{ color: "#D9A848", fontSize: 10.5, marginLeft: 6 }}>
                      {s.seg.liveHook}
                    </span>
                  )}
                </td>
                <td style={td}>
                  <Chip label={s.seg.lifecycle[p.lifecycle] || p.lifecycle}
                    color={STAGE_COLORS[p.lifecycle] || C.inkDim} />
                </td>
                <td style={{ ...td, ...num, color: p.days_since_deposit > 7 ? C.negative : C.ink }}>
                  {days(p.days_since_deposit, s)}
                </td>
                <td style={{ ...td, ...num, color: C.inkDim }}>{days(p.days_since_login, s)}</td>
                <td style={{ ...td, ...num }}>
                  {fmtDOP(p.deposits)}
                  <span style={{ color: C.inkFaint, marginLeft: 6 }}>×{p.deposit_count ?? 0}</span>
                </td>
                {/* Negative GGR is a VIP who is beating the book — a different
                    problem from a VIP going quiet, and worth seeing as such. */}
                <td style={{ ...td, ...num, color: Number(p.ggr) < 0 ? C.negative : C.ink }}>{fmtDOP(p.ggr)}</td>
                <td style={{ ...td, ...num, color: C.inkDim }}>{fmtDOP(p.trailing_wager)}</td>
                <td style={{ ...td, ...num, color: p.thinCushion ? "#D9A848" : C.inkDim }}
                  title={s.vipTrack.cushionHint.replace("{floor}", fmtDOP(p.tierFloor)).replace("{tier}", p.vip_tier)}>
                  {p.cushion == null ? "—" : fmtDOP(p.cushion)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <p style={{ fontSize: 11.5, color: C.inkFaint, margin: "12px 0 24px", maxWidth: 720 }}>
        {s.vipTrack.cushionNote}
      </p>
    </>
  );
}
