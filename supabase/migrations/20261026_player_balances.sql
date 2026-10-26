-- Wallet balances from the player report.
--
-- The backoffice export gained four columns: Cash Balance, Bonus Balance,
-- Total Balance and Wallet Last Updated UTC. They answer a question no other
-- figure here does -- not what a player has been worth, but what they are
-- holding right now -- and that changes how hard you chase someone. A player
-- sitting on 100,000 does not need the same retention push as one at zero.
--
-- What the 2026-10-19..25 file says about these columns, across all 4,403 rows:
--
--   * no nulls in any of the four;
--   * Cash + Bonus = Total in every single row, to the cent;
--   * 580 players hold something, DOP 1,157,145 in all (947,504 cash,
--     209,641 bonus).
--
-- `total_balance` is stored as the report gives it rather than derived from the
-- other two. They agree today, and the importer warns when a file disagrees --
-- better a visible warning than a silent recomputation that hides the export
-- changing its mind about what Total means.
--
-- `wallet_updated_at` is NOT the moment the report was taken. Values run from
-- 2025-12-05 to the morning the file was generated, so it is per player: when
-- that wallet last moved. That makes it a recency signal in its own right, and
-- it is the one timestamp here that can be older than the report by months.
alter table public.players
  add column if not exists cash_balance      numeric,
  add column if not exists bonus_balance     numeric,
  add column if not exists total_balance     numeric,
  add column if not exists wallet_updated_at timestamptz;

comment on column public.players.total_balance is
  'As given by the report, not derived. Equals cash_balance + bonus_balance in every row of the files seen so far; the importer warns if a file disagrees.';
comment on column public.players.wallet_updated_at is
  'When this player''s wallet last moved -- per player, not the report timestamp. Can be months older than the import.';

-- real_players lists its columns one by one, so new columns on players do not
-- reach it on their own. Appended at the end: create or replace view cannot
-- reorder or retype what is already there.
create or replace view public.real_players with (security_invoker = true) as
 SELECT id,
    name,
    email,
    age,
    registered_at,
    first_deposit_date,
    last_deposit_date,
    last_withdrawal_date,
    avg_deposit_amount,
    avg_sportsbook_bet_amount,
    total_deposit_amount,
    total_deposit_count,
    total_ggr_sportsbook,
    total_withdrawal_amount,
    is_ftd,
    days_to_ftd,
    vip_tier,
    acquisition_channel,
    imported_at,
    first_deposit_amount,
    username,
    last_login_at,
    country,
    currency,
    date_of_birth,
    total_withdrawal_count,
    cashed_out_bets,
    cashed_out_count,
    cashback,
    sports_bonus_bets,
    sports_bonus_wins,
    bonus_to_cash,
    report_sports_bets,
    report_sports_wins,
    report_sports_ggr,
    is_internal,
    excluded,
    exclusion_reason,
    excluded_at,
    cash_balance,
    bonus_balance,
    total_balance,
    wallet_updated_at
   FROM players
  WHERE is_internal = false AND excluded = false;

-- player_lifecycle and player_directory carry the balances through to the
-- screens, plus days_since_wallet. That counter is anchored to data_through
-- like every other day counter here, not to CURRENT_DATE (CLAUDE.md): the
-- balance arrives with the weekly import, so measuring its age against today
-- would make it grow on its own between imports.
--
-- Both are created with security_invoker restated. `create or replace view`
-- replaces reloptions wholesale, so leaving it out silently drops it.
--
-- Timed as `authenticated`, naming the expensive column so the sport CTE is
-- not skipped: player_lifecycle 521 ms without the balance column, 537 ms with
-- it -- the four columns cost noise. The first run after the replace measured
-- 1,249 ms with 42 ms of planning; that was a cold plan, not a regression, and
-- it is why one timing is never enough.
--
-- player_directory measured 4.6 ms, which means nothing yet: with no file
-- imported, wallet_updated_at is null in every row, so the CASE never reaches
-- dt.d and the data_through aggregates read `never executed`. Re-time it once
-- real balances are in -- this is the count(*) trap wearing a different hat.
create or replace view public.player_lifecycle with (security_invoker = true) as
 WITH base AS (
         SELECT p.id, p.name, p.username, p.email, p.country, p.vip_tier,
            p.registered_at, p.last_login_at, p.first_deposit_date, p.last_deposit_date,
            COALESCE(p.total_deposit_count, 0) AS raw_deposit_count,
            COALESCE(p.total_deposit_amount, 0::numeric) AS deposits,
            COALESCE(p.total_ggr_sportsbook, 0::numeric) AS ggr,
            COALESCE(p.cashback, 0::numeric) AS cashback,
            p.cash_balance, p.bonus_balance, p.total_balance, p.wallet_updated_at,
            prof.bets, prof.total_stake, prof.avg_stake, prof.median_stake,
            prof.last_bet_date, prof.last_settlement_date, prof.open_bets,
            prof.sports_played, prof.top_sport, prof.top_sport_share,
            GREATEST(prof.last_bet_date, p.last_deposit_date, p.last_login_at) AS last_activity
           FROM real_players p
             JOIN player_bet_profile prof ON prof.id = p.id
        ), scored AS (
         SELECT b.id, b.name, b.username, b.email, b.country, b.vip_tier,
            b.registered_at, b.last_login_at, b.first_deposit_date, b.last_deposit_date,
            b.raw_deposit_count, b.deposits, b.ggr, b.cashback,
            b.cash_balance, b.bonus_balance, b.total_balance, b.wallet_updated_at,
            b.bets, b.total_stake, b.avg_stake, b.median_stake,
            b.last_bet_date, b.last_settlement_date, b.open_bets,
            b.sports_played, b.top_sport, b.top_sport_share, b.last_activity,
            dt.d AS data_through,
                CASE WHEN b.deposits >= min_qualifying_deposit() THEN b.raw_deposit_count ELSE 0 END AS deposit_count,
                CASE WHEN b.last_activity IS NULL THEN NULL::integer ELSE dt.d - local_day(b.last_activity) END AS days_inactive,
                CASE WHEN b.last_login_at IS NULL THEN NULL::integer ELSE dt.d - local_day(b.last_login_at) END AS days_since_login,
                CASE WHEN b.last_deposit_date IS NULL THEN NULL::integer ELSE dt.d - local_day(b.last_deposit_date) END AS days_since_deposit,
                CASE WHEN b.last_bet_date IS NULL THEN NULL::integer ELSE dt.d - local_day(b.last_bet_date) END AS days_since_bet,
                CASE WHEN b.last_settlement_date IS NULL THEN NULL::integer ELSE dt.d - local_day(b.last_settlement_date) END AS days_since_settlement,
                CASE WHEN b.first_deposit_date IS NULL THEN NULL::integer ELSE dt.d - local_day(b.first_deposit_date) END AS days_since_ftd,
                CASE WHEN b.wallet_updated_at IS NULL THEN NULL::integer ELSE dt.d - local_day(b.wallet_updated_at) END AS days_since_wallet
           FROM base b
             CROSS JOIN data_through dt
        )
 SELECT id, name, username, email, country, vip_tier, registered_at, last_login_at,
    first_deposit_date, last_deposit_date, deposit_count, raw_deposit_count,
    deposits, ggr, cashback, bets, total_stake, avg_stake, median_stake,
    last_bet_date, last_settlement_date, open_bets, sports_played, top_sport,
    top_sport_share, last_activity, days_inactive, days_since_login,
    days_since_settlement, days_since_ftd,
    deposits < min_qualifying_deposit() AND raw_deposit_count > 0 AS below_deposit_floor,
    days_since_settlement IS NOT NULL AND days_since_settlement <= 3 OR open_bets > 0 AS has_live_hook,
    (days_since_login IS NOT NULL AND days_since_login <= 7 OR days_since_bet IS NOT NULL AND days_since_bet <= 7) AND (first_deposit_date IS NULL OR last_deposit_date IS NULL OR days_since_deposit >= 8) AS engaged_not_depositing,
        CASE
            WHEN days_since_login IS NULL THEN 'Never logged in'::text
            WHEN days_since_login <= 1 THEN '0-1 days'::text
            WHEN days_since_login <= 7 THEN '2-7 days'::text
            WHEN days_since_login <= 14 THEN '8-14 days'::text
            WHEN days_since_login <= 30 THEN '15-30 days'::text
            ELSE '30+ days'::text
        END AS login_recency,
        CASE
            WHEN deposit_count = 0 OR last_deposit_date IS NULL THEN 'Registered'::text
            WHEN days_since_deposit >= 30 THEN 'Churned'::text
            WHEN days_since_deposit >= 15 THEN 'At risk'::text
            WHEN days_since_deposit >= 8 THEN 'Cooling'::text
            WHEN days_since_ftd IS NOT NULL AND days_since_ftd < 30 AND deposit_count = 1 THEN 'New'::text
            WHEN deposit_count >= 2 OR bets >= 5 THEN 'Active'::text
            ELSE 'Casual'::text
        END AS lifecycle,
    days_since_deposit, days_since_bet, data_through,
    cash_balance, bonus_balance, total_balance, wallet_updated_at, days_since_wallet
   FROM scored;

create or replace view public.player_directory with (security_invoker = true) as
 SELECT p.id, p.username, p.name, p.email,
    COALESCE(p.vip_tier, 'Prospecto'::text) AS vip_tier,
    p.country, p.registered_at, p.last_login_at,
        CASE WHEN p.last_login_at IS NULL THEN NULL::integer ELSE dt.d - local_day(p.last_login_at) END AS days_since_login,
    p.first_deposit_date, p.first_deposit_amount, p.last_deposit_date,
        CASE WHEN p.last_deposit_date IS NULL THEN NULL::integer ELSE dt.d - local_day(p.last_deposit_date) END AS days_since_deposit,
    COALESCE(p.total_deposit_amount, 0::numeric) AS total_deposit_amount,
    COALESCE(p.total_deposit_count, 0) AS total_deposit_count,
    COALESCE(p.total_withdrawal_amount, 0::numeric) AS total_withdrawal_amount,
    COALESCE(p.total_ggr_sportsbook, 0::numeric) AS total_ggr_sportsbook,
    dt.d AS data_through,
    p.cash_balance, p.bonus_balance, p.total_balance, p.wallet_updated_at,
        CASE WHEN p.wallet_updated_at IS NULL THEN NULL::integer ELSE dt.d - local_day(p.wallet_updated_at) END AS days_since_wallet
   FROM real_players p
     CROSS JOIN data_through dt;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'player_lifecycle' and column_name = 'total_balance'
  ) then
    raise exception 'player_lifecycle is missing total_balance';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('real_players', 'player_lifecycle', 'player_directory')
        and array_to_string(c.reloptions, ',') like '%security_invoker=true%') <> 3 then
    raise exception 'security_invoker lost on one of the replaced views';
  end if;
end $$;
