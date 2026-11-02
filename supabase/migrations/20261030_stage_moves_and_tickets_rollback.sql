-- Rollback for 20261030_stage_moves_and_tickets.sql.
--
-- Restores the previous lifecycle definition, the previous view shapes, and
-- drops the two new caches, the stage history and the ticket views.
--
-- Note what this throws away: player_stage_history cannot be rebuilt. It is
-- captured at import time and never reconstructible from the player report
-- (see the comment on the table). If the point of the rollback is a view
-- problem rather than the history itself, drop the views and leave the table.

-- ---------------------------------------------------------------------------
-- Views back to their pre-migration shape
-- ---------------------------------------------------------------------------

create or replace view public.player_lifecycle with (security_invoker = true) as
 WITH base AS (
         SELECT p.id, p.name, p.username, p.email, p.country, p.vip_tier,
            p.registered_at, p.last_login_at, p.first_deposit_date, p.last_deposit_date,
            COALESCE(p.total_deposit_count, 0) AS raw_deposit_count,
            COALESCE(p.total_deposit_amount, 0::numeric) AS deposits,
            COALESCE(p.total_ggr_sportsbook, 0::numeric) AS ggr,
            COALESCE(p.cashback, 0::numeric) AS cashback,
            p.cash_balance, p.bonus_balance, p.total_balance, p.wallet_updated_at,
            p.restricted, p.restriction_reason,
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
            b.restricted, b.restriction_reason,
            b.bets, b.total_stake, b.avg_stake, b.median_stake,
            b.last_bet_date, b.last_settlement_date, b.open_bets,
            b.sports_played, b.top_sport, b.top_sport_share,
            b.last_activity,
            dt.d AS data_through,
                CASE
                    WHEN b.deposits >= min_qualifying_deposit() THEN b.raw_deposit_count
                    ELSE 0
                END AS deposit_count,
                CASE WHEN b.last_activity IS NULL THEN NULL::integer
                     ELSE dt.d - local_day(b.last_activity) END AS days_inactive,
                CASE WHEN b.last_login_at IS NULL THEN NULL::integer
                     ELSE dt.d - local_day(b.last_login_at) END AS days_since_login,
                CASE WHEN b.last_deposit_date IS NULL THEN NULL::integer
                     ELSE dt.d - local_day(b.last_deposit_date) END AS days_since_deposit,
                CASE WHEN b.last_bet_date IS NULL THEN NULL::integer
                     ELSE dt.d - local_day(b.last_bet_date) END AS days_since_bet,
                CASE WHEN b.last_settlement_date IS NULL THEN NULL::integer
                     ELSE dt.d - local_day(b.last_settlement_date) END AS days_since_settlement,
                CASE WHEN b.first_deposit_date IS NULL THEN NULL::integer
                     ELSE dt.d - local_day(b.first_deposit_date) END AS days_since_ftd,
                CASE WHEN b.wallet_updated_at IS NULL THEN NULL::integer
                     ELSE dt.d - local_day(b.wallet_updated_at) END AS days_since_wallet
           FROM base b
             CROSS JOIN data_through dt
        )
 SELECT id, name, username, email, country, vip_tier,
    registered_at, last_login_at, first_deposit_date, last_deposit_date,
    deposit_count, raw_deposit_count, deposits, ggr, cashback,
    bets, total_stake, avg_stake, median_stake,
    last_bet_date, last_settlement_date, open_bets,
    sports_played, top_sport, top_sport_share,
    last_activity, days_inactive, days_since_login, days_since_settlement, days_since_ftd,
    deposits < min_qualifying_deposit() AND raw_deposit_count > 0 AS below_deposit_floor,
    days_since_settlement IS NOT NULL AND days_since_settlement <= 3 OR open_bets > 0 AS has_live_hook,
    (days_since_login IS NOT NULL AND days_since_login <= 7 OR days_since_bet IS NOT NULL AND days_since_bet <= 7)
      AND (first_deposit_date IS NULL OR last_deposit_date IS NULL OR days_since_deposit >= 8) AS engaged_not_depositing,
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
    cash_balance, bonus_balance, total_balance, wallet_updated_at, days_since_wallet,
    restricted, restriction_reason
   FROM scored;

create or replace view public.player_bet_profile with (security_invoker = true) as
 WITH agg AS (
         SELECT b.player_key AS id,
            count(*) AS bets,
            sum(b.stake) AS total_stake,
            avg(b.stake) AS avg_stake,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (b.stake::double precision)) AS median_stake,
            max(b.bet_date) AS last_bet_date,
            max(b.settlement_date) AS last_settlement_date,
            count(*) FILTER (WHERE b.status = 'Open'::text) AS open_bets
           FROM bets b
          WHERE bet_counts_as_wagering(b.status)
          GROUP BY b.player_key
        ), sports AS (
         SELECT player_key, count(*) AS sports_played
           FROM player_sport_counts
          GROUP BY player_key
        ), top AS (
         SELECT DISTINCT ON (player_key) player_key, sport, bets
           FROM player_sport_counts
          ORDER BY player_key, bets DESC, sport
        )
 SELECT p.id,
    COALESCE(agg.bets, 0::bigint) AS bets,
    COALESCE(agg.total_stake, 0::numeric) AS total_stake,
    agg.avg_stake,
    agg.median_stake,
    agg.last_bet_date,
    agg.last_settlement_date,
    COALESCE(agg.open_bets, 0::bigint) AS open_bets,
    COALESCE(sports.sports_played, 0::bigint) AS sports_played,
    top.sport AS top_sport,
        CASE
            WHEN COALESCE(agg.bets, 0::bigint) > 0 AND top.bets IS NOT NULL
              THEN round(100.0 * top.bets::numeric / agg.bets::numeric, 1)
            ELSE NULL::numeric
        END AS top_sport_share
   FROM players p
     LEFT JOIN agg ON agg.id = p.id
     LEFT JOIN sports ON sports.player_key = p.id
     LEFT JOIN top ON top.player_key = p.id;

-- player_tier_progress and vip_tier_summary gained columns, so they are dropped
-- rather than replaced -- `create or replace view` cannot remove a column.
-- Anything selecting the new columns must be redeployed first.
drop view if exists public.player_tier_progress;
create view public.player_tier_progress with (security_invoker = true) as
 WITH win AS MATERIALIZED (
         SELECT ((dt.d + 1)::timestamp without time zone AT TIME ZONE 'America/Santo_Domingo'::text) AS hi,
            ((dt.d + 1)::timestamp without time zone AT TIME ZONE 'America/Santo_Domingo'::text) - '90 days'::interval AS lo,
            dt.d
           FROM data_through dt
        ), wagered AS MATERIALIZED (
         SELECT b.player_key AS id,
            sum(COALESCE(b.stake, 0::numeric) + COALESCE(b.bonus_stake, 0::numeric)) AS trailing_wager
           FROM bets b
             CROSS JOIN win win_1
          WHERE b.bet_date >= win_1.lo AND b.bet_date < win_1.hi
            AND b.player_key IS NOT NULL AND bet_counts_as_wagering(b.status)
          GROUP BY b.player_key
        )
 SELECT p.id, p.name, p.username, p.email,
    COALESCE(p.vip_tier, 'Prospecto'::text) AS vip_tier,
    ct.tier_order, p.registered_at, p.last_login_at,
        CASE WHEN p.last_login_at IS NULL THEN NULL::integer
             ELSE win.d - local_day(p.last_login_at) END AS days_since_login,
    p.first_deposit_date, p.last_deposit_date,
        CASE WHEN p.last_deposit_date IS NULL THEN NULL::integer
             ELSE win.d - local_day(p.last_deposit_date) END AS days_since_deposit,
    p.total_deposit_amount, p.total_deposit_count,
    p.total_ggr_sportsbook, p.total_withdrawal_amount,
    COALESCE(w.trailing_wager, 0::numeric) AS trailing_wager,
    ct.wager_required_dop AS tier_required,
    nt.tier_name AS next_tier,
    nt.wager_required_dop AS next_tier_required,
        CASE WHEN nt.tier_name IS NULL THEN NULL::numeric
             ELSE GREATEST(nt.wager_required_dop - COALESCE(w.trailing_wager, 0::numeric), 0::numeric)
        END AS wager_to_next,
        CASE
            WHEN nt.tier_name IS NULL THEN 1::numeric
            WHEN (nt.wager_required_dop - ct.wager_required_dop) <= 0::numeric THEN 0::numeric
            ELSE LEAST(GREATEST((COALESCE(w.trailing_wager, 0::numeric) - ct.wager_required_dop) / (nt.wager_required_dop - ct.wager_required_dop), 0::numeric), 1::numeric)
        END AS progress_to_next,
    COALESCE(bp.bets, 0::bigint) AS bets,
    COALESCE(bp.total_stake, 0::numeric) AS total_stake,
    bp.avg_stake, bp.median_stake, bp.last_bet_date, bp.last_settlement_date, bp.open_bets,
    COALESCE(bp.sports_played, 0::bigint) AS sports_played,
    bp.top_sport, bp.top_sport_share,
    win.d AS data_through
   FROM real_players p
     CROSS JOIN win
     LEFT JOIN wagered w ON w.id = p.id
     LEFT JOIN vip_tiers ct ON ct.tier_name = COALESCE(p.vip_tier, 'Prospecto'::text)
     LEFT JOIN LATERAL ( SELECT t.tier_name, t.wager_required_dop
           FROM vip_tiers t WHERE t.tier_order > ct.tier_order
          ORDER BY t.tier_order LIMIT 1) nt ON true
     LEFT JOIN player_bet_profile bp ON bp.id = p.id;

grant select on public.player_tier_progress to authenticated;

drop view if exists public.vip_tier_summary;
create view public.vip_tier_summary with (security_invoker = true) as
 SELECT t.tier_name, t.tier_order, t.wager_required_dop, t.cashback_pct, t.promotion_bonus_dop,
    count(p.id) AS players,
    COALESCE(sum(p.total_deposit_amount), 0::numeric) AS total_deposits,
    COALESCE(avg(p.total_deposit_amount), 0::numeric) AS avg_deposit,
    COALESCE(sum(p.total_ggr_sportsbook), 0::numeric) AS total_ggr,
    count(p.id) FILTER (WHERE p.is_ftd) AS ftd_players
   FROM vip_tiers t
     LEFT JOIN players p ON p.vip_tier = t.tier_name
  GROUP BY t.tier_name, t.tier_order, t.wager_required_dop, t.cashback_pct, t.promotion_bonus_dop;

grant select on public.vip_tier_summary to authenticated;

-- ---------------------------------------------------------------------------
-- Drop what the migration added
-- ---------------------------------------------------------------------------

drop view if exists public.deposit_period_tickets;
drop view if exists public.player_tickets;
drop view if exists public.player_stage_moves;
drop view if exists public.lifecycle_trend;

drop function if exists public.snapshot_player_stages();
drop function if exists public.refresh_player_bet_stats();

-- Keeps the history by default. Uncomment only if the table itself is the
-- problem: these rows cannot be recaptured for a past week.
-- drop table if exists public.player_stage_history;

drop table if exists public.player_bet_stats;

drop function if exists public.lifecycle_rank(text);
drop function if exists public.lifecycle_stage(integer, integer, bigint);
