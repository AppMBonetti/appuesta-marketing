import { useEffect, useState } from "react";
import { Undo2, AlertTriangle } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { Panel, Spinner } from "./ui";

/**
 * Rolls back the most recent InTarget import.
 *
 * Every import writes a dated snapshot of the whole players table, so the
 * previous snapshot is a complete restore point — a report that turns out to
 * disagree with the backoffice can be undone rather than lived with. Only the
 * newest snapshot can be reverted: an older one has later imports stacked on
 * top of it, and restoring it would silently discard everything since.
 */
export default function SnapshotRollback({ s, lang }) {
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    // Counted server-side: one row per snapshot rather than one per player, so
    // the list is not silently truncated by PostgREST's 1000-row response cap.
    const { data, error: err } = await supabase
      .from("snapshot_index")
      .select("snapshot_date, players")
      .order("snapshot_date", { ascending: false });
    if (err) setError(err.message);
    else setSnapshots((data || []).map(r => ({ date: r.snapshot_date, players: r.players })));
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function revert(date) {
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.rpc("revert_player_snapshot", { target_date: date });
    setBusy(false);
    setConfirming(false);
    if (err) { setError(err.message); return; }
    setResult(data);
    load();
  }

  const latest = snapshots[0];
  const canRevert = snapshots.length > 1;

  if (loading) return <Panel style={{ marginBottom: 24 }}><Spinner size={18} /></Panel>;

  return (
    <Panel style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{s.rollback.title}</div>
      <div style={{ fontSize: 12, color: C.inkFaint, marginBottom: 14, lineHeight: 1.5 }}>{s.rollback.sub}</div>

      {!latest ? (
        <div style={{ fontSize: 12.5, color: C.inkDim }}>{s.rollback.none}</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            {snapshots.slice(0, 6).map((snap, i) => (
              <div key={snap.date} style={{
                padding: "6px 11px", borderRadius: 8, fontSize: 12,
                background: i === 0 ? "#1D222B" : "transparent",
                border: `1px solid ${i === 0 ? C.accent : C.panelBorder}`,
                color: i === 0 ? C.ink : C.inkDim,
              }}>
                {snap.date} · {snap.players.toLocaleString()} {s.rollback.players}
                {i === 0 && <span style={{ color: C.accent, marginLeft: 6 }}>{s.rollback.latest}</span>}
              </div>
            ))}
          </div>

          {!canRevert ? (
            <div style={{ fontSize: 12, color: C.inkFaint }}>{s.rollback.needsTwo}</div>
          ) : !confirming ? (
            <button
              onClick={() => { setConfirming(true); setResult(null); }}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: "#1D222B", color: C.ink, fontSize: 12.5, fontWeight: 500, cursor: "pointer" }}
            >
              <Undo2 size={14} /> {s.rollback.button.replace("{date}", latest.date)}
            </button>
          ) : (
            <div style={{ background: "#2A1A16", border: `1px solid ${C.negative}55`, borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", gap: 7, fontSize: 12.5, color: C.negative, marginBottom: 12, lineHeight: 1.5 }}>
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  {s.rollback.confirm
                    .replace("{date}", latest.date)
                    .replace("{prev}", snapshots[1].date)}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => revert(latest.date)}
                  disabled={busy}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 8, border: "none", background: C.negative, color: "#fff", fontSize: 12.5, fontWeight: 500, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}
                >
                  {busy ? <Spinner /> : <Undo2 size={14} />} {s.rollback.confirmYes}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${C.panelBorder}`, background: "transparent", color: C.inkDim, fontSize: 12.5, cursor: "pointer" }}
                >
                  {s.rollback.cancel}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {result && (
        <div style={{ fontSize: 12, color: C.positive, marginTop: 12, lineHeight: 1.5 }}>
          {s.rollback.done
            .replace("{prev}", String(result.reverted_to))
            .replace("{restored}", Number(result.players_restored || 0).toLocaleString())
            .replace("{removed}", Number(result.players_removed || 0).toLocaleString())
            .replace("{unlinked}", Number(result.bets_unlinked || 0).toLocaleString())}
        </div>
      )}
      {error && (
        <div style={{ fontSize: 12, color: C.negative, marginTop: 12 }}>{error}</div>
      )}
      <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 12, lineHeight: 1.5 }}>
        {lang === "es"
          ? "Las apuestas de Altenar no se tocan: son otra fuente. Solo pierden el vínculo al jugador si ese jugador desaparece con el reporte revertido."
          : "Altenar bets are left alone — they are a separate source. They only lose their player link if that player disappears with the reverted report."}
      </div>
    </Panel>
  );
}
