-- Rollback for 20261026_player_balances.sql.
--
-- Restores the three views to the shape they had before the balance columns,
-- then drops the columns. Order matters: a column cannot be dropped while a
-- view still selects it, and `create or replace view` cannot remove a column,
-- so each view is dropped and recreated rather than replaced.
--
-- Dropping the columns loses the imported balances, which is harmless: they are
-- restated in full by the next player report, unlike player_notes.
drop view if exists public.player_directory;
drop view if exists public.player_lifecycle;
drop view if exists public.real_players cascade;

create or replace view public.real_players with (security_invoker = true) as
 SELECT id, name, email, age, registered_at, first_deposit_date, last_deposit_date,
    last_withdrawal_date, avg_deposit_amount, avg_sportsbook_bet_amount,
    total_deposit_amount, total_deposit_count, total_ggr_sportsbook,
    total_withdrawal_amount, is_ftd, days_to_ftd, vip_tier, acquisition_channel,
    imported_at, first_deposit_amount, username, last_login_at, country, currency,
    date_of_birth, total_withdrawal_count, cashed_out_bets, cashed_out_count,
    cashback, sports_bonus_bets, sports_bonus_wins, bonus_to_cash,
    report_sports_bets, report_sports_wins, report_sports_ggr,
    is_internal, excluded, exclusion_reason, excluded_at
   FROM players
  WHERE is_internal = false AND excluded = false;

-- player_lifecycle and player_directory are then recreated from the bodies in
-- 20261021_anchor_recency_to_data.sql, which is the last migration that owned
-- them before this one. Take them from there rather than retyping: they carry
-- the data_through anchoring, and a hand-copy is how a day counter quietly goes
-- back to CURRENT_DATE.
--
-- `cascade` above drops both; nothing else depends on real_players.

alter table public.players
  drop column if exists cash_balance,
  drop column if exists bonus_balance,
  drop column if exists total_balance,
  drop column if exists wallet_updated_at;
