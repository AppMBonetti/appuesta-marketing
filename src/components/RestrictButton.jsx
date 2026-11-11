import { useState } from "react";
import { Ban, RotateCcw } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { fullPlayerId } from "../lib/playerId";

/**
 * Marks a player banned, limited or self-excluded — or lifts it again.
 *
 * The badge existed on three screens before the setter did, so the only
 * restricted players were the 15 marked by hand in a migration and the filters
 * that hide them were inert for everybody else. The flag is a column on
 * `players`, reaching every view through `real_players`, so one button is the
 * label on every tab: Segments, the VIP tracker and the tier ladder all read
 * the same `restricted`.
 *
 * Deliberately not a second "Excluir". The two mean opposite things and the
 * distinction is the whole point of having both:
 *
 * - **Excluded** — never a customer. Disappears from every figure, backwards.
 * - **Restricted** — a real customer who must not be contacted. Their deposits
 *   and withdrawals stay in every total; only the contact lists drop them.
 *
 * The reason is required rather than optional. It is what shows on hover beside
 * the badge, and "do not contact" with no reason attached is exactly the kind
 * of instruction somebody overrides six weeks later.
 *
 * Failures go to an alert rather than to a page-level error state: every caller
 * renders this inside a row, and blanking a whole table because one RPC failed
 * loses the list the operator was working through.
 */
export default function RestrictButton({ player, s, onDone, compact }) {
  const [busy, setBusy] = useState(false);
  const label = player.username || player.name || fullPlayerId(player.id);

  async function apply(restricted, reason) {
    setBusy(true);
    const { error } = await supabase.rpc("set_player_restricted", {
      p_player_id: player.id, p_restricted: restricted, p_reason: reason,
    });
    setBusy(false);
    if (error) { window.alert(error.message); return; }
    onDone?.();
  }

  function onClick(e) {
    // Several of these rows sit inside a clickable <tr> that opens a drawer.
    e.stopPropagation();
    if (busy) return;
    if (player.restricted) {
      if (!window.confirm(s.seg.unrestrictConfirm.replace("{player}", label))) return;
      apply(false, null);
      return;
    }
    const reason = window.prompt(s.seg.restrictPrompt.replace("{player}", label));
    if (reason === null) return;
    // nullif(trim(...)) in the function would store a blank as null, which is a
    // badge with nothing behind it. Refuse here instead.
    if (!reason.trim()) { window.alert(s.seg.restrictNeedsReason); return; }
    apply(true, reason.trim());
  }

  const Icon = player.restricted ? RotateCcw : Ban;
  const text = player.restricted ? s.seg.unrestrict : s.seg.restrict;
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={player.restricted
        ? s.seg.unrestrictHint
        : `${s.seg.restrictHint}\n\n${s.seg.restrictedHint}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "4px 9px", borderRadius: 7,
        border: `1px solid ${player.restricted ? `${C.accent}66` : C.panelBorder}`,
        background: "transparent",
        color: player.restricted ? C.accent : C.inkFaint,
        fontSize: 11.5, whiteSpace: "nowrap",
        cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1,
      }}
    >
      <Icon size={12} />
      {!compact && text}
    </button>
  );
}
