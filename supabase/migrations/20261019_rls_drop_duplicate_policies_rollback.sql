-- Undo 20261019_rls_drop_duplicate_policies.sql: recreate the four duplicate
-- SELECT policies. Written in the wrapped form, to match the state left by
-- 20261019_rls_initplan.sql.

begin;

set local lock_timeout = '10s';

create policy deposit_periods_team_read on public.deposit_periods
  for select using ((select public.is_team_member()));
create policy payment_transactions_team_read on public.payment_transactions
  for select using ((select public.is_team_member()));
create policy player_sport_profile_team_read on public.player_sport_profile
  for select using ((select public.is_team_member()));
create policy "team can view team list" on public.team_members
  for select using ((select public.is_team_member()));

commit;
