-- APPLIED 2026-10-28. Segments was back on "canceling statement due to
-- statement timeout".
--
-- player_bet_profile unnested the sport string of every bet on every read:
--
--   cross join lateral unnest(string_to_array(b.sport, chr(10)))
--
-- 42,593 wagering bets expand to ~87,000 legs, then two HashAggregates. The
-- plan showed 42,593 Memoize loops over that Function Scan. Measured as
-- `authenticated`, one page of Segments (1,000 players, ordered by deposits):
--
--   naming no sport column     13 ms   <- the CTE reads `never executed`
--   naming top_sport        4,627 ms
--
-- and Segments pages through the whole list, so five of those, ~23 s in all
-- against an 8 s statement_timeout. It had been fine at 33,522 bets; the week
-- of 19-25 October took the table past where the shape could carry it.
--
-- The legs only change when bets are imported, so they are now a cache:
-- distinct bets per player per sport, rebuilt by refresh_player_sport_counts()
-- at the end of the Altenar import, next to refresh_player_ggr().
--
--   after:                    337 ms   <- all sport columns named and computed
--
-- A real table rather than a materialized view, deliberately: a matview has no
-- RLS, and anything readable by `authenticated` is readable by the affiliate
-- portal's users too. This stays behind is_team_member() like everything else.
--
-- Checked against the view it replaces before switching anything: across all
-- 4,403 players, top_sport, sports_played and top_sport_share all matched, with
-- zero differences.
create table if not exists public.player_sport_counts (
  player_key text   not null,
  sport      text   not null,
  bets       bigint not null,
  primary key (player_key, sport)
);

alter table public.player_sport_counts enable row level security;

drop policy if exists player_sport_counts_team on public.player_sport_counts;
create policy player_sport_counts_team on public.player_sport_counts
  for select to authenticated
  using ((select public.is_team_member()));

revoke all on public.player_sport_counts from anon;
grant select on public.player_sport_counts to authenticated;

comment on table public.player_sport_counts is
  'Distinct bets per player per sport, precomputed. Derived from bets and rebuilt by refresh_player_sport_counts() after every bet import -- a cache, never a source. A real table rather than a materialized view because a matview has no RLS, and this must stay behind is_team_member() like everything else.';

create or replace function public.refresh_player_sport_counts()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare n integer;
begin
  -- Rebuilt whole rather than patched: the source is one import away from
  -- changing anywhere, and a wrong top_sport is worse than a slow rebuild.
  -- Inside one transaction, so readers never see it empty.
  delete from player_sport_counts;
  insert into player_sport_counts (player_key, sport, bets)
  select b.player_key,
         coalesce(a.canonical, nullif(btrim(leg.leg), '')) as sport,
         count(distinct b.bet_id) as bets
    from bets b
    cross join lateral unnest(string_to_array(b.sport, chr(10))) leg(leg)
    left join sport_aliases a on a.alias = lower(btrim(leg.leg))
   where bet_counts_as_wagering(b.status)
     and b.player_key is not null
     and coalesce(a.canonical, nullif(btrim(leg.leg), '')) is not null
   group by 1, 2;
  get diagnostics n = row_count;
  return n;
end;
$function$;

-- Supabase grants EXECUTE to public by default, which reaches anon through the
-- REST schema (CLAUDE.md).
revoke execute on function public.refresh_player_sport_counts() from anon, public;
grant execute on function public.refresh_player_sport_counts() to authenticated;

select public.refresh_player_sport_counts();

-- Same columns, same order, same types; only the two sport CTEs are replaced by
-- reads of the cache. security_invoker restated because create or replace
-- replaces reloptions wholesale.
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
            WHEN COALESCE(agg.bets, 0::bigint) > 0 AND top.bets IS NOT NULL THEN round(100.0 * top.bets::numeric / agg.bets::numeric, 1)
            ELSE NULL::numeric
        END AS top_sport_share
   FROM players p
     LEFT JOIN agg ON agg.id = p.id
     LEFT JOIN sports ON sports.player_key = p.id
     LEFT JOIN top ON top.player_key = p.id;

do $$
begin
  if (select count(*) from player_sport_counts) = 0 then
    raise exception 'player_sport_counts is empty: the rebuild did not run';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'player_bet_profile'
      and array_to_string(c.reloptions, ',') like '%security_invoker=true%'
  ) then
    raise exception 'security_invoker lost on player_bet_profile';
  end if;
end $$;
