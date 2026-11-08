-- Weekly stage history, reconstructed backwards -- which CLAUDE.md said could
-- not be done. It was too absolute, and this is the correction.
--
-- The note said: the stage is a threshold on days since the last deposit, the
-- player report only carries the *latest* deposit date, and deposit_periods
-- knows the week but not the day, so "dating a deposit to its period end would
-- move players across stage lines on invented precision".
--
-- The first two clauses are true. The conclusion does not follow, for a reason
-- that is arithmetic rather than judgement: **the thresholds are 8, 15 and 30
-- days and the periods are 7 days long**, so a week-wide window usually falls
-- entirely inside one stage.
--
--   deposited in the week ending at the cut   -> 0-6 days  -> always < 8
--   the week before that                      -> 7-13 days -> STRADDLES 8
--   two weeks before                          -> 14-20     -> STRADDLES 15
--   three weeks before                        -> 21-27     -> always At risk
--   four weeks before                         -> 28-34     -> STRADDLES 30
--   five weeks or more                        -> 35+       -> always Churned
--
-- And most players never need the window at all. Two exact dates are already
-- in the player report:
--
--   * `last_deposit_date`, when it is itself at or before the cut -- then it IS
--     the answer, exactly;
--   * `first_deposit_date`, for anyone who had exactly one deposit at the cut,
--     because with one deposit the last one is the first one.
--
-- Measured over the ten weekly cuts, what is left is 8 to 28 players each --
-- 1.1% to 12.7% of that week's depositors, and under 1% of the book. Those are
-- marked `stage_uncertain`, carry the other reading in `alt_lifecycle`, and the
-- screens show the count as a plus-or-minus rather than hiding it.
--
-- Everything else at a past cut is exact, not estimated: deposit counts and
-- amounts come from deposit_periods, which tiles every day since 10 August,
-- and bets carry a real bet_date.

alter table public.player_stage_history
  add column if not exists source          text    not null default 'import',
  add column if not exists stage_uncertain boolean not null default false,
  add column if not exists alt_lifecycle   text;

comment on column public.player_stage_history.source is
  'import = captured by snapshot_player_stages() at import time; reconstructed = derived backwards by reconstruct_player_stages(). A real capture always wins.';

-- Only ever touches its own rows, so a genuine capture can never be lost to it.
create or replace function public.reconstruct_player_stages()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  n          integer;
  first_real date;
begin
  select min(captured_on) into first_real
    from player_stage_history where source = 'import';

  -- A predicate on a real NOT NULL column, not `where true`: `safeupdate` is
  -- preloaded for the role PostgREST connects as and rejects an unqualified
  -- DELETE for the whole session, inside SECURITY DEFINER too. The import that
  -- died on 2026-11-02 died exactly here.
  delete from player_stage_history where source = 'reconstructed';

  insert into player_stage_history
    (player_id, captured_on, lifecycle, vip_tier, deposit_count, deposits, bets,
     days_since_deposit, source, stage_uncertain, alt_lifecycle)
  with cuts as (
    -- Sundays only, so the series has one clean weekly step. The month-split
    -- period ends (30 Sep, 31 Oct) are real periods but not week ends, and
    -- including them would put a one-day gap in the middle of the cadence.
    select distinct d.period_end as w
      from deposit_periods d
     where d.scope = 'primary'
       and extract(dow from d.period_end) = 0
       and (first_real is null or d.period_end < first_real)
       and d.period_end >= date '2026-09-06'
  ),
  -- Cumulative deposits at each cut. Exact: the periods tile every day from
  -- operations_start(), so nothing falls between them.
  dep as (
    select c.w, d.player_id,
           sum(d.deposit_count)::integer                          as deposit_count,
           sum(d.deposit_amount)                                  as deposits,
           max(d.period_start) filter (where d.deposit_count > 0) as last_start,
           max(d.period_end)   filter (where d.deposit_count > 0) as last_end
      from cuts c
      join deposit_periods d on d.scope = 'primary' and d.period_end <= c.w
     group by c.w, d.player_id
  ),
  -- Cumulative bets at each cut. Exact: bets carry a real bet_date.
  bet as (
    select c.w, b.player_key as player_id, count(*) as bets
      from cuts c
      join bets b
        on local_day(b.bet_date) <= c.w
       and bet_counts_as_wagering(b.status)
     where b.player_key is not null
     group by c.w, b.player_key
  ),
  base as (
    select c.w, p.id,
           coalesce(d.deposit_count, 0)   as deposit_count,
           coalesce(d.deposits, 0)        as deposits,
           coalesce(b.bets, 0)            as bets,
           d.last_start, d.last_end,
           local_day(p.last_deposit_date)  as last_dep,
           local_day(p.first_deposit_date) as ftd
      from cuts c
      -- The book as it stands. The 1 November capture holds 669 accounts that
      -- the disposable-domain rule excluded afterwards, and counting them in
      -- the history would invent a drop of 669 Registered on the next step.
      join real_players p on local_day(p.registered_at) <= c.w
      left join dep d on d.w = c.w and d.player_id = p.id
      left join bet b on b.w = c.w and b.player_id = p.id
  ),
  dated as (
    select base.*,
           case
             when deposit_count = 0            then null
             when last_dep is not null
              and last_dep <= w                then w - last_dep
             when deposit_count = 1
              and ftd is not null
              and ftd <= w                     then w - ftd
             else w - last_end
           end as days_since,
           -- The other end of the window, for the rows the window cannot decide.
           case
             when deposit_count = 0            then null
             when last_dep is not null
              and last_dep <= w                then w - last_dep
             when deposit_count = 1
              and ftd is not null
              and ftd <= w                     then w - ftd
             else w - last_start
           end as days_since_other
      from base
  ),
  judged as (
    select dated.*,
           (days_since is not null
            and days_since is distinct from days_since_other
            and lifecycle_stage(deposit_count, days_since, bets)
                is distinct from lifecycle_stage(deposit_count, days_since_other, bets)
           ) as uncertain
      from dated
  )
  select id, w,
         lifecycle_stage(deposit_count, days_since, bets),
         -- Not reconstructed: the tier comes from trailing 90-day wagering and
         -- nothing stores what it was. Null rather than today's tier, so the
         -- movement list cannot show a tier change that never happened.
         null,
         deposit_count, deposits, bets, days_since,
         'reconstructed',
         uncertain,
         case when uncertain
              then lifecycle_stage(deposit_count, days_since_other, bets) end
    from judged;

  get diagnostics n = row_count;
  return n;
end;
$function$;

revoke execute on function public.reconstruct_player_stages() from anon, public;
grant execute on function public.reconstruct_player_stages() to authenticated;

-- A real capture must stamp its own source, or re-importing a week that was
-- reconstructed first would leave the row claiming to be an estimate.
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

  -- The anchor is the EARLIEST of three sources, so between uploads it sits
  -- behind whichever source has already landed. For a figure on screen that is
  -- the right kind of conservative. For a capture it is not: it records a stage
  -- set measured against a cut-off earlier than its own source data, and writes
  -- it under that earlier key. That happened on 2026-11-02 -- 333 players with
  -- a negative days_since_deposit, the genuine 25 October row overwritten, and
  -- 268 stage "moves" that were pure artefact.
  select greatest(max(local_day(p.last_deposit_date)), max(local_day(p.last_login_at)))
    into player_through
    from real_players p;
  if player_through is not null and d < player_through then
    return 0;
  end if;

  insert into player_stage_history as h
    (player_id, captured_on, lifecycle, vip_tier, deposit_count, deposits, bets,
     days_since_deposit, source, stage_uncertain, alt_lifecycle)
  select l.id, d, l.lifecycle, l.vip_tier, l.deposit_count, l.deposits,
         coalesce(l.bets, 0), l.days_since_deposit, 'import', false, null
    from player_lifecycle l
  on conflict (player_id, captured_on) do update
    set lifecycle          = excluded.lifecycle,
        vip_tier           = excluded.vip_tier,
        deposit_count      = excluded.deposit_count,
        deposits           = excluded.deposits,
        bets               = excluded.bets,
        days_since_deposit = excluded.days_since_deposit,
        -- A measured row replaces an estimate for the same week.
        source             = 'import',
        stage_uncertain    = false,
        alt_lifecycle      = null,
        captured_at        = now()
  where h.lifecycle          is distinct from excluded.lifecycle
     or h.vip_tier           is distinct from excluded.vip_tier
     or h.deposit_count      is distinct from excluded.deposit_count
     or h.deposits           is distinct from excluded.deposits
     or h.bets               is distinct from excluded.bets
     or h.days_since_deposit is distinct from excluded.days_since_deposit
     or h.source             is distinct from 'import';
  get diagnostics n = row_count;
  return n;
end;
$function$;

-- The trend has to describe the book as it stands, or every account excluded
-- after a capture reads as a player who left.
create or replace view public.lifecycle_trend with (security_invoker = true) as
 select h.captured_on,
    h.lifecycle,
    count(*)                                          as players,
    coalesce(sum(h.deposits), 0::numeric)             as deposits,
    bool_or(h.source = 'reconstructed')               as estimated,
    count(*) filter (where h.stage_uncertain)         as uncertain
   from player_stage_history h
   join real_players p on p.id = h.player_id
  group by h.captured_on, h.lifecycle;

-- Verified before shipping.
--
-- The method was run for 1 November, the one cut that has a real capture to be
-- checked against, and compared player by player:
--
--   compared            4,063
--   stage agrees        4,060   (99.93%)
--   stage differs           3
--   bets differ             0   (exact)
--   deposit count differs  18
--
-- The 3 disagreements are not the method. They are the seam between the two
-- reports: for two players the payments report holds no deposit that the
-- player report does, and for one the reverse. The same seam shows in the 18
-- deposit-count differences and in the DOP 41,991 the tier windows differ by.
-- A reconstruction has to use deposit_periods, because it is the only source
-- with a time dimension at all.
--
-- Written: 18,344 rows over eight weekly cuts, 6 Sep to 25 Oct. The resulting
-- series, with the real 1 November capture at the end:
--
--   cut      Registered  New  Active  Cooling  At risk  Churned  undecided
--   06 Sep        1,280    7      55       18       28        -         12
--   13 Sep        1,439   10      69       22       35        6         18
--   20 Sep        1,491    8      77       21       34       23         18
--   27 Sep        1,540    1      82       16       35       38         21
--   04 Oct        1,836   43     167       17       30       50         17
--   11 Oct        2,267   20     225       79       29       56         14
--   18 Oct        2,852   37     262       64       81       69         23
--   25 Oct        3,170   38     326       93      128       70         19
--   01 Nov        3,323   29     322      114      161      114          0  (captured)
--
-- Timed as `authenticated`, the queries the page sends: one week of movers
-- 88 ms, the trend 31 ms. player_stage_moves computes its window over the
-- whole table before filtering, so it grows with the history: 23,084 rows
-- today at 88 ms. Re-time it when the table passes ~100k.
