-- APPLIED 2026-11-02. The Acquisition page was showing "canceling statement due
-- to statement timeout" and a weekly grid with only the newest column filled.
--
-- weekly_kpis measured 3,753 ms as `authenticated` -- under the 8 s limit on a
-- warm cache, over it on a cold one, and rising with every week of bets. The
-- whole cost was two function calls in the scan qual over `bets`, and both are
-- the inlining trap this file has now described four times.
--
--   | weekly_kpis, as `authenticated`        |          |
--   |----------------------------------------|----------|
--   | before                                 | 3,753 ms |
--   | bet_counts_as_wagering() inlined       | 2,760 ms |
--   | operations_start() inlined             |   870 ms |
--
-- The Seq Scan on bets alone went 1,385 ms -> 93 ms for the same 54,699 rows.
-- One page of Segments also fell to 171 ms, and every other view that filters
-- `bets` gets the same benefit for free.
--
-- Checked after both changes: weekly_kpis returns byte-identical figures for
-- all 12 weeks, and bet_counts_as_wagering classifies all 56,839 bets exactly
-- as the hand-written predicate does, zero disagreements.

-- ---------------------------------------------------------------------------
-- 1. bet_counts_as_wagering() -- a SET clause that was pure ceremony
-- ---------------------------------------------------------------------------
--
-- IMMUTABLE, but carrying `SET search_path TO 'public'`, which is exactly what
-- stops PostgreSQL inlining a SQL function. It was therefore a real function
-- call once per row, on every scan of `bets`, in every view.
--
-- The body compares a text value against four literals. It touches no table and
-- no schema-qualified object, so the SET clause protected nothing. Rewritten
-- with a standard SQL body (BEGIN ATOMIC), which is parsed and bound when the
-- function is created rather than re-parsed per session -- so dropping the SET
-- clause costs nothing even in principle, and the expression now folds straight
-- into the scan qual.
create or replace function public.bet_counts_as_wagering(bet_status text)
returns boolean
language sql
immutable
parallel safe
begin atomic
  select bet_status is null
      or bet_status not in ('Void', 'VoidCashout', 'Rejected', 'RejectedByPortal');
end;

comment on function public.bet_counts_as_wagering(text) is
  'Whether a bet status counts toward wagering. IMMUTABLE with NO SET clause and a standard SQL body, so PostgreSQL inlines it into the scan qual -- it is called on every row of every scan of bets, and as a non-inlinable function it cost 1,385 ms per scan where the inlined predicate costs 93 ms.';

-- ---------------------------------------------------------------------------
-- 2. operations_start() -- the same trap, plus SECURITY DEFINER
-- ---------------------------------------------------------------------------
--
-- STABLE SECURITY DEFINER with a SET clause, reading app_settings. Either of
-- those alone blocks inlining, so `local_day(bet_date) >= operations_start()`
-- was a per-row function call that queried a table -- and because the result
-- was opaque, no expression index could serve the predicate either.
--
-- The same answer local_day() already uses in this database: the value is a
-- literal, and changing it takes a migration rather than an app_settings
-- update. Operations began on 2026-08-10 and that date cannot change
-- retroactively. The DO block above the function fails the migration if the
-- stored setting ever stops matching, so the two cannot drift -- the same guard
-- shape as local_day_immutable_and_indexed.
--
-- A side effect worth having: it is no longer SECURITY DEFINER, so it has
-- dropped out of both of Supabase's "definer function reachable by anon /
-- authenticated" lints. It reads nothing now, so it needs no elevated rights.
do $$
declare stored date;
begin
  select value::date into stored from app_settings where key = 'operations_start_date';
  if stored is distinct from date '2026-08-10' then
    raise exception
      'app_settings.operations_start_date is % but operations_start() hardcodes 2026-08-10. Change the literal in the function, not the setting.', stored;
  end if;
end $$;

create or replace function public.operations_start()
returns date
language sql
immutable
parallel safe
begin atomic
  select date '2026-08-10';
end;

comment on function public.operations_start() is
  'The day the book opened. A literal, not a lookup: as STABLE SECURITY DEFINER reading app_settings it could not be inlined, so every "since launch" filter became a per-row function call that queried a table and no index could serve the predicate. Changing it needs a migration, and a guard in this one fails if app_settings.operations_start_date stops matching.';

-- Both functions now carry a `function_search_path_mutable` warning from the
-- Supabase linter, exactly as local_day() and local_week() do, and for exactly
-- the same reason: adding the SET clause back would stop them inlining, which is
-- the whole point. Neither touches a table or a schema-qualified object, so
-- there is nothing a search path could redirect.
