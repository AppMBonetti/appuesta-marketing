-- Undo 20261019_rls_initplan.sql.
--
-- Restores the per-row form of every policy and recreates the four duplicate
-- SELECT policies, putting RLS back exactly as it was. Running this brings the
-- timeouts back, so it is here for safety rather than because anyone should
-- want it.

set lock_timeout = '10s';

alter policy "team full access" on public.affiliate_payouts using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.affiliate_players using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.affiliate_users using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.affiliates using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.app_settings using (public.is_team_member());
alter policy "team full access" on public.bets using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.budgets using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.channel_budgets using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.channel_reports using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.data_imports using (public.is_team_member()) with check (public.is_team_member());
alter policy deposit_periods_team_write on public.deposit_periods using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.fx_rates using (public.is_team_member());
alter policy "team full access" on public.ga4_channel_daily using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.goals using (public.is_team_member()) with check (public.is_team_member());
alter policy manual_daily_metrics_team on public.manual_daily_metrics using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.optimization_notes using (public.is_team_member()) with check (public.is_team_member());
alter policy payment_transactions_team_write on public.payment_transactions using (public.is_team_member()) with check (public.is_team_member());
alter policy player_sport_profile_team_write on public.player_sport_profile using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.players using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.social_daily using (public.is_team_member());
alter policy sport_aliases_team_read on public.sport_aliases using (public.is_team_member());
alter policy "team can manage team list" on public.team_members using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.vip_tiers using (public.is_team_member()) with check (public.is_team_member());
alter policy "team full access" on public.weekly_spend using (public.is_team_member());

create policy deposit_periods_team_read on public.deposit_periods
  for select using (public.is_team_member());
create policy payment_transactions_team_read on public.payment_transactions
  for select using (public.is_team_member());
create policy player_sport_profile_team_read on public.player_sport_profile
  for select using (public.is_team_member());
create policy "team can view team list" on public.team_members
  for select using (public.is_team_member());
