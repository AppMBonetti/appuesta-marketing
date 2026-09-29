import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Download, HandCoins, Handshake, Pencil, Plus, Receipt, Trash2,
  TrendingUp, UploadCloud, UserCheck, UserPlus, Wallet, X,
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { KpiCard, Panel, SectionHeading, Spinner, fmtDOP } from "../components/ui";
import { downloadCsv } from "../lib/csv";
import { parseAffiliateReportFile } from "../lib/importers/affiliateReport";
import { upsertInChunks } from "../lib/importers/parseWorkbook";
import { AFF_STRINGS } from "../lib/i18nAffiliates";

const inputStyle = {
  background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 7,
  color: C.ink, padding: "7px 10px", fontSize: 12.5,
};
const btn = (primary) => ({
  display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 13px", borderRadius: 8,
  border: primary ? "none" : `1px solid ${C.panelBorder}`, cursor: "pointer", fontSize: 12.5, fontWeight: 600,
  background: primary ? C.accent : "transparent", color: primary ? "#fff" : C.inkDim,
});
const thStyle = { padding: "9px 12px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap", borderBottom: `1px solid ${C.panelBorder}` };
const tdStyle = { padding: "9px 12px", fontSize: 12.5, whiteSpace: "nowrap", borderBottom: `1px solid ${C.panelBorder}` };
const num = { textAlign: "right", fontVariantNumeric: "tabular-nums" };

const fmtInt = n => Number(n || 0).toLocaleString("es-DO");
const fmtPct = (a, b) => (Number(b) > 0 ? `${((Number(a) / Number(b)) * 100).toFixed(1)}%` : "—");

function fmtDate(value, lang) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(lang === "es" ? "es-DO" : "en-US", { day: "numeric", month: "short", year: "numeric" });
}

/** "20% GGR + DOP 500 / FTD" — the deal as it is agreed, in one line. */
function dealLabel(a, t) {
  const parts = [];
  if (Number(a.commission_pct) > 0) parts.push(`${Number(a.commission_pct)}% ${t.ofGgr}`);
  if (Number(a.cpa_amount) > 0) parts.push(`${fmtDOP(a.cpa_amount)} / FTD`);
  return parts.join(" + ") || t.noDeal;
}

// Totals across affiliates are plain sums: a player belongs to one affiliate.
function totalsOf(rows) {
  const keys = ["registrations", "ftds", "deposit_amount", "ggr", "commission", "paid", "balance"];
  const out = Object.fromEntries(keys.map(k => [k, 0]));
  for (const r of rows) for (const k of keys) out[k] += Number(r[k]) || 0;
  return out;
}

function KpiRow({ t, totals }) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
      <KpiCard icon={UserPlus} label={t.kpi.registrations} value={fmtInt(totals.registrations)} />
      <KpiCard icon={UserCheck} label={t.kpi.ftds} value={fmtInt(totals.ftds)} delta={`${fmtPct(totals.ftds, totals.registrations)} ${t.kpi.conversion}`} />
      <KpiCard icon={Wallet} label={t.kpi.deposits} value={fmtDOP(totals.deposit_amount)} />
      <KpiCard icon={TrendingUp} label={t.kpi.ggr} value={fmtDOP(totals.ggr)} />
      <KpiCard icon={HandCoins} label={t.kpi.commission} value={fmtDOP(totals.commission)} />
      <KpiCard icon={Receipt} label={t.kpi.balance} value={fmtDOP(totals.balance)} delta={`${t.kpi.paid} ${fmtDOP(totals.paid)}`} deltaGood={Number(totals.balance) <= 0} />
    </div>
  );
}

function AffiliateForm({ t, initial, onSaved, onCancel }) {
  const editing = !!initial;
  const [form, setForm] = useState(() => ({
    code: initial?.code ?? "", name: initial?.name ?? "",
    commission_pct: initial?.commission_pct ?? "", cpa_amount: initial?.cpa_amount ?? "",
    active: initial?.active ?? true, notes: initial?.notes ?? "",
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    const code = form.code.trim().toUpperCase();
    const pct = Number(form.commission_pct || 0);
    if (!code || !form.name.trim()) { setError(t.form.required); return; }
    if (!(pct >= 0 && pct <= 100)) { setError(t.form.pctRange); return; }
    setSaving(true);
    setError(null);
    const row = {
      code, name: form.name.trim(), commission_pct: pct,
      cpa_amount: Number(form.cpa_amount || 0), active: form.active, notes: form.notes.trim() || null,
    };
    const { error: err } = editing
      ? await supabase.from("affiliates").update(row).eq("code", initial.code)
      : await supabase.from("affiliates").insert(row);
    setSaving(false);
    if (err) { setError(err.code === "23505" ? t.form.duplicate : err.message); return; }
    onSaved(code);
  }

  const label = { fontSize: 11.5, color: C.inkDim, display: "flex", flexDirection: "column", gap: 5 };
  return (
    <Panel style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>{editing ? t.form.editTitle : t.form.newTitle}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12 }}>
        <label style={label}>{t.form.code}
          <input style={inputStyle} value={form.code} onChange={e => set("code", e.target.value)} placeholder="JUANPEREZ" disabled={editing} />
        </label>
        <label style={label}>{t.form.name}
          <input style={inputStyle} value={form.name} onChange={e => set("name", e.target.value)} />
        </label>
        <label style={label}>{t.form.pct}
          <input style={inputStyle} type="number" min="0" max="100" step="0.5" value={form.commission_pct} onChange={e => set("commission_pct", e.target.value)} placeholder="20" />
        </label>
        <label style={label}>{t.form.cpa}
          <input style={inputStyle} type="number" min="0" step="50" value={form.cpa_amount} onChange={e => set("cpa_amount", e.target.value)} placeholder="0" />
        </label>
        <label style={{ ...label, gridColumn: "1 / -1" }}>{t.form.notes}
          <input style={inputStyle} value={form.notes} onChange={e => set("notes", e.target.value)} />
        </label>
      </div>
      <p style={{ fontSize: 11.5, color: C.inkFaint, margin: "10px 0 0" }}>{t.form.help}</p>
      {editing && (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.inkDim, marginTop: 12 }}>
          <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} /> {t.form.active}
        </label>
      )}
      {error && <div style={{ color: C.negative, fontSize: 12.5, marginTop: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button style={btn(true)} onClick={save} disabled={saving}>{saving ? <Spinner /> : t.form.save}</button>
        <button style={btn(false)} onClick={onCancel}>{t.cancel}</button>
      </div>
    </Panel>
  );
}

/**
 * Parses first, then shows what the upload will do before writing anything:
 * how many players are new, how many already belong to this affiliate, and —
 * the case that moves money between people — how many are currently credited
 * to someone else.
 */
function UploadPanel({ t, affiliate, onImported }) {
  const input = useRef(null);
  const [phase, setPhase] = useState("idle"); // idle | parsing | preview | importing | done
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);

  async function handleFile(file) {
    if (!file) return;
    setError(null);
    setPhase("parsing");
    try {
      const parsed = await parseAffiliateReportFile(file);
      if (!parsed.players.length) throw new Error(t.upload.noRows);
      const ids = parsed.players.map(p => p.player_id);
      const owners = new Map();
      const known = new Set();
      for (let i = 0; i < ids.length; i += 300) {
        const chunk = ids.slice(i, i + 300);
        const [own, pl] = await Promise.all([
          supabase.from("affiliate_players").select("player_id, affiliate_code").in("player_id", chunk),
          supabase.from("players").select("id").in("id", chunk),
        ]);
        if (own.error) throw own.error;
        if (pl.error) throw pl.error;
        for (const r of own.data) owners.set(r.player_id, r.affiliate_code);
        for (const r of pl.data) known.add(r.id);
      }
      const moved = {};
      let fresh = 0, same = 0;
      for (const id of ids) {
        const owner = owners.get(id);
        if (!owner) fresh += 1;
        else if (owner === affiliate.code) same += 1;
        else moved[owner] = (moved[owner] || 0) + 1;
      }
      const ftds = parsed.players.filter(p => (p.deposit_amount ?? 0) > 0 || (p.deposit_count ?? 0) > 0 || p.first_deposit_date).length;
      const ggr = parsed.players.reduce((sum, p) => sum + (p.ggr ?? 0), 0);
      setPreview({
        file, ...parsed, fresh, same, moved,
        notInReport: ids.filter(id => !known.has(id)).length,
        ftds, ggr,
        deposits: parsed.players.reduce((sum, p) => sum + (p.deposit_amount ?? 0), 0),
      });
      setPhase("preview");
    } catch (e) {
      setError(e.message);
      setPhase("idle");
    }
  }

  async function confirm() {
    setPhase("importing");
    setError(null);
    try {
      const now = new Date().toISOString();
      const rows = preview.players.map(p => ({ ...p, affiliate_code: affiliate.code, source_file: preview.file.name, updated_at: now }));
      await upsertInChunks(supabase, "affiliate_players", rows, "player_id");
      setPhase("done");
      setPreview(null);
      onImported();
    } catch (e) {
      setError(e.message);
      setPhase("preview");
    }
  }

  function reset() {
    setPreview(null);
    setPhase("idle");
    if (input.current) input.current.value = "";
  }

  const movedEntries = Object.entries(preview?.moved || {});
  const line = { fontSize: 12.5, color: C.inkDim, margin: "4px 0" };
  return (
    <Panel style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{t.upload.title.replace("{name}", affiliate.name)}</div>
          <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 3 }}>{t.upload.sub}</div>
        </div>
        {phase !== "preview" && (
          <button style={btn(true)} onClick={() => input.current?.click()} disabled={phase === "parsing" || phase === "importing"}>
            {phase === "parsing" || phase === "importing" ? <Spinner /> : <UploadCloud size={14} />} {t.upload.choose}
          </button>
        )}
        <input ref={input} type="file" accept=".csv,.xlsx,.tsv,.txt" style={{ display: "none" }} onChange={e => handleFile(e.target.files?.[0])} />
      </div>

      {phase === "done" && <div style={{ color: C.positive, fontSize: 12.5, marginTop: 12 }}>{t.upload.done}</div>}
      {error && <div style={{ color: C.negative, fontSize: 12.5, marginTop: 12 }}>{error}</div>}

      {phase === "preview" && preview && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${C.panelBorder}`, paddingTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{preview.file.name}</div>
          <p style={line}>{t.upload.summary
            .replace("{n}", fmtInt(preview.players.length)).replace("{f}", fmtInt(preview.ftds))
            .replace("{d}", fmtDOP(preview.deposits)).replace("{g}", fmtDOP(preview.ggr))}</p>
          <p style={line}>{t.upload.newSame.replace("{new}", fmtInt(preview.fresh)).replace("{same}", fmtInt(preview.same))}</p>
          {movedEntries.length > 0 && (
            <p style={{ ...line, color: C.negative }}>
              {t.upload.moved.replace("{list}", movedEntries.map(([code, n]) => `${n} ${t.upload.from} ${code}`).join(", ")).replace("{to}", affiliate.code)}
            </p>
          )}
          {preview.notInReport > 0 && <p style={{ ...line, color: C.inkFaint }}>{t.upload.notInReport.replace("{n}", fmtInt(preview.notInReport))}</p>}
          {preview.missingFields.length > 0 && (
            <p style={{ ...line, color: C.negative }}>{t.upload.missing.replace("{cols}", preview.missingFields.map(f => t.upload.fields[f]).join(", "))}</p>
          )}
          {preview.unparsed.length > 0 && <p style={{ ...line, color: C.negative }}>{t.upload.unparsed.replace("{n}", preview.unparsed.length)}</p>}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button style={btn(true)} onClick={confirm}>{t.upload.confirm.replace("{code}", affiliate.code)}</button>
            <button style={btn(false)} onClick={reset}>{t.cancel}</button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function PayoutsPanel({ t, lang, affiliate, payouts, onChanged }) {
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function add() {
    const value = Number(amount);
    if (!(value > 0)) { setError(t.payouts.amountRequired); return; }
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.from("affiliate_payouts").insert({
      affiliate_code: affiliate.code, amount: value, paid_on: paidOn, note: note.trim() || null,
    });
    setSaving(false);
    if (err) { setError(err.message); return; }
    setAmount("");
    setNote("");
    onChanged();
  }

  async function remove(id) {
    if (!window.confirm(t.payouts.confirmDelete)) return;
    const { error: err } = await supabase.from("affiliate_payouts").delete().eq("id", id);
    if (err) setError(err.message);
    else onChanged();
  }

  return (
    <Panel style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{t.payouts.title}</div>
      <div style={{ fontSize: 12, color: C.inkFaint, margin: "3px 0 12px" }}>{t.payouts.sub}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input style={inputStyle} type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)} />
        <input style={{ ...inputStyle, width: 150 }} type="number" min="0" step="100" placeholder={t.payouts.amount} value={amount} onChange={e => setAmount(e.target.value)} />
        <input style={{ ...inputStyle, flex: 1, minWidth: 160 }} placeholder={t.payouts.note} value={note} onChange={e => setNote(e.target.value)} />
        <button style={btn(true)} onClick={add} disabled={saving}><Plus size={14} /> {t.payouts.add}</button>
      </div>
      {error && <div style={{ color: C.negative, fontSize: 12.5, marginTop: 10 }}>{error}</div>}
      {payouts.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 14 }}>
          <thead><tr>
            <th style={thStyle}>{t.payouts.date}</th>
            <th style={{ ...thStyle, ...num }}>{t.payouts.amount}</th>
            <th style={thStyle}>{t.payouts.note}</th>
            <th style={thStyle} />
          </tr></thead>
          <tbody>
            {payouts.map(p => (
              <tr key={p.id}>
                <td style={tdStyle}>{fmtDate(`${p.paid_on}T12:00:00`, lang)}</td>
                <td style={{ ...tdStyle, ...num }}>{fmtDOP(p.amount, { decimals: 2 })}</td>
                <td style={{ ...tdStyle, color: C.inkDim, whiteSpace: "normal" }}>{p.note || ""}</td>
                <td style={{ ...tdStyle, textAlign: "right" }}>
                  <button onClick={() => remove(p.id)} title={t.payouts.delete} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint }}><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// Raw values for the statement an affiliate is sent: amounts unformatted, dates ISO.
const PLAYER_CSV = [
  { label: "player_id", value: p => p.player_id },
  { label: "name", value: p => p.full_name || p.username },
  { label: "registered_at", value: p => p.registered_at },
  { label: "first_deposit_date", value: p => p.first_deposit_date },
  { label: "deposits_dop", value: p => p.deposit_amount },
  { label: "ggr_dop", value: p => p.ggr },
  { label: "counts_for_commission", value: p => (p.is_flagged ? "no" : "yes") },
];

function AffiliateDetail({ t, lang, affiliate, onBack, onReload }) {
  const [players, setPlayers] = useState(null);
  const [payouts, setPayouts] = useState([]);
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      const [pl, po] = await Promise.all([
        supabase.from("affiliate_player_stats").select("*").eq("affiliate_code", affiliate.code).order("registered_at", { ascending: false }),
        supabase.from("affiliate_payouts").select("*").eq("affiliate_code", affiliate.code).order("paid_on", { ascending: false }),
      ]);
      if (!active) return;
      if (pl.error || po.error) { setError((pl.error || po.error).message); return; }
      setPlayers(pl.data || []);
      setPayouts(po.data || []);
    })();
    return () => { active = false; };
  }, [affiliate.code, version]);

  function refresh() {
    setVersion(v => v + 1);
    onReload();
  }

  async function unassign(playerId) {
    if (!window.confirm(t.players.confirmRemove)) return;
    const { error: err } = await supabase.from("affiliate_players").delete().eq("player_id", playerId);
    if (err) setError(err.message);
    else refresh();
  }

  const needle = search.trim().toLowerCase();
  const visible = (players || []).filter(p => !needle ||
    [p.player_id, p.full_name, p.username, p.email].some(v => String(v || "").toLowerCase().includes(needle)));

  return (
    <>
      <button style={{ ...btn(false), marginBottom: 14 }} onClick={onBack}><ArrowLeft size={14} /> {t.back}</button>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <SectionHeading
          title={`${affiliate.name} · ${affiliate.code}`}
          subtitle={`${t.deal}: ${dealLabel(affiliate, t)}${affiliate.active ? "" : ` · ${t.inactive}`}${affiliate.notes ? ` · ${affiliate.notes}` : ""}`}
        />
        <button style={btn(false)} onClick={() => setEditing(e => !e)}><Pencil size={13} /> {t.form.editTitle}</button>
      </div>
      {editing && <AffiliateForm t={t} initial={affiliate} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}

      <KpiRow t={t} totals={affiliate} />

      <Panel style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{t.calc.title}</div>
        <table style={{ borderCollapse: "collapse", fontSize: 12.5 }}>
          <tbody>
            <tr><td style={{ padding: "4px 24px 4px 0", color: C.inkDim }}>{t.calc.ggr}</td><td style={num}>{fmtDOP(affiliate.ggr, { decimals: 2 })}</td></tr>
            <tr><td style={{ padding: "4px 24px 4px 0", color: C.inkDim }}>× {Number(affiliate.commission_pct)}% {t.calc.revshare}</td><td style={num}>{fmtDOP(affiliate.revshare, { decimals: 2 })}</td></tr>
            {Number(affiliate.cpa_amount) > 0 && (
              <tr><td style={{ padding: "4px 24px 4px 0", color: C.inkDim }}>+ {fmtInt(affiliate.ftds)} FTD × {fmtDOP(affiliate.cpa_amount)}</td><td style={num}>{fmtDOP(affiliate.cpa_earned, { decimals: 2 })}</td></tr>
            )}
            <tr><td style={{ padding: "4px 24px 4px 0", fontWeight: 600 }}>= {t.kpi.commission}</td><td style={{ ...num, fontWeight: 600 }}>{fmtDOP(affiliate.commission, { decimals: 2 })}</td></tr>
            <tr><td style={{ padding: "4px 24px 4px 0", color: C.inkDim }}>− {t.kpi.paid}</td><td style={num}>{fmtDOP(affiliate.paid, { decimals: 2 })}</td></tr>
            <tr><td style={{ padding: "4px 24px 4px 0", fontWeight: 600 }}>= {t.kpi.balance}</td><td style={{ ...num, fontWeight: 600, color: C.accent }}>{fmtDOP(affiliate.balance, { decimals: 2 })}</td></tr>
          </tbody>
        </table>
        {Number(affiliate.ggr) < 0 && <p style={{ fontSize: 11.5, color: C.negative, margin: "10px 0 0" }}>{t.calc.negative}</p>}
        {Number(affiliate.flagged) > 0 && <p style={{ fontSize: 11.5, color: C.inkFaint, margin: "10px 0 0" }}>{t.calc.flagged.replace("{n}", affiliate.flagged)}</p>}
      </Panel>

      <UploadPanel t={t} affiliate={affiliate} onImported={refresh} />
      <PayoutsPanel t={t} lang={lang} affiliate={affiliate} payouts={payouts} onChanged={refresh} />

      <Panel style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "14px 16px", flexWrap: "wrap" }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{t.players.title} ({fmtInt(players?.length)})</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="search" style={inputStyle} placeholder={t.players.search} value={search} onChange={e => setSearch(e.target.value)} />
            <button style={btn(false)} disabled={!visible.length}
              onClick={() => downloadCsv(`appuesta-afiliado-${affiliate.code.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`, PLAYER_CSV, visible)}>
              <Download size={13} /> CSV
            </button>
          </div>
        </div>
        {error && <div style={{ color: C.negative, fontSize: 12.5, padding: "0 16px 12px" }}>{error}</div>}
        {!players ? <div style={{ padding: 30, textAlign: "center" }}><Spinner /></div> : !players.length ? (
          <div style={{ padding: "20px 16px 26px", fontSize: 12.5, color: C.inkDim }}>{t.players.empty}</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={thStyle}>{t.players.player}</th>
                <th style={thStyle}>{t.players.registered}</th>
                <th style={thStyle}>{t.players.ftd}</th>
                <th style={{ ...thStyle, ...num }}>{t.kpi.deposits}</th>
                <th style={{ ...thStyle, ...num }}>GGR</th>
                <th style={{ ...thStyle, ...num }}>{t.kpi.commission}</th>
                <th style={thStyle}>{t.players.lastLogin}</th>
                <th style={thStyle} />
              </tr></thead>
              <tbody>
                {visible.map(p => {
                  const deposited = Number(p.deposit_amount) > 0 || Number(p.deposit_count) > 0 || p.first_deposit_date;
                  return (
                    <tr key={p.player_id} style={{ opacity: p.is_flagged ? 0.5 : 1 }}>
                      <td style={tdStyle}>
                        <div style={{ color: C.ink }}>{p.full_name || p.username || "—"}</div>
                        <div style={{ fontSize: 11, color: C.inkFaint }}>
                          {p.player_id}{p.username && p.full_name ? ` · ${p.username}` : ""}
                          {p.is_flagged && <span style={{ color: C.negative }}> · {t.players.flagged}</span>}
                          {!p.in_player_report && <span> · {t.players.notInReport}</span>}
                        </div>
                      </td>
                      <td style={tdStyle}>{fmtDate(p.registered_at, lang)}</td>
                      <td style={tdStyle}>{deposited ? <span style={{ color: C.positive }}>{p.first_deposit_date ? fmtDate(p.first_deposit_date, lang) : t.players.yes}</span> : <span style={{ color: C.inkFaint }}>—</span>}</td>
                      <td style={{ ...tdStyle, ...num }}>{fmtDOP(p.deposit_amount)}</td>
                      <td style={{ ...tdStyle, ...num, color: Number(p.ggr) < 0 ? C.negative : C.ink }}>{fmtDOP(p.ggr)}</td>
                      <td style={{ ...tdStyle, ...num }}>{p.is_flagged ? "—" : fmtDOP((Number(p.ggr) || 0) * Number(affiliate.commission_pct) / 100)}</td>
                      <td style={{ ...tdStyle, color: C.inkDim }}>{fmtDate(p.last_login_at, lang)}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <button onClick={() => unassign(p.player_id)} title={t.players.remove} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint }}><X size={14} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

export default function Affiliates({ s, lang }) {
  const t = AFF_STRINGS[lang];
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    supabase.from("affiliate_summary").select("*").order("commission", { ascending: false }).then(({ data, error: err }) => {
      if (!active) return;
      if (err) setError(err.message);
      else setRows(data || []);
    });
    return () => { active = false; };
  }, [version]);

  const reload = () => setVersion(v => v + 1);
  const current = selected && rows?.find(r => r.code === selected);

  if (error) return <Panel style={{ color: C.negative }}>{error}</Panel>;
  if (!rows) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>;
  if (current) return <AffiliateDetail key={current.code} t={t} lang={lang} affiliate={current} onBack={() => setSelected(null)} onReload={reload} />;

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <SectionHeading title={t.title} subtitle={t.sub} />
        {!creating && <button style={btn(true)} onClick={() => setCreating(true)}><Plus size={14} /> {t.form.newTitle}</button>}
      </div>
      {creating && <AffiliateForm t={t} onCancel={() => setCreating(false)} onSaved={code => { setCreating(false); reload(); setSelected(code); }} />}

      {!rows.length ? (
        <Panel style={{ textAlign: "center", padding: "48px 24px" }}>
          <Handshake size={28} color={C.inkFaint} style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 6 }}>{t.emptyTitle}</div>
          <div style={{ fontSize: 12.5, color: C.inkDim, maxWidth: 420, margin: "0 auto" }}>{t.emptySub}</div>
        </Panel>
      ) : (
        <>
          <KpiRow t={t} totals={totalsOf(rows)} />
          <Panel style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>
                  <th style={thStyle}>{t.table.affiliate}</th>
                  <th style={thStyle}>{t.deal}</th>
                  <th style={{ ...thStyle, ...num }}>{t.kpi.registrations}</th>
                  <th style={{ ...thStyle, ...num }}>{t.kpi.ftds}</th>
                  <th style={{ ...thStyle, ...num }}>{t.kpi.conversion}</th>
                  <th style={{ ...thStyle, ...num }}>{t.kpi.deposits}</th>
                  <th style={{ ...thStyle, ...num }}>GGR</th>
                  <th style={{ ...thStyle, ...num }}>{t.kpi.commission}</th>
                  <th style={{ ...thStyle, ...num }}>{t.kpi.paid}</th>
                  <th style={{ ...thStyle, ...num }}>{t.kpi.balance}</th>
                  <th style={thStyle}>{t.table.lastUpload}</th>
                </tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.code} onClick={() => setSelected(r.code)} style={{ cursor: "pointer", opacity: r.active ? 1 : 0.5 }}>
                      <td style={tdStyle}>
                        <div style={{ color: C.ink, fontWeight: 600 }}>{r.name}</div>
                        <div style={{ fontSize: 11, color: C.inkFaint }}>{r.code}{r.active ? "" : ` · ${t.inactive}`}</div>
                      </td>
                      <td style={{ ...tdStyle, color: C.inkDim }}>{dealLabel(r, t)}</td>
                      <td style={{ ...tdStyle, ...num }}>{fmtInt(r.registrations)}</td>
                      <td style={{ ...tdStyle, ...num }}>{fmtInt(r.ftds)}</td>
                      <td style={{ ...tdStyle, ...num, color: C.inkDim }}>{fmtPct(r.ftds, r.registrations)}</td>
                      <td style={{ ...tdStyle, ...num }}>{fmtDOP(r.deposit_amount)}</td>
                      <td style={{ ...tdStyle, ...num, color: Number(r.ggr) < 0 ? C.negative : C.ink }}>{fmtDOP(r.ggr)}</td>
                      <td style={{ ...tdStyle, ...num, fontWeight: 600 }}>{fmtDOP(r.commission)}</td>
                      <td style={{ ...tdStyle, ...num, color: C.inkDim }}>{fmtDOP(r.paid)}</td>
                      <td style={{ ...tdStyle, ...num, fontWeight: 600, color: Number(r.balance) > 0 ? C.accent : C.inkDim }}>{fmtDOP(r.balance)}</td>
                      <td style={{ ...tdStyle, color: C.inkDim }}>{fmtDate(r.last_upload, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <p style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 12 }}>{t.footnote}</p>
        </>
      )}
    </>
  );
}
