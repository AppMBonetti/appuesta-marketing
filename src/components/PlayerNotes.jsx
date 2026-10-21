import { useState } from "react";
import { Pin, PinOff, Trash2, Plus } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/AuthContext";
import { C } from "../lib/theme";
import { Spinner } from "./ui";

/**
 * The contact log for one player.
 *
 * Two things live here. A standing fact about the player — djpeti self-excluded
 * after a problem, which no backoffice column carries — and the running record
 * of the VIP advisor writing to someone and what came back. They are the same
 * shape: a dated, typed, signed entry. The difference is that a standing fact
 * gets pinned, which lifts it onto the player's row in the list so nobody has
 * to open the profile to find out they should not be calling.
 *
 * Entries are appended rather than edited. The byline and the timestamp are
 * stamped by a database trigger from the request's own token, so "Marcos wrote
 * this on the 15th" is a fact rather than something the browser asserted.
 */
export const NOTE_KINDS = ["note", "outreach", "reply", "no_reply"];

const KIND_COLORS = {
  note: "#8B93A3",
  outreach: "#6E9BF2",
  reply: "#3ECB9E",
  no_reply: "#D9A848",
};

const CHANNELS = ["whatsapp", "email", "phone", "telegram", "in_person", "other"];

/** Kinds that describe a conversation, and so have a channel worth recording. */
const HAS_CHANNEL = new Set(["outreach", "reply", "no_reply"]);

const todayISO = () => new Date().toISOString().slice(0, 10);

function fmtDay(value, lang) {
  if (!value) return null;
  return new Date(`${String(value).slice(0, 10)}T12:00:00Z`).toLocaleDateString(
    lang === "es" ? "es-DO" : "en-GB",
    { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * How long ago a note was written — against the clock, deliberately.
 *
 * Everywhere else on this dashboard a day counter anchors to `data_through`,
 * because the figure comes from a weekly import and the calendar moving is not
 * news (CLAUDE.md). A note is the opposite: it was typed by a person at a real
 * moment, so today is the right thing to measure it against.
 */
function daysAgo(value) {
  if (!value) return null;
  const then = Date.parse(`${String(value).slice(0, 10)}T12:00:00Z`);
  const now = Date.parse(`${todayISO()}T12:00:00Z`);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.round((now - then) / 86400000));
}

export function pinnedNote(notes) {
  return (notes || []).find(n => n.pinned) || null;
}

/** "1 entrada" rather than "1 entradas", which is how you spot a generated UI. */
export function countLabel(count, strings) {
  if (!count) return strings.empty;
  return count === 1 ? strings.countOne : strings.count.replace("{n}", String(count));
}

function Chip({ label, color }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5, padding: "1px 7px", borderRadius: 99,
      background: `${color}1F`, color, fontSize: 10.5, fontWeight: 600, whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

export default function PlayerNotes({ playerId, notes, s, lang, onChanged }) {
  const { member } = useAuth();
  const n = s.vipTrack.notes;

  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState("note");
  const [channel, setChannel] = useState("whatsapp");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [when, setWhen] = useState(todayISO);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Only the author can change or remove an entry, and admins can do both.
  // The database enforces this too -- this just avoids offering a button that
  // would come back refused.
  const isAdmin = member?.role === "admin";
  const mine = row => isAdmin || (member?.email && row.created_by === member.email);

  function reset() {
    setBody(""); setKind("note"); setChannel("whatsapp"); setPinned(false); setWhen(todayISO());
    setAdding(false); setError(null);
  }

  async function add() {
    if (!body.trim()) return;
    setBusy(true); setError(null);
    // created_at, created_by and updated_at are stamped by the trigger; sending
    // them from here would be both pointless and ignored.
    const { error: err } = await supabase.from("player_notes").insert({
      player_id: playerId,
      kind,
      channel: HAS_CHANNEL.has(kind) ? channel : null,
      body: body.trim(),
      pinned,
      happened_on: when || todayISO(),
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    reset();
    onChanged?.();
  }

  async function togglePin(row) {
    setBusy(true); setError(null);
    const { error: err } = await supabase
      .from("player_notes").update({ pinned: !row.pinned }).eq("id", row.id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    onChanged?.();
  }

  async function remove(row) {
    if (!window.confirm(n.confirmDelete)) return;
    setBusy(true); setError(null);
    const { error: err } = await supabase.from("player_notes").delete().eq("id", row.id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    onChanged?.();
  }

  const list = notes || [];
  const input = {
    background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 7,
    color: C.ink, padding: "6px 8px", fontSize: 12,
  };
  const ghost = {
    display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 7,
    border: `1px solid ${C.panelBorder}`, background: "#1D222B", color: C.ink, fontSize: 11.5, cursor: "pointer",
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.inkDim, letterSpacing: 0.3 }}>
          {n.heading}
        </span>
        <span style={{ fontSize: 11, color: C.inkFaint }}>{countLabel(list.length, n)}</span>
        {!adding && (
          <button onClick={() => setAdding(true)} style={{ ...ghost, marginLeft: "auto" }}>
            <Plus size={12} /> {n.add}
          </button>
        )}
      </div>

      {error && (
        <div style={{ color: C.accent, fontSize: 11.5, marginTop: 8 }}>{error}</div>
      )}

      {adding && (
        <div style={{
          marginTop: 10, padding: 12, borderRadius: 9,
          border: `1px solid ${C.panelBorder}`, background: "#141820",
        }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {NOTE_KINDS.map(k => (
              <button key={k} onClick={() => setKind(k)}
                style={{
                  padding: "4px 10px", borderRadius: 99, fontSize: 11.5, cursor: "pointer",
                  border: `1px solid ${kind === k ? KIND_COLORS[k] : C.panelBorder}`,
                  background: kind === k ? `${KIND_COLORS[k]}1F` : "transparent",
                  color: kind === k ? KIND_COLORS[k] : C.inkDim,
                }}>
                {n.kinds[k]}
              </button>
            ))}
            <input type="date" value={when} max={todayISO()}
              onChange={e => setWhen(e.target.value)}
              title={n.whenHint}
              style={{ ...input, marginLeft: "auto", minWidth: 132 }} />
          </div>

          {HAS_CHANNEL.has(kind) && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
              <span style={{ fontSize: 11.5, color: C.inkDim }}>{n.channel}</span>
              <select value={channel} onChange={e => setChannel(e.target.value)} style={{ ...input, minWidth: 140 }}>
                {CHANNELS.map(c => <option key={c} value={c}>{n.channels[c]}</option>)}
              </select>
            </div>
          )}

          <textarea
            value={body} onChange={e => setBody(e.target.value)} rows={3}
            placeholder={n.placeholder}
            style={{ ...input, width: "100%", marginTop: 9, resize: "vertical", lineHeight: 1.5, fontFamily: "inherit" }} />

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 9, flexWrap: "wrap" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: C.inkDim, cursor: "pointer" }}>
              <input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} />
              {n.pin}
            </label>
            <span style={{ fontSize: 11, color: C.inkFaint, flex: 1, minWidth: 180 }}>{n.pinHint}</span>
            <button onClick={reset} style={ghost}>{n.cancel}</button>
            <button onClick={add} disabled={busy || !body.trim()}
              style={{
                ...ghost, background: body.trim() ? C.accent : "#1D222B",
                borderColor: body.trim() ? C.accent : C.panelBorder,
                color: body.trim() ? "#fff" : C.inkFaint,
                cursor: body.trim() ? "pointer" : "default",
              }}>
              {busy ? <Spinner size={12} /> : n.save}
            </button>
          </div>
        </div>
      )}

      {list.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 10 }}>
          {list.map(row => {
            const ago = daysAgo(row.happened_on);
            return (
              <div key={row.id}
                style={{
                  display: "flex", gap: 10, padding: "9px 10px", borderRadius: 8,
                  background: row.pinned ? "#231D14" : "transparent",
                  border: `1px solid ${row.pinned ? "#D9A84844" : "transparent"}`,
                }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Chip label={n.kinds[row.kind] || row.kind} color={KIND_COLORS[row.kind] || C.inkDim} />
                    {row.channel && (
                      <span style={{ fontSize: 11, color: C.inkDim }}>{n.channels[row.channel] || row.channel}</span>
                    )}
                    <span style={{ fontSize: 11, color: C.inkFaint }}>
                      {fmtDay(row.happened_on, lang)}
                      {ago != null && ago > 0 && ` · ${s.seg.daysAgo.replace("{n}", String(ago))}`}
                    </span>
                    {row.pinned && <Pin size={11} color="#D9A848" />}
                  </div>
                  <div style={{ fontSize: 12.5, color: C.ink, marginTop: 4, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                    {row.body}
                  </div>
                  <div style={{ fontSize: 10.5, color: C.inkFaint, marginTop: 3 }}>
                    {row.created_by || n.unknownAuthor}
                  </div>
                </div>
                {mine(row) && (
                  <div style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
                    <button onClick={() => togglePin(row)} disabled={busy}
                      title={row.pinned ? n.unpin : n.pin}
                      style={{ background: "none", border: "none", color: C.inkFaint, cursor: "pointer", padding: 3 }}>
                      {row.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                    </button>
                    <button onClick={() => remove(row)} disabled={busy} title={n.delete}
                      style={{ background: "none", border: "none", color: C.inkFaint, cursor: "pointer", padding: 3 }}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
