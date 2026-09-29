import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { C } from "./lib/theme";
import { getCurrencyState, loadFxRate, restoreCurrency, setCurrency } from "./lib/currency";
import { STRINGS } from "./lib/i18n";
import { useAuth } from "./lib/AuthContext";
import { supabaseConfigError } from "./lib/supabaseClient";
import Login from "./pages/Login";
import NotAuthorized from "./pages/NotAuthorized";
import Affiliates from "./pages/Affiliates";
import { Spinner } from "./components/ui";

/**
 * The affiliate dashboard, served at /afiliados. It is its own page rather than
 * a tab of the marketing dashboard, but shares the same login, team gating,
 * database and currency setting, so a team member moves between the two
 * without signing in again.
 */
export default function AffiliatesApp() {
  const [lang, setLang] = useState("es");
  const { status } = useAuth();
  const s = STRINGS[lang];

  useEffect(() => { document.title = `${s.brand} · ${s.aff.appName}`; }, [s]);

  const center = { background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'Inter', -apple-system, sans-serif" };
  if (supabaseConfigError) {
    return (
      <div style={center}>
        <div style={{ maxWidth: 460, textAlign: "center", color: C.ink }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>{s.configErrorTitle}</div>
          <div style={{ fontSize: 13, color: C.inkDim, lineHeight: 1.65 }}>{supabaseConfigError}</div>
        </div>
      </div>
    );
  }
  if (status === "loading" || status === "checking_membership") return <div style={center}><Spinner size={22} /></div>;
  if (status === "signed_out") return <Login s={s} lang={lang} setLang={setLang} />;
  if (status === "not_authorized") return <NotAuthorized s={s} />;

  return <Shell s={s} lang={lang} setLang={setLang} />;
}

function Shell({ s, lang, setLang }) {
  const [currency, setCurrencyUi] = useState(() => restoreCurrency());
  const [fxRate, setFxRate] = useState(null);
  const { session, member, signOut } = useAuth();

  useEffect(() => {
    let active = true;
    loadFxRate().then(rate => { if (active) setFxRate(rate); });
    return () => { active = false; };
  }, []);

  const fx = getCurrencyState();
  const usdReady = fxRate != null || fx.dopPerUsd != null;
  const pill = { padding: "7px 12px", borderRadius: 9, border: `1px solid ${C.panelBorder}`, background: "transparent", color: C.inkDim, fontSize: 12.5, cursor: "pointer", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 };

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "'Inter', -apple-system, sans-serif", color: C.ink }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 32px", borderBottom: `1px solid ${C.panelBorder}`, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: `linear-gradient(135deg, ${C.accent}, ${C.accentDim})` }} />
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 15 }}>{s.brand}</span>
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, color: C.inkDim }}>· {s.aff.appName}</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11.5, color: C.inkFaint, marginRight: 4 }}>{member?.name || session?.user?.email}</span>
          <div style={{ display: "flex", border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2 }}
               title={usdReady ? `1 USD = ${(fx.dopPerUsd ?? fxRate)?.toFixed(2)} DOP · ${fx.rateDate ?? ""}` : s.currency.noRate}>
            {["DOP", "USD"].map(code => (
              <button key={code} onClick={() => setCurrencyUi(setCurrency(code))} disabled={code === "USD" && !usdReady}
                style={{ padding: "4px 10px", borderRadius: 7, border: "none", cursor: code === "USD" && !usdReady ? "not-allowed" : "pointer", fontSize: 11.5, fontWeight: 600,
                         background: currency === code ? C.accent : "transparent", color: currency === code ? "#fff" : C.inkDim }}>{code}</button>
            ))}
          </div>
          <button style={pill} onClick={() => setLang(l => (l === "es" ? "en" : "es"))}>🌐 {lang === "es" ? "Español" : "English"}</button>
          <a style={pill} href="/">{s.aff.toMarketing} <ArrowUpRight size={13} /></a>
          <button style={{ ...pill, border: "none", color: C.inkFaint }} onClick={signOut}>{s.signOut}</button>
        </div>
      </header>
      <main style={{ padding: "26px 32px", maxWidth: 1400, margin: "0 auto" }}>
        <Affiliates s={s} lang={lang} />
      </main>
    </div>
  );
}
