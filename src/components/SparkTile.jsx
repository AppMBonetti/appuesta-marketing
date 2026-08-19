import { AreaChart, Area, ResponsiveContainer, YAxis } from "recharts";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import { C } from "../lib/theme";

/**
 * A KPI tile carrying its own trend. `better` decides the colour of the change
 * independently of its sign, so a falling cost per acquisition reads as good.
 */
export default function SparkTile({ label, value, change, better = "up", series = [], accent = C.accent }) {
  const good = change == null ? null : (better === "up" ? change >= 0 : change <= 0);
  const changeColor = good == null ? C.inkFaint : good ? C.positive : C.negative;
  const Icon = change == null ? Minus : change >= 0 ? ArrowUpRight : ArrowDownRight;
  const points = series.filter(v => v != null);
  const flat = points.length > 0 && points.every(v => v === points[0]);

  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 14,
      padding: "16px 18px 10px", flex: "1 1 190px", minWidth: 190,
      display: "flex", flexDirection: "column", gap: 6, overflow: "hidden",
    }}>
      <span style={{ color: C.inkDim, fontSize: 11.5, letterSpacing: 0.3, textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </span>
      <div style={{ fontSize: 23, fontWeight: 600, color: C.ink, fontVariantNumeric: "tabular-nums", fontFamily: "'Space Grotesk', sans-serif", lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: changeColor, minHeight: 17 }}>
        <Icon size={12} />
        {change == null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`}
      </div>
      <div style={{ height: 34, margin: "0 -18px -10px" }}>
        {points.length > 1 && !flat && (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series.map((v, i) => ({ i, v }))}>
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <Area type="monotone" dataKey="v" stroke={accent} strokeWidth={1.6} fill={accent} fillOpacity={0.16} dot={false} connectNulls isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
