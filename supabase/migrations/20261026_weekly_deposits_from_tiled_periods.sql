-- APPLIED 2026-10-26. A week whose days are fully covered counts, however the
-- payments reports that cover it were cut.
--
-- deposits_weekly required a single period running exactly Monday to Sunday.
-- That held until the week of 28/09-04/10 had to be split into 28/09-30/09 and
-- 01/10-04/10, which is the only way to stop a week that straddles a month
-- boundary from putting four days of October into nowhere. The moment it was
-- split, the week vanished from the weekly grid: two periods, neither of them
-- a whole week, so neither matched.
--
-- Losing a week to fix a month is not a trade worth making, and it is not
-- necessary. The two halves tile the week exactly, so the week is fully known;
-- only the shape of the evidence changed.
--
-- A week is reported when its primary periods cover all seven days. Each period
-- must sit inside a single week (period_end no later than that week's Sunday),
-- and the day counts must add to 7 -- with no overlapping primary periods, which
-- the importer prevents, that is exact tiling.
--
-- Verified against the figures the grid showed before the split: the week of
-- 2026-09-28 comes back as 449 deposits, DOP 1,183,680, 199 depositors --
-- identical to the single-period version, from 3 days plus 4.
--
-- depositors counts DISTINCT players now. With one period per week the old
-- count(*) filter was already distinct, since the table holds one row per
-- player per period; across two periods a player who deposited in both halves
-- would have been counted twice.
create or replace view public.deposits_weekly with (security_invoker = true) as
with p as (
  select d.player_id, d.deposit_count, d.deposit_amount,
         d.period_start, d.period_end,
         date_trunc('week', d.period_start::timestamp)::date as wk
    from deposit_periods d
    join real_players rp on rp.id = d.player_id
   where d.scope = 'primary'
     and d.period_end <= date_trunc('week', d.period_start::timestamp)::date + 6
),
covered as (
  select wk, sum(period_end - period_start + 1) as days
    from (select distinct wk, period_start, period_end from p) x
   group by wk
)
select p.wk as week_start,
       sum(p.deposit_count) as deposit_count,
       sum(p.deposit_amount) as deposit_amount,
       count(distinct p.player_id) filter (where p.deposit_count > 0) as depositors
  from p
  join covered c on c.wk = p.wk and c.days = 7
 group by p.wk;

do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'deposits_weekly'
      and array_to_string(c.reloptions, ',') like '%security_invoker=true%'
  ) then
    raise exception 'security_invoker missing on deposits_weekly';
  end if;

  -- The week that prompted this: covered by two periods, and it must report.
  if not exists (select 1 from deposits_weekly where week_start = '2026-09-28') then
    raise exception 'the split week of 2026-09-28 is still missing from deposits_weekly';
  end if;
end $$;
