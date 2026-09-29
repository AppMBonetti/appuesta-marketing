import { useEffect, useState } from "react";
import { HandCoins, Receipt, ShieldAlert, TrendingUp, UserCheck, UserPlus, Wallet } from "lucide-react";
import { C } from "./lib/theme";
import { STRINGS } from "./lib/i18n";
import { PORTAL_STRINGS } from "./lib/i18nPortal";
import { useAuth } from "./lib/AuthContext";
import { supabase, supabaseConfigError } from "./lib/supabaseClient";
import Login from "./pages/Login";
import { KpiCard, Panel, Spinner, fmtDOP } from "./components/ui";

/**
 * What an affiliate sees at /portal: their own figures only. Every number comes
 * from the my_affiliate_* database functions, which resolve the affiliate from
 * the signed-in email — this page never queries a table, so it cannot show
 * another affiliate's data even if it tried.
 */
export default function PortalApp() {
  const [lang, setLang] = useState("es");
  const { status, session } = useAuth();
  const s = STRINGS[lang];
  const t = PORTAL_STRINGS[lang];
  // undefined = not checked yet, null = no affiliate for this login
  const [summary, setSummary] = useState(undefined);

  useEffect(() => { document.title = `${s.brand} · ${t.appName}`; }, [s, t]);

  const signedIn = !!session && status !== "loading" && status !== "checking_membership";
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    supabase.rpc("my_affiliate_summary").then(({ data }) => {
      if (active) setSummary(data?.[0] ?? null);
    });
    return () => { active = false; };
  }, [signedIn, session?.user?.email]);

  const center = { background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'Inter', -apple-system, sans-serif", color: C.ink };
  if (supabaseConfigError) return <div style={center}>{supabaseConfigError}</div>;
  if (status === "signed_out") {
    return <Login s={{ ...s, loginTitle: t.loginTitle, loginSub: t.loginSub }} lang={lang} setLang={setLang} />;
  }
  if (!signedIn || summary === undefined) return <div style={center}><Spinner size={22} /></div>;
  if (!summary) return <NoAccess s={s} t={t} teamMember={status === "authorized"} />;

  return <Portal s={s} t={t} lang={lang} setLang={setLang} summary={summary} />;
}

function NoAccess({ s, t, teamMember }) {
  const { session, signOut } = useAuth();
  return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', -apple-system, sans-serif", color: C.ink, padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 400, background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 16, padding: 28, textAlign: "center" }}>
        <ShieldAlert size={28} color={C.negative} style={{ marginBottom: 12 }} />
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, fontFamily: "'Space Grotesk', sans-serif" }}>{t.noAccessTitle}</div>
        <div style={{ fontSize: 12.5, color: C.inkDim, marginBottom: 18 }}>{t.noAccessSub}</div>
        {teamMember && <a href="/afiliados" style={{ display: "block", fontSize: 12.5, color: C.accent, marginBottom: 14 }}>{t.teamHint}</a>}
        <div style={{ fontSize: 12, color: C.inkFaint, marginBottom: 18 }}>{s.signedInAs}: {session?.user?.email}</div>
        <button onClick={signOut} style={{ padding: "9px 18px", borderRadius: 9, border: `1px solid ${C.panelBorder}`, background: "transparent", color: C.ink, fontSize: 13, cursor: "pointer" }}>{s.signOut}</button>
      </div>
    </div>
  );
}

const fmtInt = n => Number(n || 0).toLocaleString("es-DO");
const fmtPct = (a, b) => (Number(b) > 0 ? `${((Number(a) / Number(b)) * 100).toFixed(1)}%` : "—");
const locale = lang => (lang === "es" ? "es-DO" : "en-US");
const fmtDate = (v, lang) => (v ? new Date(v).toLocaleDateString(locale(lang), { day: "numeric", month: "short", year: "numeric" }) : "—");

const th = { padding: "9px 12px", textAlign: "left", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap", borderBottom: `1px solid ${C.panelBorder}` };
const td = { padding: "9px 12px", fontSize: 12.5, whiteSpace: "nowrap", borderBottom: `1px solid ${C.panelBorder}` };
const num = { textAlign: "right", fontVariantNumeric: "tabular-nums" };

/** Registrations, FTDs and GGR grouped by the month players signed up in. */
function byMonth(players) {
  const m = new Map();
  for (const p of players) {
    const key = p.registered_at ? String(p.registered_at).slice(0, 7) : "—";
    const row = m.get(key) || { month: key, registrations: 0, ftds: 0, deposits: 0, ggr: 0 };
    row.registrations += 1;
    if (p.is_ftd) row.ftds += 1;
    row.deposits += Number(p.deposit_amount) || 0;
    row.ggr += Number(p.ggr) || 0;
    m.set(key, row);
  }
  return [...m.values()].sort((a, b) => b.month.localeCompare(a.month));
}

function monthLabel(key, lang) {
  if (!/^\d{4}-\d{2}$/.test(key)) return key;
  const [y, mo] = key.split("-").map(Number);
  const label = new Date(Date.UTC(y, mo - 1, 15)).toLocaleDateString(locale(lang), { month: "long", year: "numeric", timeZone: "UTC" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function Portal({ s, t, lang, setLang, summary: a }) {
  const { signOut } = useAuth();
  const [players, setPlayers] = useState(null);
  const [payouts, setPayouts] = useState([]);

  useEffect(() => {
    let active = true;
    Promise.all([supabase.rpc("my_affiliate_players"), supabase.rpc("my_affiliate_payouts")]).then(([pl, po]) => {
      if (!active) return;
      setPlayers(pl.data || []);
      setPayouts(po.data || []);
    });
    return () => { active = false; };
  }, []);

  const pct = Number(a.commission_pct);
  const deal = [pct > 0 && `${pct}% ${t.ofGgr}`, Number(a.cpa_amount) > 0 && `${fmtDOP(a.cpa_amount)} / FTD`].filter(Boolean).join(" + ");
  const row = { padding: "4px 28px 4px 0", color: C.inkDim };
  const months = players ? byMonth(players) : [];

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "'Inter', -apple-system, sans-serif", color: C.ink }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 32px", borderBottom: `1px solid ${C.panelBorder}`, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: `linear-gradient(135deg, ${C.accent}, ${C.accentDim})` }} />
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 15 }}>{s.brand}</span>
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, color: C.inkDim }}>· {t.appName}</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={() => setLang(l => (l === "es" ? "en" : "es"))} style={{ padding: "7px 12px", borderRadius: 9, border: `1px solid ${C.panelBorder}`, background: "transparent", color: C.inkDim, fontSize: 12.5, cursor: "pointer" }}>🌐 {lang === "es" ? "Español" : "English"}</button>
          <button onClick={signOut} style={{ padding: "7px 12px", borderRadius: 9, border: "none", background: "transparent", color: C.inkFaint, fontSize: 12.5, cursor: "pointer" }}>{s.signOut}</button>
        </div>
      </header>

      <main style={{ padding: "26px 32px", maxWidth: 1200, margin: "0 auto" }}>
        <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 21, margin: 0, fontWeight: 600 }}>{t.welcome.replace("{name}", a.name)}</h2>
        <p style={{ color: C.inkDim, fontSize: 13, margin: "5px 0 20px" }}>
          {t.code}: <strong style={{ color: C.ink }}>{a.code}</strong> · {t.deal}: <strong style={{ color: C.ink }}>{deal || "—"}</strong>
          {a.last_upload && <> · {t.updated.replace("{d}", fmtDate(a.last_upload, lang))}</>}
        </p>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
          <KpiCard icon={UserPlus} label={t.kpi.registrations} value={fmtInt(a.registrations)} />
          <KpiCard icon={UserCheck} label={t.kpi.ftds} value={fmtInt(a.ftds)} delta={`${fmtPct(a.ftds, a.registrations)} ${t.kpi.conversion}`} />
          <KpiCard icon={Wallet} label={t.kpi.deposits} value={fmtDOP(a.deposit_amount)} />
          <KpiCard icon={TrendingUp} label={t.kpi.ggr} value={fmtDOP(a.ggr)} />
          <KpiCard icon={HandCoins} label={t.kpi.commission} value={fmtDOP(a.commission)} />
          <KpiCard icon={Receipt} label={t.kpi.balance} value={fmtDOP(a.balance)} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18, marginBottom: 18 }}>
          <Panel>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{t.calc.title}</div>
            <table style={{ borderCollapse: "collapse", fontSize: 12.5 }}>
              <tbody>
                <tr><td style={row}>{t.calc.ggr}</td><td style={num}>{fmtDOP(a.ggr, { decimals: 2 })}</td></tr>
                <tr><td style={row}>× {pct}% {t.calc.revshare}</td><td style={num}>{fmtDOP(a.revshare, { decimals: 2 })}</td></tr>
                {Number(a.cpa_amount) > 0 && <tr><td style={row}>+ {fmtInt(a.ftds)} FTD × {fmtDOP(a.cpa_amount)}</td><td style={num}>{fmtDOP(a.cpa_earned, { decimals: 2 })}</td></tr>}
                <tr><td style={{ ...row, color: C.ink, fontWeight: 600 }}>= {t.calc.commission}</td><td style={{ ...num, fontWeight: 600 }}>{fmtDOP(a.commission, { decimals: 2 })}</td></tr>
                <tr><td style={row}>− {t.calc.paid}</td><td style={num}>{fmtDOP(a.paid, { decimals: 2 })}</td></tr>
                <tr><td style={{ ...row, color: C.ink, fontWeight: 600 }}>= {t.calc.balance}</td><td style={{ ...num, fontWeight: 600, color: C.accent }}>{fmtDOP(a.balance, { decimals: 2 })}</td></tr>
              </tbody>
            </table>
            <p style={{ fontSize: 11.5, color: C.inkFaint, margin: "12px 0 0" }}>{t.calc.ggrNote}</p>
            {Number(a.ggr) < 0 && <p style={{ fontSize: 11.5, color: C.negative, margin: "8px 0 0" }}>{t.calc.negative}</p>}
          </Panel>

          <Panel>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{t.payouts.title}</div>
            {!payouts.length ? <div style={{ fontSize: 12.5, color: C.inkDim }}>{t.payouts.none}</div> : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>{t.payouts.date}</th><th style={{ ...th, ...num }}>{t.payouts.amount}</th></tr></thead>
                <tbody>{payouts.map((p, i) => (
                  <tr key={i}><td style={td}>{fmtDate(`${p.paid_on}T12:00:00`, lang)}</td><td style={{ ...td, ...num }}>{fmtDOP(p.amount, { decimals: 2 })}</td></tr>
                ))}</tbody>
              </table>
            )}
          </Panel>
        </div>

        {months.length > 0 && (
          <Panel style={{ padding: 0, overflow: "hidden", marginBottom: 18 }}>
            <div style={{ fontSize: 14, fontWeight: 600, padding: "14px 16px 6px" }}>{t.monthly.title}</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>
                  <th style={th}>{t.monthly.month}</th>
                  <th style={{ ...th, ...num }}>{t.kpi.registrations}</th>
                  <th style={{ ...th, ...num }}>{t.kpi.ftds}</th>
                  <th style={{ ...th, ...num }}>{t.kpi.conversion}</th>
                  <th style={{ ...th, ...num }}>{t.kpi.deposits}</th>
                  <th style={{ ...th, ...num }}>GGR</th>
                  <th style={{ ...th, ...num }}>{t.kpi.commission}</th>
                </tr></thead>
                <tbody>{months.map(m => (
                  <tr key={m.month}>
                    <td style={td}>{monthLabel(m.month, lang)}</td>
                    <td style={{ ...td, ...num }}>{fmtInt(m.registrations)}</td>
                    <td style={{ ...td, ...num }}>{fmtInt(m.ftds)}</td>
                    <td style={{ ...td, ...num, color: C.inkDim }}>{fmtPct(m.ftds, m.registrations)}</td>
                    <td style={{ ...td, ...num }}>{fmtDOP(m.deposits)}</td>
                    <td style={{ ...td, ...num }}>{fmtDOP(m.ggr)}</td>
                    <td style={{ ...td, ...num }}>{fmtDOP(m.ggr * pct / 100 + m.ftds * Number(a.cpa_amount))}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Panel>
        )}

        <Panel style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "14px 16px 6px" }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{t.players.title} ({fmtInt(players?.length)})</div>
            <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 3 }}>{t.players.privacy}</div>
          </div>
          {!players ? <div style={{ padding: 30, textAlign: "center" }}><Spinner /></div> : !players.length ? (
            <div style={{ padding: "12px 16px 22px", fontSize: 12.5, color: C.inkDim }}>{t.players.none}</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>
                  <th style={th}>{t.players.ref}</th>
                  <th style={th}>{t.players.registered}</th>
                  <th style={th}>{t.players.ftd}</th>
                  <th style={{ ...th, ...num }}>{t.kpi.deposits}</th>
                  <th style={{ ...th, ...num }}>GGR</th>
                  <th style={{ ...th, ...num }}>{t.kpi.commission}</th>
                </tr></thead>
                <tbody>{players.map((p, i) => (
                  <tr key={i}>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{p.player_ref}</td>
                    <td style={td}>{fmtDate(p.registered_at, lang)}</td>
                    <td style={td}>{p.is_ftd ? <span style={{ color: C.positive }}>{p.first_deposit_date ? fmtDate(p.first_deposit_date, lang) : t.players.yes}</span> : <span style={{ color: C.inkFaint }}>—</span>}</td>
                    <td style={{ ...td, ...num }}>{fmtDOP(p.deposit_amount)}</td>
                    <td style={{ ...td, ...num, color: Number(p.ggr) < 0 ? C.negative : C.ink }}>{fmtDOP(p.ggr)}</td>
                    <td style={{ ...td, ...num }}>{fmtDOP((Number(p.ggr) || 0) * pct / 100)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Panel>
      </main>
    </div>
  );
}
