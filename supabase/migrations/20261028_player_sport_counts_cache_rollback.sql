-- Rollback for 20261028_player_sport_counts_cache.sql.
--
-- Puts the per-read unnest back. Be aware of what that costs: one page of
-- Segments goes from 337 ms to 4,627 ms, and the page as a whole back over the
-- 8 s statement_timeout. Only do this if the cache turns out to be wrong.
create or replace view public.player_bet_profile with (security_invoker = true) as
 WITH agg AS (
         SELECT b.player_key AS id, count(*) AS bets, sum(b.stake) AS total_stake,
            avg(b.stake) AS avg_stake,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (b.stake::double precision)) AS median_stake,
            max(b.bet_date) AS last_bet_date, max(b.settlement_date) AS last_settlement_date,
            count(*) FILTER (WHERE b.status = 'Open'::text) AS open_bets
           FROM bets b WHERE bet_counts_as_wagering(b.status) GROUP BY b.player_key
        ), legs AS (
         SELECT b.player_key, COALESCE(a.canonical, NULLIF(btrim(leg.leg), ''::text)) AS sport, b.bet_id
           FROM bets b
             CROSS JOIN LATERAL unnest(string_to_array(b.sport, chr(10))) leg(leg)
             LEFT JOIN sport_aliases a ON a.alias = lower(btrim(leg.leg))
          WHERE bet_counts_as_wagering(b.status) AND b.player_key IS NOT NULL
            AND COALESCE(a.canonical, NULLIF(btrim(leg.leg), ''::text)) IS NOT NULL
          GROUP BY b.player_key, (COALESCE(a.canonical, NULLIF(btrim(leg.leg), ''::text))), b.bet_id
        ), per_sport AS (
         SELECT legs.player_key, legs.sport, count(*) AS bets FROM legs GROUP BY legs.player_key, legs.sport
        ), sports AS (
         SELECT per_sport.player_key, count(*) AS sports_played FROM per_sport GROUP BY per_sport.player_key
        ), top AS (
         SELECT DISTINCT ON (per_sport.player_key) per_sport.player_key, per_sport.sport, per_sport.bets
           FROM per_sport ORDER BY per_sport.player_key, per_sport.bets DESC, per_sport.sport
        )
 SELECT p.id, COALESCE(agg.bets, 0::bigint) AS bets, COALESCE(agg.total_stake, 0::numeric) AS total_stake,
    agg.avg_stake, agg.median_stake, agg.last_bet_date, agg.last_settlement_date,
    COALESCE(agg.open_bets, 0::bigint) AS open_bets,
    COALESCE(sports.sports_played, 0::bigint) AS sports_played, top.sport AS top_sport,
        CASE WHEN COALESCE(agg.bets, 0::bigint) > 0 AND top.bets IS NOT NULL
             THEN round(100.0 * top.bets::numeric / agg.bets::numeric, 1) ELSE NULL::numeric END AS top_sport_share
   FROM players p
     LEFT JOIN agg ON agg.id = p.id
     LEFT JOIN sports ON sports.player_key = p.id
     LEFT JOIN top ON top.player_key = p.id;

drop function if exists public.refresh_player_sport_counts();
drop table if exists public.player_sport_counts;
