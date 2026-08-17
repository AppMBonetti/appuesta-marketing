import { ShieldAlert } from "lucide-react";
import { C } from "../lib/theme";
import { useAuth } from "../lib/AuthContext";

export default function NotAuthorized({ s }) {
  const { session, signOut } = useAuth();

  return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', -apple-system, sans-serif", color: C.ink, padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 400, background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 16, padding: 28, textAlign: "center" }}>
        <ShieldAlert size={28} color={C.negative} style={{ marginBottom: 12 }} />
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, fontFamily: "'Space Grotesk', sans-serif" }}>{s.notAuthorizedTitle}</div>
        <div style={{ fontSize: 12.5, color: C.inkDim, marginBottom: 18 }}>{s.notAuthorizedSub}</div>
        <div style={{ fontSize: 12, color: C.inkFaint, marginBottom: 18 }}>{s.signedInAs}: {session?.user?.email}</div>
        <button onClick={signOut} style={{ padding: "9px 18px", borderRadius: 9, border: `1px solid ${C.panelBorder}`, background: "transparent", color: C.ink, fontSize: 13, cursor: "pointer" }}>
          {s.signOut}
        </button>
      </div>
    </div>
  );
}
