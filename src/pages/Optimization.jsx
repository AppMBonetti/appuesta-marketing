import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { SectionHeading, Panel, Spinner, EmptyState } from "../components/ui";

export default function Optimization({ s, lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    const { data, error } = await supabase
      .from("optimization_notes")
      .select("*")
      .order("note_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) setError(error.message); else setNotes(data || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function addNote() {
    if (!noteDraft.trim()) return;
    setSubmitting(true);
    const { error } = await supabase.from("optimization_notes").insert({ note: noteDraft.trim(), status: "testing" });
    setSubmitting(false);
    if (error) { setError(error.message); return; }
    setNoteDraft("");
    load();
  }

  async function removeNote(id) {
    const { error } = await supabase.from("optimization_notes").delete().eq("id", id);
    if (error) { setError(error.message); return; }
    setNotes(prev => prev.filter(n => n.id !== id));
  }

  async function cycleStatus(note) {
    const order = ["testing", "working", "notWorking"];
    const next = order[(order.indexOf(note.status) + 1) % order.length];
    setNotes(prev => prev.map(n => n.id === note.id ? { ...n, status: next } : n));
    const { error } = await supabase.from("optimization_notes").update({ status: next }).eq("id", note.id);
    if (error) setError(error.message);
  }

  return (
    <>
      <SectionHeading title={s.optTitle} subtitle={s.optSub} />
      <Panel style={{ marginBottom: 18 }}>
        <textarea value={noteDraft} onChange={e => setNoteDraft(e.target.value)} placeholder={s.optPlaceholder} style={{ width: "100%", minHeight: 70, background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 9, color: C.ink, padding: 12, fontSize: 13, resize: "vertical", fontFamily: "inherit" }} />
        <button onClick={addNote} disabled={submitting} style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, border: "none", background: C.accent, color: "#fff", fontSize: 13, fontWeight: 500, cursor: submitting ? "default" : "pointer", opacity: submitting ? 0.7 : 1 }}>
          {submitting ? <Spinner /> : <Plus size={14} />} {s.optAdd}
        </button>
      </Panel>

      {error && <Panel style={{ color: C.negative, marginBottom: 16 }}>{error}</Panel>}
      {loading && <div style={{ display: "flex", justifyContent: "center", padding: 40 }}><Spinner size={22} /></div>}

      {!loading && notes.length === 0 ? <EmptyState s={s} /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {notes.map((n) => (
            <div key={n.id} style={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 12, padding: "14px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: C.inkFaint }}>{new Date(n.note_date).toLocaleDateString(lang === "es" ? "es-DO" : "en-US", { day: "numeric", month: "short", year: "numeric" })}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button onClick={() => cycleStatus(n)} style={{ border: "none", cursor: "pointer", fontSize: 11, padding: "2px 9px", borderRadius: 6, background: n.status === "working" ? C.positiveSoft : n.status === "notWorking" ? "#2C1B1A" : "#241A0E", color: n.status === "working" ? C.positive : n.status === "notWorking" ? C.negative : "#D9A848" }}>{s.optStatus[n.status]}</button>
                  <button onClick={() => { if (window.confirm(s.confirmDeleteNote)) removeNote(n.id); }} style={{ border: "none", background: "transparent", cursor: "pointer", color: C.inkFaint, display: "flex" }}><Trash2 size={13} /></button>
                </div>
              </div>
              <div style={{ fontSize: 13.5, color: C.ink }}>{n.note}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
