import { useEffect, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { Users, Repeat, Target, TrendingUp, Wallet } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { C } from "../lib/theme";
import { getPeriodRange } from "../lib/period";
import { SectionHeading, Panel, KpiCard, PeriodBar, Spinner, deltaOf } from "../components/ui";

async function countInRange(column, start, end) {
  const { count, error } = await supabase
    .from("players")
    .select("*", { count: "exact", head: true })
    .gte(column, start)
    .lt(column, end);
  if (error) throw error;
  return count ?? 0;
}

function bucketKey(dateStr, granularity) {
  const d = new Date(dateStr);
  if (granularity === "day") return d.toISOString().slice(0, 10);
  // ISO week bucket
  const monday = new Date(d);
  const day = d.getDay();
  monday.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day));
  return monday.toISOString().slice(0, 10);
}

export default function Overview({ s, lang }) {
  const [period, setPeriod] = useState("week");
  const [customStart, setCustomStart] = useState(new Date().toISOString().slice(0, 10));
  const [customEnd, setCustomEnd] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const range = getPeriodRange(period, customStart, customEnd);
        const { current, previous } = range;

        const [regCurrent, ftdCurrent, regPrev, ftdPrev] = await Promise.all([
          countInRange("registered_at", current.start, current.end),
          countInRange("first_deposit_date", current.start, current.end),
          previous ? countInRange("registered_at", previous.start, previous.end) : null,
          previous ? countInRange("first_deposit_date", previous.start, previous.end) : null,
        ]);

        // Trend series: registrations & FTDs bucketed over the period
        const granularity = period === "month" ? "week" : "day";
        const { data: regRows, error: regErr } = await supabase
          .from("players")
          .select("registered_at")
          .gte("registered_at", current.start)
          .lt("registered_at", current.end);
        if (regErr) throw regErr;
        const { data: ftdRows, error: ftdErr } = await supabase
          .from("players")
          .select("first_deposit_date")
          .gte("first_deposit_date", current.start)
          .lt("first_deposit_date", current.end);
        if (ftdErr) throw ftdErr;

        const buckets = new Map();
        for (const r of regRows) {
          const k = bucketKey(r.registered_at, granularity);
          buckets.set(k, { ...(buckets.get(k) || { reg: 0, ftd: 0 }), reg: (buckets.get(k)?.reg || 0) + 1 });
        }
        for (const r of ftdRows) {
          const k = bucketKey(r.first_deposit_date, granularity);
          buckets.set(k, { ...(buckets.get(k) || { reg: 0, ftd: 0 }), ftd: (buckets.get(k)?.ftd || 0) + 1 });
        }
        const trend = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, v]) => ({ d, ...v }));

        // Retention: of players registered 30+ days ago, % with a deposit in the last 30 days
        const now = new Date();
        const d30 = new Date(now); d30.setDate(now.getDate() - 30);
        const d30ISO = d30.toISOString();
        const [{ count: eligible }, { count: retained }] = await Promise.all([
          supabase.from("players").select("*", { count: "exact", head: true }).lt("registered_at", d30ISO),
          supabase.from("players").select("*", { count: "exact", head: true }).lt("registered_at", d30ISO).gte("last_deposit_date", d30ISO),
        ]);
        const retention30 = eligible ? (retained / eligible) * 100 : null;

        // CAC:LTV — blended CAC from channel_reports spend/ftds in period, LTV from players' cumulative deposits-withdrawals
        const { data: reportRows, error: repErr } = await supabase
          .from("channel_reports")
          .select("spend_dop, ftds")
          .gte("report_date", current.start)
          .lt("report_date", current.end);
        if (repErr) throw repErr;
        const totalSpend = reportRows.reduce((sum, r) => sum + (r.spend_dop || 0), 0);
        const totalFtds = reportRows.reduce((sum, r) => sum + (r.ftds || 0), 0);
        const cac = totalFtds > 0 ? totalSpend / totalFtds : null;

        const { data: ltvRows, error: ltvErr } = await supabase
          .from("players")
          .select("total_deposit_amount, total_withdrawal_amount")
          .eq("is_ftd", true);
        if (ltvErr) throw ltvErr;
        const ltv = ltvRows.length
          ? ltvRows.reduce((sum, r) => sum + (r.total_deposit_amount || 0) - (r.total_withdrawal_amount || 0), 0) / ltvRows.length
          : null;
        const cacLtvRatio = cac && ltv ? ltv / cac : null;

        // Monthly goal pacing (reg count target)
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        const { data: goalRow } = await supabase
          .from("goals")
          .select("target_value")
          .eq("period_start", monthStart)
          .eq("period_type", "month")
          .eq("metric_name", "new_registrations")
          .maybeSingle();
        let pacePct = null;
        if (goalRow?.target_value) {
          const { count: monthReg } = await supabase
            .from("players")
            .select("*", { count: "exact", head: true })
            .gte("registered_at", monthStart);
          pacePct = ((monthReg || 0) / goalRow.target_value) * 100;
        }

        if (!active) return;
        setData({
          regCurrent, ftdCurrent, regPrev, ftdPrev, trend,
          retention30, cac, ltv, cacLtvRatio, pacePct,
        });
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [period, customStart, customEnd]);

  const periodBarProps = { s, period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd };

  return (
    <>
      <SectionHeading title={s.overviewTitle} />
      <PeriodBar {...periodBarProps} />

      {loading && <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={22} /></div>}
      {error && <Panel style={{ color: C.negative, marginBottom: 20 }}>{error}</Panel>}

      {!loading && !error && data && (
        <>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 26 }}>
            <KpiCard icon={Users} label={s.kpi.reg} value={data.regCurrent.toLocaleString()} delta={deltaOf(data.regCurrent, data.regPrev)?.label} deltaGood={deltaOf(data.regCurrent, data.regPrev)?.positive} />
            <KpiCard icon={Repeat} label={s.kpi.ftd} value={data.ftdCurrent.toLocaleString()} delta={deltaOf(data.ftdCurrent, data.ftdPrev)?.label} deltaGood={deltaOf(data.ftdCurrent, data.ftdPrev)?.positive} />
            <KpiCard icon={Target} label={s.kpi.ftdRate} value={data.regCurrent ? `${((data.ftdCurrent / data.regCurrent) * 100).toFixed(1)}%` : "—"} />
            <KpiCard icon={TrendingUp} label={s.kpi.ret30} value={data.retention30 != null ? `${data.retention30.toFixed(1)}%` : "—"} />
            <KpiCard icon={Wallet} label={s.kpi.caltv} value={data.cacLtvRatio != null ? `1 : ${data.cacLtvRatio.toFixed(1)}` : "—"} />
            <KpiCard icon={Target} label={s.kpi.pace} value={data.pacePct != null ? `${data.pacePct.toFixed(0)}%` : "—"} delta={data.pacePct != null ? s.kpi.onPace : undefined} />
          </div>
          <Panel>
            <div style={{ fontSize: 13, color: C.inkDim, marginBottom: 14 }}>{s.trendTitle}</div>
            {data.trend.length === 0 ? (
              <div style={{ padding: "30px 0", textAlign: "center", color: C.inkFaint, fontSize: 12.5 }}>{s.noData}</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={data.trend}>
                  <defs>
                    <linearGradient id="regGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.inkFaint} stopOpacity={0.35} /><stop offset="100%" stopColor={C.inkFaint} stopOpacity={0} /></linearGradient>
                    <linearGradient id="ftdGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.accent} stopOpacity={0.5} /><stop offset="100%" stopColor={C.accent} stopOpacity={0} /></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.panelBorder} vertical={false} />
                  <XAxis dataKey="d" stroke={C.inkFaint} fontSize={11.5} tickLine={false} axisLine={false} />
                  <YAxis stroke={C.inkFaint} fontSize={11.5} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ background: C.panel, border: `1px solid ${C.panelBorder}`, borderRadius: 8, fontSize: 12 }} />
                  <Area type="monotone" dataKey="reg" stroke={C.inkFaint} fill="url(#regGrad)" strokeWidth={2} name={lang === "es" ? "Registros" : "Registrations"} />
                  <Area type="monotone" dataKey="ftd" stroke={C.accent} fill="url(#ftdGrad)" strokeWidth={2} name="FTD" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
