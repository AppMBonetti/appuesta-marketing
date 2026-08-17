import { useState } from "react";
import { Mail, CheckCircle2, AlertCircle } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { Spinner } from "../components/ui";

export default function Login({ s, lang, setLang }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent | error

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setState("sending");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setState(error ? "error" : "sent");
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', -apple-system, sans-serif", color: C.ink, padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", marginBottom: 28 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: `linear-gradient(135deg, ${C.accent}, ${C.accentDim})` }} />
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 18 }}>{s.brand}</span>
        </div>

        <div style={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 16, padding: 28 }}>
          {state === "sent" ? (
            <div style={{ textAlign: "center" }}>
              <CheckCircle2 size={28} color={C.positive} style={{ marginBottom: 12 }} />
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{s.linkSent}</div>
              <div style={{ fontSize: 12.5, color: C.inkDim }}>{s.linkSentSub}</div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, fontFamily: "'Space Grotesk', sans-serif" }}>{s.loginTitle}</div>
              <div style={{ fontSize: 12.5, color: C.inkDim, marginBottom: 20 }}>{s.loginSub}</div>
              <form onSubmit={handleSubmit}>
                <label style={{ fontSize: 11.5, color: C.inkDim, textTransform: "uppercase", letterSpacing: 0.3 }}>{s.emailLabel}</label>
                <div style={{ position: "relative", marginTop: 6, marginBottom: 16 }}>
                  <Mail size={15} color={C.inkFaint} style={{ position: "absolute", left: 12, top: 12 }} />
                  <input
                    type="email"
                    required
                    autoFocus
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder={s.emailPlaceholder}
                    style={{ width: "100%", background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 9, color: C.ink, padding: "10px 12px 10px 34px", fontSize: 13.5 }}
                  />
                </div>
                {state === "error" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.negative, marginBottom: 14 }}>
                    <AlertCircle size={13} /> {s.authError}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={state === "sending"}
                  style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 16px", borderRadius: 9, border: "none", background: C.accent, color: "#fff", fontSize: 13.5, fontWeight: 500, cursor: state === "sending" ? "default" : "pointer", opacity: state === "sending" ? 0.75 : 1 }}
                >
                  {state === "sending" && <Spinner />}
                  {state === "sending" ? s.sendingLink : s.sendLink}
                </button>
              </form>
            </>
          )}
        </div>

        <div style={{ textAlign: "center", marginTop: 18 }}>
          <button onClick={() => setLang(l => l === "es" ? "en" : "es")} style={{ background: "transparent", border: "none", color: C.inkFaint, fontSize: 12, cursor: "pointer" }}>
            🌐 {lang === "es" ? "Español" : "English"} · {s.langToggle}
          </button>
        </div>
      </div>
    </div>
  );
}
