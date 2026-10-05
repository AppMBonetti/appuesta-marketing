import { C } from "../lib/theme";
import { Panel, SectionHeading, fmtDOP, EmptyState } from "./ui";
import { weekRangeLabel, formatMonth } from "../lib/period";

/**
 * Deposit volume over time, week by week and month by month.
 *
 * Kept deliberately separate from the funnel above it. The funnel is a
 * registration cohort — "of the people who signed up in this window, how many
 * went on to deposit" — and answers a question about acquisition. This answers
 * a question about money: how much came in, from how many people, and whether
 * that is up or down on the period before. Running both off one period selector
 * was what made the tab read as though it contradicted itself.
 */
function pctChange(current, previous) {
  if (current == null || previous == null || previous === 0) return null;
  return (current - previous) / previous;
}

function Delta({ change }) {
  if (change == null) return <span style={{ color: C.inkFaint, fontSize: 11.5 }}>—</span>;
  const good = change >= 0;
  return (
    <span style={{ color: good ? C.positive : C.negative, fontSize: 11.5, fontVariantNumeric: "tabular-nums" }}>
      {good ? "+" : ""}{(change * 100).toFixed(1)}%
    </span>
  );
}

function Comparison({ title, subtitle, current, previous, s, partial }) {
  const metrics = [
    { label: s.dep.volume, value: fmtDOP(current?.amount), change: pctChange(current?.amount, previous?.amount) },
    { label: s.dep.count, value: current?.count?.toLocaleString() ?? "—", change: pctChange(current?.count, previous?.count) },
    { label: s.dep.depositors, value: current?.depositors?.toLocaleString() ?? "—", change: pctChange(current?.depositors, previous?.depositors) },
    { label: s.dep.avg, value: fmtDOP(current?.count ? current.amount / current.count : null),
      change: pctChange(current?.count ? current.amount / current.count : null,
                        previous?.count ? previous.amount / previous.count : null) },
  ];
  return (
    <Panel style={{ flex: "1 1 340px", minWidth: 300 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: C.inkDim, marginTop: 2 }}>
        {subtitle}
        {partial && <span style={{ color: "#D9A848", marginLeft: 6 }}>{s.dep.partial}</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
        {metrics.map(m => (
          <div key={m.label}>
            <div style={{ fontSize: 11, color: C.inkDim }}>{m.label}</div>
            <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 18, fontWeight: 600, marginTop: 2 }}>
              {m.value}
            </div>
            <Delta change={m.change} />
          </div>
        ))}
      </div>
    </Panel>
  );
}

export default function DepositTrends({ s, lang, weeks, months }) {
  const wk = [...weeks].sort((a, b) => a.week_start.localeCompare(b.week_start));
  const mo = [...months].sort((a, b) => a.month_start.localeCompare(b.month_start));

  const toRow = r => ({
    amount: Number(r.deposit_amount) || 0,
    count: Number(r.deposit_count) || 0,
    depositors: Number(r.depositors) || 0,
  });

  const curWeek = wk.length ? toRow(wk[wk.length - 1]) : null;
  const prevWeek = wk.length > 1 ? toRow(wk[wk.length - 2]) : null;
  const curMonth = mo.length ? toRow(mo[mo.length - 1]) : null;
  const prevMonth = mo.length > 1 ? toRow(mo[mo.length - 2]) : null;

  if (!wk.length && !mo.length) return <EmptyState s={s} />;

  const th = { padding: "9px 12px", textAlign: "right", color: C.inkDim, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" };
  const td = { padding: "8px 12px", fontSize: 12.5, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

  return (
    <>
      <SectionHeading title={s.dep.title} subtitle={s.dep.sub} />

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 22 }}>
        {wk.length > 0 && (
          <Comparison
            s={s} title={s.dep.wow}
            subtitle={weekRangeLabel(wk[wk.length - 1].week_start, lang)}
            current={curWeek} previous={prevWeek}
          />
        )}
        {mo.length > 0 && (
          <Comparison
            s={s} title={s.dep.mom}
            subtitle={formatMonth(mo[mo.length - 1].month_start, lang)}
            current={curMonth} previous={prevMonth}
            partial={mo[mo.length - 1].complete === false}
          />
        )}
      </div>

      {mo.length > 0 && (
        <>
          <SectionHeading title={s.dep.byMonth} />
          <Panel style={{ padding: 4, overflow: "auto", marginBottom: 22 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>{s.dep.period}</th>
                  {[s.dep.volume, s.dep.count, s.dep.depositors, s.dep.avg, s.dep.payouts, s.dep.net].map(h => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...mo].reverse().map(m => (
                  <tr key={m.month_start} style={{ borderTop: `1px solid ${C.panelBorder}` }}>
                    <td style={{ padding: "8px 12px", fontSize: 12.5 }}>
                      {formatMonth(m.month_start, lang)}
                      {m.complete === false && (
                        <span title={s.dep.partialHint.replace("{d}", m.covered_to)}
                          style={{ color: "#D9A848", fontSize: 10.5, marginLeft: 6 }}>
                          {s.dep.partial}
                        </span>
                      )}
                    </td>
                    <td style={{ ...td, fontWeight: 500 }}>{fmtDOP(m.deposit_amount)}</td>
                    <td style={{ ...td, color: C.inkDim }}>{Number(m.deposit_count).toLocaleString()}</td>
                    <td style={td}>{Number(m.depositors).toLocaleString()}</td>
                    <td style={{ ...td, color: C.inkDim }}>{fmtDOP(m.avg_deposit)}</td>
                    <td style={{ ...td, color: C.inkDim }}>{fmtDOP(m.payout_amount)}</td>
                    <td style={{ ...td, color: Number(m.net_cash) < 0 ? C.negative : C.positive }}>
                      {fmtDOP(m.net_cash)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}

      {wk.length > 0 && (
        <>
          <SectionHeading title={s.dep.byWeek} />
          <Panel style={{ padding: 4, overflow: "auto", marginBottom: 22 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>{s.dep.period}</th>
                  {[s.dep.volume, s.dep.count, s.dep.depositors, s.dep.avg, s.dep.wowShort].map(h => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...wk].reverse().map((w, i, arr) => {
                  const prev = arr[i + 1];
                  const change = pctChange(Number(w.deposit_amount), prev ? Number(prev.deposit_amount) : null);
                  const count = Number(w.deposit_count) || 0;
                  return (
                    <tr key={w.week_start} style={{ borderTop: `1px solid ${C.panelBorder}` }}>
                      <td style={{ padding: "8px 12px", fontSize: 12.5 }}>{weekRangeLabel(w.week_start, lang)}</td>
                      <td style={{ ...td, fontWeight: 500 }}>{fmtDOP(w.deposit_amount)}</td>
                      <td style={{ ...td, color: C.inkDim }}>{count.toLocaleString()}</td>
                      <td style={td}>{Number(w.depositors).toLocaleString()}</td>
                      <td style={{ ...td, color: C.inkDim }}>
                        {fmtDOP(count ? Number(w.deposit_amount) / count : null)}
                      </td>
                      <td style={td}><Delta change={change} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        </>
      )}

      <p style={{ color: C.inkFaint, fontSize: 11.5, marginTop: -10, marginBottom: 24 }}>
        {s.dep.grainNote}
      </p>
    </>
  );
}
