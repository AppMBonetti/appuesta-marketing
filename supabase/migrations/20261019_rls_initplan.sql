-- APPLIED 2026-10-19. All 28 policies are on the wrapped form; access verified
-- unchanged afterwards (team member sees 1,458 / 2 / 33,522 / 3,714 / 9 across
-- deposit_periods, team_members, bets, players, sport_aliases; an authenticated
-- non-team user sees 0 in every one). Measured after applying: weekly_kpis
-- 1,943-3,053 ms against a 5,340 ms baseline, player_lifecycle 641 ms against
-- 2,934 ms.
--
-- It went in as five small batches rather than one statement: the ACCESS
-- EXCLUSIVE lock wait on bets kept exceeding the 60s tool limit. Each batch was
-- its own transaction, which is safe here because both forms of the qual grant
-- identical access, so a partial state can only be slow, never wrong.
--
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
--
-- This does not change who can read what. is_team_member() takes no arguments
-- and reads only the JWT, so its value cannot vary between rows of one
-- statement; hoisting it is therefore semantics-preserving by construction.
-- Row counts were identical before and after (3,470 players, 30,950 bets).
--
-- Production context: weekly_kpis averaged 5,059 ms and peaked at 7,873 ms
-- through PostgREST against an 8s statement_timeout, which is what the
-- "canceling statement due to statement timeout" banners were.

begin;

-- ALTER POLICY takes ACCESS EXCLUSIVE on each table, and while it waits, every
-- new query on that table queues behind it. Give up rather than freeze the
-- dashboard: four test runs were killed by this lock wait, so it is not
-- theoretical. Run this when nobody is on the dashboard.
set local lock_timeout = '10s';

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
alter policy deposit_periods_team_read on public.deposit_periods using ((select public.is_team_member()));
alter policy deposit_periods_team_write on public.deposit_periods using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.fx_rates using ((select public.is_team_member()));
alter policy "team full access" on public.ga4_channel_daily using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.goals using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy manual_daily_metrics_team on public.manual_daily_metrics using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.optimization_notes using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy payment_transactions_team_read on public.payment_transactions using ((select public.is_team_member()));
alter policy payment_transactions_team_write on public.payment_transactions using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy player_sport_profile_team_read on public.player_sport_profile using ((select public.is_team_member()));
alter policy player_sport_profile_team_write on public.player_sport_profile using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.players using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.social_daily using ((select public.is_team_member()));
alter policy sport_aliases_team_read on public.sport_aliases using ((select public.is_team_member()));
alter policy "team can manage team list" on public.team_members using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team can view team list" on public.team_members using ((select public.is_team_member()));
alter policy "team full access" on public.vip_tiers using ((select public.is_team_member())) with check ((select public.is_team_member()));
alter policy "team full access" on public.weekly_spend using ((select public.is_team_member()));

-- All 28 policies must end up on the wrapped form and none may be lost. Inside
-- the transaction, so a failure rolls the whole thing back rather than leaving
-- half the tables converted.
do $$
declare bare int; total int;
begin
  select count(*) filter (where qual = 'is_team_member()'), count(*)
    into bare, total
  from pg_policies where schemaname = 'public';

  if total <> 28 then
    raise exception 'Expected 28 policies, found % -- did something else change RLS?', total;
  end if;
  if bare > 0 then
    raise exception 'Incomplete: % of % policies still evaluate per row', bare, total;
  end if;
end $$;

commit;
