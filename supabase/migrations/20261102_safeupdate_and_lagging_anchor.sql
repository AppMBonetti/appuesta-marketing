-- APPLIED 2026-11-02. Two bugs in what shipped as 20261030, both found by the
-- first real import after it.
--
-- The Altenar upload failed with "Error al importar: DELETE requires a WHERE
-- clause". 12,424 bets had already landed; only the refreshes that run after
-- them failed.
--
-- ---------------------------------------------------------------------------
-- 1. A bare DELETE is rejected for the role PostgREST connects as
-- ---------------------------------------------------------------------------
--
-- `authenticator` carries
--
--   session_preload_libraries = supautils, safeupdate
--
-- and `safeupdate` rejects a DELETE or UPDATE with no WHERE clause for the
-- whole session -- inside a SECURITY DEFINER function as well, because it is an
-- executor hook and not a permission check. SECURITY DEFINER changes the user,
-- not the loaded libraries.
--
-- So `delete from player_sport_counts;` and `delete from player_bet_stats;`
-- both worked when run from a direct `postgres` connection and both failed from
-- the dashboard. CLAUDE.md already says to measure as `authenticated` rather
-- than as yourself; this is the same trap applied to *running* a function, not
-- just timing one. A direct connection does not load safeupdate, so it cannot
-- see this class of failure at all.
--
-- Fixed with a predicate on a real NOT NULL column rather than `where true`: it
-- matches every row just the same, and does not depend on whether a tautology
-- survives constant folding long enough for the hook to see it.

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
  --
  -- The WHERE clause is not decoration -- see the header of this migration.
  delete from player_sport_counts where player_key is not null;
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

create or replace function public.refresh_player_bet_stats()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare n integer;
begin
  -- Rebuilt whole rather than patched, inside one transaction, so readers never
  -- see it empty. Same contract as refresh_player_sport_counts(), and the same
  -- reason for the WHERE clause.
  delete from player_bet_stats where player_key is not null;
  insert into player_bet_stats
    (player_key, bets, total_stake, avg_stake, median_stake,
     last_bet_date, last_settlement_date, open_bets)
  select b.player_key,
         count(*),
         sum(b.stake),
         avg(b.stake),
         percentile_cont(0.5::double precision) within group (order by (b.stake::double precision)),
         max(b.bet_date),
         max(b.settlement_date),
         count(*) filter (where b.status = 'Open')
    from bets b
   where bet_counts_as_wagering(b.status)
     and b.player_key is not null
   group by b.player_key;
  get diagnostics n = row_count;
  return n;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. A capture taken while the anchor lags describes nothing
-- ---------------------------------------------------------------------------
--
-- `data_through` is the EARLIEST of three sources, so between uploads it sits
-- behind whichever source has already landed. For a figure on screen that is
-- the right kind of conservative -- the point of the anchor. For a *capture* it
-- is not.
--
-- The upload order is player report, payments, Altenar. So on 2026-11-02 the
-- player report put deposits and logins at 1 November while `bets` still
-- stopped on 25 October, which left data_through at 25 October.
-- snapshot_player_stages() ran at the end of that import and wrote the whole
-- roster under `captured_on = 2026-10-25`, holding **333 players with a
-- negative days_since_deposit** -- down to -7, because they had deposited after
-- the cut-off their stage was measured against.
--
-- It also overwrote the genuine 25 October row, the key being
-- (player_id, captured_on), and the 268 "stage moves" that then appeared
-- against the 1 November capture were pure artefact. Left alone this would have
-- recurred every week, each capture a week stale in its key, every comparison
-- between the wrong pair.
--
-- The corrupt row was deleted and the 1 November capture stands as the first
-- real baseline.
--
-- The function now captures nothing until the anchor has caught up with the
-- player data it would be measuring, and the Altenar import calls it too, so
-- whichever upload brings the anchor level is the one that records the week.
-- Verified both ways: it writes when the anchor is level, and returns 0 with
-- the bets rolled back behind the player data.

create or replace function public.snapshot_player_stages()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  n integer;
  d date;
  player_through date;
begin
  select dt.d into d from data_through dt;
  if d is null then
    return 0;
  end if;

  -- See the header: a stage set measured against a cut-off earlier than its own
  -- source data is not worth storing, and storing it destroys the row for the
  -- week it is keyed to.
  select greatest(max(local_day(p.last_deposit_date)), max(local_day(p.last_login_at)))
    into player_through
    from real_players p;
  if player_through is not null and d < player_through then
    return 0;
  end if;

  -- Keyed on the data cut-off, so re-importing the same week corrects that
  -- week's row instead of adding a second one.
  insert into player_stage_history as h
    (player_id, captured_on, lifecycle, vip_tier, deposit_count, deposits, bets, days_since_deposit)
  select l.id, d, l.lifecycle, l.vip_tier, l.deposit_count, l.deposits,
         coalesce(l.bets, 0), l.days_since_deposit
    from player_lifecycle l
  on conflict (player_id, captured_on) do update
    set lifecycle          = excluded.lifecycle,
        vip_tier           = excluded.vip_tier,
        deposit_count      = excluded.deposit_count,
        deposits           = excluded.deposits,
        bets               = excluded.bets,
        days_since_deposit = excluded.days_since_deposit,
        captured_at        = now()
  where h.lifecycle          is distinct from excluded.lifecycle
     or h.vip_tier           is distinct from excluded.vip_tier
     or h.deposit_count      is distinct from excluded.deposit_count
     or h.deposits           is distinct from excluded.deposits
     or h.bets               is distinct from excluded.bets
     or h.days_since_deposit is distinct from excluded.days_since_deposit;
  get diagnostics n = row_count;
  return n;
end;
$function$;

revoke execute on function public.snapshot_player_stages() from anon, public;
grant execute on function public.snapshot_player_stages() to authenticated;

-- The capture written under a lagging anchor on 2026-11-02. Not recoverable and
-- not worth recovering: every day counter in it was measured against a cut-off
-- earlier than the deposits it was measuring.
delete from public.player_stage_history where captured_on = '2026-10-25';
