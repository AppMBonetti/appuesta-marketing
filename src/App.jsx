import { useEffect, useState } from "react";
import {
  LayoutGrid, TrendingUp, Users, Repeat, Crown, NotebookPen,
  SlidersHorizontal, UploadCloud,
} from "lucide-react";
import { C } from "./lib/theme";
import { getCurrencyState, loadFxRate, restoreCurrency, setCurrency } from "./lib/currency";
import { STRINGS } from "./lib/i18n";
import { useAuth } from "./lib/AuthContext";
import { supabaseConfigError } from "./lib/supabaseClient";
import Login from "./pages/Login";
import NotAuthorized from "./pages/NotAuthorized";
import { Spinner } from "./components/ui";

import Overview from "./pages/Overview";
import Acquisition from "./pages/Acquisition";
import Funnel from "./pages/Funnel";
import Retention from "./pages/Retention";
import Vip from "./pages/Vip";
import Optimization from "./pages/Optimization";
import Imports from "./pages/Imports";
import Settings from "./pages/Settings";

export default function App() {
  const [lang, setLang] = useState("es");
  const { status } = useAuth();
  const s = STRINGS[lang];

  // Without credentials nothing can load, so say so plainly rather than
  // leaving a permanent spinner or an empty dashboard to be misread as "no data".
  if (supabaseConfigError) {
    return (
      <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'Inter', -apple-system, sans-serif" }}>
        <div style={{ maxWidth: 460, textAlign: "center", color: C.ink }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>{s.configErrorTitle}</div>
          <div style={{ fontSize: 13, color: C.inkDim, lineHeight: 1.65 }}>{supabaseConfigError}</div>
        </div>
      </div>
    );
  }

  if (status === "loading" || status === "checking_membership") {
    return (
      <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Spinner size={22} />
      </div>
    );
  }

  if (status === "signed_out") {
    return <Login s={s} lang={lang} setLang={setLang} />;
  }

  if (status === "not_authorized") {
    return <NotAuthorized s={s} />;
  }

  return <Dashboard lang={lang} setLang={setLang} s={s} />;
}

function Dashboard({ lang, setLang, s }) {
  const [tab, setTab] = useState("overview");
  // Currency lives in module state so every formatter reads it; keeping a copy
  // here is what re-renders the tree when it changes.
  const [currency, setCurrencyUi] = useState(() => restoreCurrency());
  const [fxRate, setFxRate] = useState(null);
  const { session, member, signOut } = useAuth();

  useEffect(() => {
    let active = true;
    loadFxRate().then(rate => { if (active) setFxRate(rate); });
    return () => { active = false; };
  }, []);

  function switchCurrency(next) {
    setCurrencyUi(setCurrency(next));
  }

  const fx = getCurrencyState();
  const usdReady = fxRate != null || fx.dopPerUsd != null;

  const NAV = [
    { id: "overview", label: s.nav.overview, icon: LayoutGrid },
    { id: "acquisition", label: s.nav.acquisition, icon: TrendingUp },
    { id: "funnel", label: s.nav.funnel, icon: Users },
    { id: "retention", label: s.nav.retention, icon: Repeat, flag: true },
    { id: "vip", label: s.nav.vip, icon: Crown },
    { id: "optimization", label: s.nav.optimization, icon: NotebookPen },
    { id: "imports", label: s.nav.imports, icon: UploadCloud },
    { id: "settings", label: s.nav.settings, icon: SlidersHorizontal },
  ];

  return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", fontFamily: "'Inter', -apple-system, sans-serif", color: C.ink }}>
      <div style={{ width: 216, borderRight: `1px solid ${C.panelBorder}`, padding: "22px 14px", display: "flex", flexDirection: "column", gap: 2, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 10px 22px" }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: `linear-gradient(135deg, ${C.accent}, ${C.accentDim})` }} />
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 15 }}>{s.brand}</span>
        </div>
        {NAV.map(item => {
          const active = tab === item.id; const Icon = item.icon;
          return (
            <button key={item.id} onClick={() => setTab(item.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 9, border: "none", cursor: "pointer", textAlign: "left", background: active ? "#1C1013" : "transparent", color: active ? C.ink : C.inkDim, fontSize: 13.5, fontWeight: active ? 600 : 500, position: "relative" }}>
              <Icon size={15} color={active ? C.accent : C.inkFaint} />{item.label}
              {item.flag && <span style={{ marginLeft: "auto", width: 6, height: 6, borderRadius: 99, background: C.accent }} />}
            </button>
          );
        })}
        <div style={{ marginTop: "auto", paddingTop: 20, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ padding: "0 10px", fontSize: 11, color: C.inkFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={session?.user?.email}>
            {member?.name || session?.user?.email}
          </div>
          <div style={{ display: "flex", background: "transparent", border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2 }}
               title={usdReady ? `1 USD = ${(fx.dopPerUsd ?? fxRate)?.toFixed(2)} DOP · ${fx.rateDate ?? ""}` : s.currency.noRate}>
            {["DOP", "USD"].map(code => (
              <button
                key={code}
                onClick={() => switchCurrency(code)}
                disabled={code === "USD" && !usdReady}
                style={{
                  flex: 1, padding: "5px 8px", borderRadius: 7, border: "none",
                  cursor: code === "USD" && !usdReady ? "not-allowed" : "pointer",
                  fontSize: 11.5, fontWeight: 600,
                  background: currency === code ? C.accent : "transparent",
                  color: currency === code ? "#fff" : (code === "USD" && !usdReady ? C.inkFaint : C.inkDim),
                }}
              >{code}</button>
            ))}
          </div>
          {currency === "USD" && usdReady && (
            <div style={{ padding: "0 10px", fontSize: 10.5, color: C.inkFaint }}>
              1 USD = {(fx.dopPerUsd ?? fxRate)?.toFixed(2)} DOP
            </div>
          )}
          <button onClick={() => setLang(l => l === "es" ? "en" : "es")} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 10px", borderRadius: 9, border: `1px solid ${C.panelBorder}`, background: "transparent", color: C.inkDim, fontSize: 12.5, cursor: "pointer" }}>🌐 {lang === "es" ? "Español" : "English"} · {s.langToggle}</button>
          <button onClick={signOut} style={{ width: "100%", padding: "7px 10px", borderRadius: 9, border: "none", background: "transparent", color: C.inkFaint, fontSize: 12, cursor: "pointer" }}>{s.signOut}</button>
        </div>
      </div>

      <div style={{ flex: 1, padding: "26px 32px", overflow: "auto" }}>
        {tab === "overview" && <Overview s={s} lang={lang} />}
        {tab === "acquisition" && <Acquisition s={s} lang={lang} />}
        {tab === "funnel" && <Funnel s={s} lang={lang} />}
        {tab === "retention" && <Retention s={s} lang={lang} />}
        {tab === "vip" && <Vip s={s} lang={lang} />}
        {tab === "optimization" && <Optimization s={s} lang={lang} />}
        {tab === "imports" && <Imports s={s} lang={lang} />}
        {tab === "settings" && <Settings s={s} lang={lang} />}
      </div>
    </div>
  );
}
