-- Measure player recency against the data we have, not against today's clock.
--
-- days_since_deposit was CURRENT_DATE - last_deposit_date, and the lifecycle
-- stage is a set of thresholds on it (8 -> Cooling, 15 -> At risk, 30 ->
-- Churned). Reports land weekly, so between imports the clock moves and the
-- data does not: every player's counter grows by one a day and the funnel
-- decays on its own, then snaps back on import day. A sawtooth nobody caused.
--
-- Measured on 2026-10-21, with data through 2026-10-18 -- three days of drift,
-- zero new information:
--
--                  today    at the data cut-off   drift
--     Active         180            212            -32
--     New             62             72            -10
--     Cooling         80             71             +9
--     At risk        108             79            +29
--     Churned         71             67             +4
--
-- The deeper problem is that the old form cannot tell "has not deposited" from
-- "we have not imported it yet", and silently assumes the worse of the two. A
-- player who deposited on Tuesday is in the backoffice and not in our data, and
-- the dashboard calls them 22 days quiet.
--
-- Anchoring costs staleness: on a Thursday you are looking at Sunday's picture.
-- That is the honest trade -- you cannot know more than you have imported --
-- and it disappears by itself once reports arrive daily, because the anchor
-- then sits a day behind today and these numbers converge on the old ones.

-- The anchor is a view rather than a function on purpose. A STABLE function
-- carrying SECURITY DEFINER or a SET clause cannot be inlined, and would be
-- re-evaluated per row against real tables -- the trap CLAUDE.md already
-- records for local_day() and for is_team_member() in RLS. A view is rewritten
-- into the query, so the aggregates below become one-off InitPlans.
create or replace view data_through with (security_invoker = true) as
select least(
         current_date,
         coalesce(
           -- The earliest of the three sources that feed player recency: if one
           -- lags the others, be conservative rather than invent coverage.
           least(
             (select max(local_day(p.last_deposit_date)) from real_players p),
             (select max(local_day(p.last_login_at))     from real_players p),
             (select max(local_day(b.bet_date))          from bets b)
           ),
           current_date
         )
       ) as d;

comment on view data_through is
  'One row: the last day every player-recency source covers. Day counters are '
  'measured against this rather than CURRENT_DATE, so segment counts move only '
  'when the data moves. Falls back to CURRENT_DATE when there is no data.';

create or replace view player_lifecycle with (security_invoker = true) as
 WITH base AS (
         SELECT p.id, p.name, p.username, p.email, p.country, p.vip_tier,
            p.registered_at, p.last_login_at, p.first_deposit_date, p.last_deposit_date,
            COALESCE(p.total_deposit_count, 0) AS raw_deposit_count,
            COALESCE(p.total_deposit_amount, 0::numeric) AS deposits,
            COALESCE(p.total_ggr_sportsbook, 0::numeric) AS ggr,
            COALESCE(p.cashback, 0::numeric) AS cashback,
            prof.bets, prof.total_stake, prof.avg_stake, prof.median_stake,
            prof.last_bet_date, prof.last_settlement_date, prof.open_bets,
            prof.sports_played, prof.top_sport, prof.top_sport_share,
            GREATEST(prof.last_bet_date, p.last_deposit_date, p.last_login_at) AS last_activity
           FROM real_players p
             JOIN player_bet_profile prof ON prof.id = p.id
        ), scored AS (
         SELECT b.id, b.name, b.username, b.email, b.country, b.vip_tier,
            b.registered_at, b.last_login_at, b.first_deposit_date, b.last_deposit_date,
            b.raw_deposit_count, b.deposits, b.ggr, b.cashback, b.bets,
            b.total_stake, b.avg_stake, b.median_stake, b.last_bet_date,
            b.last_settlement_date, b.open_bets, b.sports_played, b.top_sport,
            b.top_sport_share, b.last_activity,
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
                     ELSE dt.d - local_day(b.first_deposit_date) END AS days_since_ftd
           FROM base b CROSS JOIN data_through dt
        )
 SELECT id, name, username, email, country, vip_tier, registered_at, last_login_at,
    first_deposit_date, last_deposit_date, deposit_count, raw_deposit_count,
    deposits, ggr, cashback, bets, total_stake, avg_stake, median_stake,
    last_bet_date, last_settlement_date, open_bets, sports_played, top_sport,
    top_sport_share, last_activity, days_inactive, days_since_login,
    days_since_settlement, days_since_ftd,
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
    days_since_deposit, days_since_bet, data_through
   FROM scored;

-- The VIP tier window had the same problem in a second form: the trailing
-- wager was "now() - 90 days", so a VIP's cushion above their tier floor
-- shrank every day on unchanged data. Anchored to the 90 days ending at the
-- close of the data cut-off. Kept as a plain timestamp range so the
-- bets(bet_date) index still serves it.
create or replace view player_tier_progress with (security_invoker = true) as
 WITH win AS (
         SELECT ((dt.d + 1)::timestamp AT TIME ZONE 'America/Santo_Domingo') AS hi,
                ((dt.d + 1)::timestamp AT TIME ZONE 'America/Santo_Domingo') - '90 days'::interval AS lo,
                dt.d AS d
           FROM data_through dt
        ), wagered AS (
         SELECT p_1.id,
            COALESCE(( SELECT sum(COALESCE(b.stake, 0::numeric) + COALESCE(b.bonus_stake, 0::numeric)) AS sum
                   FROM bets b
                  WHERE b.player_key = p_1.id
                    AND b.bet_date >= win.lo AND b.bet_date < win.hi
                    AND bet_counts_as_wagering(b.status)), 0::numeric) AS trailing_wager
           FROM real_players p_1 CROSS JOIN win
        )
 SELECT p.id, p.name, p.username, p.email,
    COALESCE(p.vip_tier, 'Prospecto'::text) AS vip_tier,
    ct.tier_order, p.registered_at, p.last_login_at,
        CASE WHEN p.last_login_at IS NULL THEN NULL::integer
             ELSE win.d - local_day(p.last_login_at) END AS days_since_login,
    p.first_deposit_date, p.last_deposit_date,
        CASE WHEN p.last_deposit_date IS NULL THEN NULL::integer
             ELSE win.d - local_day(p.last_deposit_date) END AS days_since_deposit,
    p.total_deposit_amount, p.total_deposit_count, p.total_ggr_sportsbook,
    p.total_withdrawal_amount, w.trailing_wager,
    ct.wager_required_dop AS tier_required,
    nt.tier_name AS next_tier, nt.wager_required_dop AS next_tier_required,
        CASE WHEN nt.tier_name IS NULL THEN NULL::numeric
             ELSE GREATEST(nt.wager_required_dop - w.trailing_wager, 0::numeric) END AS wager_to_next,
        CASE
            WHEN nt.tier_name IS NULL THEN 1::numeric
            WHEN (nt.wager_required_dop - ct.wager_required_dop) <= 0::numeric THEN 0::numeric
            ELSE LEAST(GREATEST((w.trailing_wager - ct.wager_required_dop) / (nt.wager_required_dop - ct.wager_required_dop), 0::numeric), 1::numeric)
        END AS progress_to_next,
    COALESCE(bp.bets, 0::bigint) AS bets,
    COALESCE(bp.total_stake, 0::numeric) AS total_stake,
    bp.avg_stake, bp.median_stake, bp.last_bet_date, bp.last_settlement_date,
    bp.open_bets,
    COALESCE(bp.sports_played, 0::bigint) AS sports_played,
    bp.top_sport, bp.top_sport_share,
    win.d AS data_through
   FROM real_players p
     CROSS JOIN win
     JOIN wagered w ON w.id = p.id
     LEFT JOIN vip_tiers ct ON ct.tier_name = COALESCE(p.vip_tier, 'Prospecto'::text)
     LEFT JOIN LATERAL ( SELECT t.tier_name, t.wager_required_dop
           FROM vip_tiers t WHERE t.tier_order > ct.tier_order
          ORDER BY t.tier_order LIMIT 1) nt ON true
     LEFT JOIN player_bet_profile bp ON bp.id = p.id;

create or replace view player_directory with (security_invoker = true) as
 SELECT p.id, p.username, p.name, p.email,
    COALESCE(p.vip_tier, 'Prospecto'::text) AS vip_tier,
    p.country, p.registered_at, p.last_login_at,
        CASE WHEN p.last_login_at IS NULL THEN NULL::integer
             ELSE dt.d - local_day(p.last_login_at) END AS days_since_login,
    p.first_deposit_date, p.first_deposit_amount, p.last_deposit_date,
        CASE WHEN p.last_deposit_date IS NULL THEN NULL::integer
             ELSE dt.d - local_day(p.last_deposit_date) END AS days_since_deposit,
    COALESCE(p.total_deposit_amount, 0::numeric) AS total_deposit_amount,
    COALESCE(p.total_deposit_count, 0) AS total_deposit_count,
    COALESCE(p.total_withdrawal_amount, 0::numeric) AS total_withdrawal_amount,
    COALESCE(p.total_ggr_sportsbook, 0::numeric) AS total_ggr_sportsbook,
    dt.d AS data_through
   FROM real_players p CROSS JOIN data_through dt;

-- CREATE OR REPLACE VIEW replaces reloptions wholesale, so security_invoker is
-- dropped unless it is restated -- which is why every statement above carries
-- it. Fail loudly rather than leave a view reading with the definer's rights.
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ')
    into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v'
    and c.relname in ('data_through','player_lifecycle','player_tier_progress','player_directory')
    and not coalesce(array_to_string(c.reloptions, ',') like '%security_invoker=true%', false);

  if bad is not null then
    raise exception 'security_invoker missing on: %', bad;
  end if;
end $$;
