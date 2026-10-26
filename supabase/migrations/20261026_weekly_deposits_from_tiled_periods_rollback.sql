-- Rollback for 20261026_weekly_deposits_from_tiled_periods.sql.
--
-- Restores the exact-week form. Be aware of what that costs: any week covered
-- by two periods rather than one disappears from the weekly grid again,
-- including 2026-09-28, which is split precisely so the first four days of
-- October land in October.
create or replace view public.deposits_weekly with (security_invoker = true) as
 SELECT d.period_start AS week_start,
    sum(d.deposit_count) AS deposit_count,
    sum(d.deposit_amount) AS deposit_amount,
    count(*) FILTER (WHERE d.deposit_count > 0) AS depositors
   FROM deposit_periods d
     JOIN real_players p ON p.id = d.player_id
  WHERE d.scope = 'primary'::text
    AND d.period_start = date_trunc('week'::text, d.period_start::timestamp with time zone)::date
    AND d.period_end = (d.period_start + 6)
  GROUP BY d.period_start;
