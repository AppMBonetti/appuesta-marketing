-- Evaluate the RLS check once per query instead of once per row.
--
-- Every table here is gated by `using (is_team_member())`. That function is
-- STABLE SECURITY DEFINER with a SET clause, which is the combination
-- PostgreSQL refuses to inline (the same trap documented in CLAUDE.md for
-- local_day(), but in the policy rather than the view). A bare call in a policy
-- qual is therefore evaluated per row, and each call runs a real query against
-- team_members.
--
-- Wrapping it in a scalar subquery makes the planner hoist it into an InitPlan,
-- evaluated once for the whole statement. Measured on weekly_kpis as the
-- `authenticated` role with a real team JWT, changing only players and bets:
--
--     before   5,340 ms      Filter: is_team_member()         per row
--     after    2,130 ms      Filter: (InitPlan 3).col1        once
--
-- RLS also distorted the plan shape: the bets scan was a Nested Loop of 3,470
-- iterations and became a Hash Join again once the qual stopped being opaque.
-- Row counts were identical before and after (3,470 players, 30,950 bets), so
-- this changes performance only -- the same people see exactly the same rows.
--
-- Production context: weekly_kpis averaged 5,059 ms and peaked at 7,873 ms
-- through PostgREST against an 8s statement_timeout, which is what the
-- "canceling statement due to statement timeout" banners were.

-- ALTER POLICY takes ACCESS EXCLUSIVE on each table, so it waits behind
-- in-flight dashboard queries. Fail fast rather than queue up behind a slow
-- read and block every other session behind us.
set lock_timeout = '10s';

alter policy "team full access" on public.affiliate_payouts using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.affiliate_players using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.affiliate_users using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.affiliates using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.app_settings using ((select public.is_team_member()));
alter policy "team full access" on public.bets using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.budgets using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.channel_budgets using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.channel_reports using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.data_imports using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy deposit_periods_team_write on public.deposit_periods using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.fx_rates using ((select public.is_team_member()));
alter policy "team full access" on public.ga4_channel_daily using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.goals using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy manual_daily_metrics_team on public.manual_daily_metrics using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.optimization_notes using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy payment_transactions_team_write on public.payment_transactions using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy player_sport_profile_team_write on public.player_sport_profile using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.players using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.social_daily using ((select public.is_team_member()));
alter policy sport_aliases_team_read on public.sport_aliases using ((select public.is_team_member()));
alter policy "team can manage team list" on public.team_members using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.vip_tiers using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.weekly_spend using ((select public.is_team_member()));

-- Four tables carry a SELECT policy that duplicates an ALL policy on the same
-- table with an identical qual, so the check ran twice per row for no gain.
-- Dropping the SELECT one leaves the ALL policy, which already permits SELECT
-- with the same condition: nobody loses access. Supabase's linter flags these
-- as multiple_permissive_policies.
--
-- sport_aliases_team_read is deliberately NOT dropped: it is the only policy on
-- that table, so dropping it would lock the team out of it.
drop policy deposit_periods_team_read on public.deposit_periods;
drop policy payment_transactions_team_read on public.payment_transactions;
drop policy player_sport_profile_team_read on public.player_sport_profile;
drop policy "team can view team list" on public.team_members;

-- Every remaining policy must be on the wrapped form. Fails the migration
-- rather than leaving it half applied.
do $$
declare bare int; total int;
begin
  select count(*) filter (where qual = 'is_team_member()'), count(*)
    into bare, total
  from pg_policies where schemaname = 'public';

  if bare > 0 then
    raise exception 'RLS migration incomplete: % of % policies still evaluate per row', bare, total;
  end if;
  if total <> 24 then
    raise exception 'Expected 24 policies after the migration, found %', total;
  end if;
end $$;
