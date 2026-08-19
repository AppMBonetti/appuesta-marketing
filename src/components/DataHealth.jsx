import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { SectionHeading, Panel, Spinner } from "./ui";

const fill = (template, values) =>
  Object.entries(values).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, String(v)), template);

/**
 * Turns the readiness counters into plain statements. An empty figure on a
 * dashboard is indistinguishable from a zero, so every gap is stated here with
 * the reason and the action that closes it.
 */
function buildChecks(h, s) {
  if (!h) return [];
  const checks = [];

  const betNotes = [];
  if (Number(h.bets) === 0) betNotes.push({ level: "bad", text: s.health.betsNone });
  else betNotes.push({ level: "ok", text: fill(s.health.betsOk, { n: Number(h.bets).toLocaleString() }) });
  if (Number(h.missing_bet_days) > 0) betNotes.push({ level: "warn", text: fill(s.health.betsGaps, { n: h.missing_bet_days }) });
  if (Number(h.stale_open_bets) > 0) betNotes.push({ level: "warn", text: fill(s.health.staleOpen, { n: h.stale_open_bets }) });
  checks.push({ label: s.health.bets, notes: betNotes });

  const snapNotes = [];
  const days = Number(h.snapshot_days);
  if (days <= 1) {
    snapNotes.push({ level: "bad", text: fill(s.health.snapshotsOne, { d: h.first_snapshot ?? "—" }) });
  } else {
    snapNotes.push({ level: "ok", text: fill(s.health.snapshotsOk, { n: days, a: h.first_snapshot, b: h.last_snapshot }) });
  }
  if (Number(h.weeks_without_deposits) > 0) {
    snapNotes.push({ level: "warn", text: fill(s.health.snapshotsWeeks, { n: h.weeks_without_deposits, t: h.weeks_total }) });
  }
  checks.push({ label: s.health.snapshots, notes: snapNotes });

  const known = Number(h.ftd_amount_known);
  const totalFtd = Number(h.ftd_players);
  checks.push({
    label: s.health.ftd,
    notes: [totalFtd > 0 && known >= totalFtd
      ? { level: "ok", text: fill(s.health.ftdOk, { t: totalFtd }) }
      : { level: "warn", text: fill(s.health.ftdPartial, { n: known, t: totalFtd }) }],
  });

  checks.push({
    label: s.health.ga4,
    notes: [Number(h.ga4_rows) === 0
      ? { level: "bad", text: s.health.ga4None }
      : { level: "ok", text: fill(s.health.ga4Ok, { n: h.ga4_rows, d: h.ga4_last_date }) }],
  });

  checks.push({
    label: s.health.social,
    notes: [Number(h.social_rows) === 0
      ? { level: "warn", text: s.health.socialNone }
      : { level: "ok", text: fill(s.health.socialOk, { n: h.social_rows, d: h.social_last_date }) }],
  });

  checks.push({
    label: s.health.spend,
    notes: [Number(h.weeks_without_spend) > 0
      ? { level: "warn", text: fill(s.health.spendMissing, { n: h.weeks_without_spend }) }
      : { level: "ok", text: s.health.spendOk }],
  });

  return checks;
}

const LEVELS = {
  ok: { Icon: CheckCircle2, color: C.positive },
  warn: { Icon: AlertTriangle, color: C.negative },
  bad: { Icon: XCircle, color: C.accent },
};

export default function DataHealth({ s }) {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase.from("dashboard_health").select("*").maybeSingle();
      if (!active) return;
      setHealth(data || null);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 30 }}><Spinner size={20} /></div>;

  const checks = buildChecks(health, s);
  const worst = level => (level === "bad" ? 2 : level === "warn" ? 1 : 0);

  return (
    <>
      <SectionHeading title={s.health.title} subtitle={s.health.sub} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
        {checks.map(check => {
          const top = check.notes.reduce((acc, n) => (worst(n.level) > worst(acc) ? n.level : acc), "ok");
          const { Icon, color } = LEVELS[top];
          return (
            <Panel key={check.label} style={{ padding: "13px 16px", display: "flex", gap: 11, alignItems: "flex-start" }}>
              <Icon size={15} color={color} style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{check.label}</div>
                {check.notes.map((note, i) => (
                  <div key={i} style={{ fontSize: 12, color: note.level === "ok" ? C.inkDim : LEVELS[note.level].color, lineHeight: 1.55, marginTop: i ? 3 : 0 }}>
                    {note.text}
                  </div>
                ))}
              </div>
            </Panel>
          );
        })}
      </div>
    </>
  );
}
