import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { formatWeek } from "../lib/period";

/**
 * States how far each source actually reaches. Without it a week label like
 * "10 ago – 23 ago" reads as a claim about data that runs to the 23rd, when the
 * 23rd is simply the end of the current week and hasn't happened.
 */
export default function CoverageBar({ s, lang, weekEnd }) {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("dashboard_health")
        .select("last_registration_day, last_bet_day, ga4_last_date, social_last_date, reporting_timezone")
        .maybeSingle();
      if (active) setHealth(data || null);
    })();
    return () => { active = false; };
  }, []);

  if (!health) return null;

  const today = new Date().toISOString().slice(0, 10);
  const weekStillOpen = weekEnd && weekEnd > today;

  const item = (label, value) => (
    <span key={label} style={{ whiteSpace: "nowrap" }}>
      <span style={{ color: C.inkFaint }}>{label} </span>
      <strong style={{ color: value ? C.ink : C.inkFaint, fontWeight: 600 }}>
        {value ? String(value).slice(0, 10) : s.coverageBar.noneYet}
      </strong>
    </span>
  );

  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 12,
      padding: "10px 14px", marginBottom: 16, display: "flex", alignItems: "center",
      gap: 16, flexWrap: "wrap", fontSize: 12,
    }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: C.inkDim, fontWeight: 600 }}>
        <Database size={13} color={C.accent} /> {s.coverageBar.through}
      </span>
      {item(s.coverageBar.players, health.last_registration_day)}
      {item(s.coverageBar.bets, health.last_bet_day)}
      {item(s.coverageBar.traffic, health.ga4_last_date)}
      {item(s.coverageBar.social, health.social_last_date)}
      <span style={{ color: C.inkFaint, whiteSpace: "nowrap" }}>
        {s.coverageBar.tz}: {health.reporting_timezone}
      </span>
      {weekStillOpen && (
        <span style={{ color: C.negative, whiteSpace: "nowrap" }}>
          {s.coverageBar.partialWeek.replace("{d}", formatWeek(weekEnd, lang))}
        </span>
      )}
    </div>
  );
}
