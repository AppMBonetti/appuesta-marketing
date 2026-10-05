import { C } from "../lib/theme";
import { Panel, SectionHeading, fmtDOP } from "./ui";

/**
 * Deposits per calendar day, and the attempts that never landed.
 *
 * Both come from the transaction export and neither is answerable from the
 * grouped payments report: that one sums a date range without naming a day, and
 * reports only money that arrived. A rail failing most of the time is invisible
 * in it — which is how a 5% success rate went unnoticed.
 */
export default function DepositDaily({ s, lang, days, methods }) {
  if (!days?.length && !methods?.length) return null;

  const recent = [...days].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 31);
  const byMethod = [...methods].sort((a, b) => Number(b.attempts) - Number(a.attempts));

  const totals = days.reduce((acc, d) => ({
    count: acc.count + Number(d.deposit_count || 0),
    amount: acc.amount + Number(d.deposit_amount || 0),
  }), { count: 0, amount: 0 });
  const attempts = byMethod.reduce((acc, m) => ({
    attempts: acc.attempts + Number(m.attempts || 0),
    completed: acc.completed + Number(m.completed || 0),
    failed: acc.failed + Number(m.failed || 0),
    lost: acc.lost + Number(m.lost_amount || 0),
  }), { attempts: 0, completed: 0, failed: 0, lost: 0 });
  const successPct = attempts.completed + attempts.failed > 0
    ? (100 * attempts.completed) / (attempts.completed + attempts.failed) : null;

  const th = { padding: "9px 12px", textAlign: "right", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" };
  const td = { padding: "8px 12px", fontSize: 12.5, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
  const maxAmount = Math.max(...recent.map(d => Number(d.deposit_amount) || 0), 1);

  return (
    <>
      {byMethod.length > 0 && (
        <>
          <SectionHeading title={s.dep.successTitle} subtitle={s.dep.successSub} />
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
            <Panel style={{ flex: "1 1 200px", minWidth: 180 }}>
              <div style={{ fontSize: 11, color: C.inkDim }}>{s.dep.successRate}</div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 24, fontWeight: 600, marginTop: 4,
                color: successPct != null && successPct < 80 ? C.negative : C.ink }}>
                {successPct == null ? "—" : `${successPct.toFixed(0)}%`}
              </div>
              <div style={{ fontSize: 11.5, color: C.inkDim, marginTop: 2 }}>
                {s.dep.ofAttempts.replace("{n}", attempts.attempts.toLocaleString())}
              </div>
            </Panel>
            <Panel style={{ flex: "1 1 200px", minWidth: 180 }}>
              <div style={{ fontSize: 11, color: C.inkDim }}>{s.dep.lost}</div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 24, fontWeight: 600, marginTop: 4, color: C.negative }}>
                {fmtDOP(attempts.lost)}
              </div>
              <div style={{ fontSize: 11.5, color: C.inkDim, marginTop: 2 }}>
                {s.dep.failedAttempts.replace("{n}", attempts.failed.toLocaleString())}
              </div>
            </Panel>
          </div>

          <Panel style={{ padding: 4, overflow: "auto", marginBottom: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>{s.dep.method}</th>
                  {[s.dep.completed, s.dep.failedCol, s.dep.rate, s.dep.landed, s.dep.lostCol].map(h => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {byMethod.map(m => {
                  const pct = m.success_pct == null ? null : Number(m.success_pct);
                  return (
                    <tr key={`${m.provider}-${m.method}`} style={{ borderTop: `1px solid ${C.panelBorder}` }}>
                      <td style={{ padding: "8px 12px", fontSize: 12.5 }}>
                        {m.method}
                        <span style={{ color: C.inkFaint, fontSize: 11, marginLeft: 6 }}>{m.provider}</span>
                      </td>
                      <td style={{ ...td, color: C.inkDim }}>{Number(m.completed).toLocaleString()}</td>
                      <td style={{ ...td, color: C.inkDim }}>{Number(m.failed).toLocaleString()}</td>
                      <td style={{ ...td, fontWeight: 600, color: pct == null ? C.inkFaint : pct < 50 ? C.negative : pct < 80 ? "#D9A848" : C.positive }}>
                        {pct == null ? "—" : `${pct.toFixed(0)}%`}
                      </td>
                      <td style={td}>{fmtDOP(m.completed_amount)}</td>
                      <td style={{ ...td, color: C.negative }}>{fmtDOP(m.lost_amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
          <p style={{ color: C.inkFaint, fontSize: 11.5, marginBottom: 24 }}>{s.dep.successNote}</p>
        </>
      )}

      {recent.length > 0 && (
        <>
          <SectionHeading title={s.dep.dailyTitle} subtitle={s.dep.dailySub} />
          <Panel style={{ padding: 4, overflow: "auto", marginBottom: 24 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>{s.dep.day}</th>
                  {[s.dep.volume, s.dep.count, s.dep.depositors, s.dep.avg].map(h => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                  <th style={{ ...th, textAlign: "left", width: "28%" }} />
                </tr>
              </thead>
              <tbody>
                {recent.map(d => {
                  const amount = Number(d.deposit_amount) || 0;
                  return (
                    <tr key={d.day} style={{ borderTop: `1px solid ${C.panelBorder}` }}>
                      <td style={{ padding: "8px 12px", fontSize: 12.5 }}>
                        {new Date(`${d.day}T12:00:00Z`).toLocaleDateString(lang === "es" ? "es-DO" : "en-GB",
                          { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}
                      </td>
                      <td style={{ ...td, fontWeight: 500 }}>{fmtDOP(amount)}</td>
                      <td style={{ ...td, color: C.inkDim }}>{Number(d.deposit_count).toLocaleString()}</td>
                      <td style={td}>{Number(d.depositors).toLocaleString()}</td>
                      <td style={{ ...td, color: C.inkDim }}>{fmtDOP(d.avg_deposit)}</td>
                      <td style={{ padding: "8px 12px" }}>
                        <div style={{ background: "#1D222B", borderRadius: 4, height: 8 }}>
                          <div style={{ width: `${Math.max((amount / maxAmount) * 100, 1)}%`, height: "100%", borderRadius: 4, background: C.accent }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
          <p style={{ color: C.inkFaint, fontSize: 11.5, marginTop: -16, marginBottom: 24 }}>
            {s.dep.dailyTotals
              .replace("{n}", totals.count.toLocaleString())
              .replace("{amt}", fmtDOP(totals.amount))
              .replace("{d}", String(days.length))}
          </p>
        </>
      )}
    </>
  );
}
