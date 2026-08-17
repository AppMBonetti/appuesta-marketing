import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import { C } from "../lib/theme";

export function KpiCard({ icon: Icon, label, value, delta, deltaGood = true }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 14, padding: "18px 20px", flex: 1, minWidth: 168, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: C.inkDim, fontSize: 12, letterSpacing: 0.3, textTransform: "uppercase" }}>{label}</span>
        <Icon size={15} color={C.accent} strokeWidth={2} />
      </div>
      <div style={{ fontSize: 26, fontWeight: 600, color: C.ink, fontVariantNumeric: "tabular-nums", fontFamily: "'Space Grotesk', sans-serif" }}>{value}</div>
      {delta && <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12.5, color: deltaGood ? C.positive : C.negative }}>{deltaGood ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{delta}</div>}
    </div>
  );
}

export function SectionHeading({ title, subtitle }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 19, color: C.ink, margin: 0, fontWeight: 600 }}>{title}</h2>
      {subtitle && <p style={{ color: C.inkDim, fontSize: 13, margin: "4px 0 0" }}>{subtitle}</p>}
    </div>
  );
}

export function Panel({ children, style }) {
  return <div style={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 14, padding: 20, ...style }}>{children}</div>;
}

export function PeriodBar({ s, period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
      <div style={{ display: "flex", background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 9, padding: 3, gap: 2 }}>
        {["week", "month", "custom"].map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{ padding: "6px 14px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 500, background: period === p ? C.accent : "transparent", color: period === p ? "#fff" : C.inkDim }}>{s.period[p]}</button>
        ))}
      </div>
      {period === "custom" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.inkDim }}>
          <span>{s.from}</span>
          <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} style={{ background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 7, color: C.ink, padding: "5px 8px", fontSize: 12.5 }} />
          <span>{s.to}</span>
          <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} style={{ background: "#1D222B", border: `1px solid ${C.panelBorder}`, borderRadius: 7, color: C.ink, padding: "5px 8px", fontSize: 12.5 }} />
        </div>
      ) : <span style={{ fontSize: 12, color: C.inkFaint }}>{period === "week" ? s.period.vsWeek : s.period.vsMonth}</span>}
    </div>
  );
}

export function EmptyState({ s, icon: Icon }) {
  return (
    <Panel style={{ textAlign: "center", padding: "48px 24px" }}>
      {Icon && <Icon size={28} color={C.inkFaint} style={{ marginBottom: 12 }} />}
      <div style={{ fontSize: 14.5, fontWeight: 600, color: C.ink, marginBottom: 6 }}>{s.noData}</div>
      <div style={{ fontSize: 12.5, color: C.inkDim, maxWidth: 380, margin: "0 auto" }}>{s.noDataSub}</div>
    </Panel>
  );
}

export function Spinner({ size = 14 }) {
  return (
    <span style={{
      display: "inline-block", width: size, height: size, borderRadius: "50%",
      border: `2px solid ${C.panelBorder}`, borderTopColor: C.accent,
      animation: "spin 0.7s linear infinite",
    }} />
  );
}

export function fmtDOP(n) {
  if (n == null || n === "") return "—";
  return "DOP " + Number(n).toLocaleString("es-DO", { maximumFractionDigits: 0 });
}

export function deltaOf(curr, prev) {
  if (prev === 0 || prev == null || curr == null) return null;
  const d = ((curr - prev) / prev) * 100;
  return { positive: d >= 0, label: `${d >= 0 ? "+" : ""}${d.toFixed(1)}%` };
}
