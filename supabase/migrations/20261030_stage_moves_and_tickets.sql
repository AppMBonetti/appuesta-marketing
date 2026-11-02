-- APPLIED 2026-10-30. Three things Marcos asked for, one wrong number found on
-- the way, and one timeout that was still there after the sport cache.
--
-- 1. "New" was the wrong shape. It meant "one deposit and the FTD was under 30
--    days ago", which let a player with one deposit and 40 settled bets sit in
--    New beside someone who deposited once and never played. Of the 89 players
--    in New, 53 had five or more bets. New now means exactly what Marcos
--    described: deposited inside the last 7 days, exactly one deposit ever,
--    fewer than 5 bets. Everyone else who deposited inside 7 days is Active.
--
--      New     89 -> 36
--      Active 265 -> 318
--
--    Checked before switching: those 53 players are the only rows that move.
--
--    'Casual' falls out of the ladder. It was already empty and could not be
--    otherwise -- it required one deposit whose FTD was 30+ days old, and with
--    a single deposit the FTD *is* the last deposit, so both conditions could
--    never hold at once. The branch stays as the ELSE so nothing falls through
--    to null, but nothing reaches it.
--
--    The stage lives in a function now rather than being spelled out in each
--    view, so player_lifecycle and player_tier_progress cannot drift apart.
--    IMMUTABLE and with no SET clause, so PostgreSQL still inlines it -- the
--    trap local_day() and is_team_member() both fell into (CLAUDE.md).
--
-- 2. Stage movement. Nothing recorded what a player's stage was last week, so
--    "who went from Active to Cooling" could not be asked at all.
--    player_stage_history keeps one row per player per import, keyed by the
--    data_through it was captured at rather than by the clock -- the same
--    anchor every recency figure here uses.
--
--    It is NOT backfilled. The stage is a threshold on days since the last
--    deposit, and the player report only ever carries the *latest* deposit
--    date, so a player's stage on 11 October is not reconstructible from what
--    we hold today. deposit_periods knows which week a player deposited in but
--    not which day, and the thresholds are 8/15/30 days, so dating a deposit to
--    its period end would move players across stage lines on invented
--    precision. History starts here; the first real comparison appears after
--    the next import.
--
-- 3. Tickets. "Ticket" is a bet slip: how many, and what the average one is
--    worth, split into the player's own money and bonus money. Per VIP tier and
--    per deposit period.
--
-- And the thing nobody asked about: vip_tier_summary joined `players`, not
-- `real_players`, so "Depósitos por segmento VIP" counted 4,298 players and DOP
-- 16,905,042 where the book holds 4,159 and 16,855,042. 139 internal and
-- excluded accounts, DOP 50,000 of their money, on a page that gets checked
-- against the backoffice. It now sums to 16,855,042 exactly.

-- ---------------------------------------------------------------------------
-- 0. The Segments timeout that the sport cache did not actually fix
-- ---------------------------------------------------------------------------
--
-- CLAUDE.md records 337 ms for one page of Segments after the sport cache. That
-- figure was measured with count(), which never builds the output rows. What
-- Segments really runs -- `select * ... order by deposits desc limit 1000` --
-- measured 3,190 ms, five pages of it, which is the timeout Marcos was still
-- hitting. Two causes, both the inlining trap again:
--
--   a. data_through was re-planned once per textual reference to dt.d. The plan
--      carried 21 separate InitPlan groups, each aggregating players. Putting
--      the anchor in a MATERIALIZED CTE collapsed them to one.
--
--        3,190 ms -> 2,015 ms
--
--   b. min_qualifying_deposit() is STABLE with a SET clause, so it is not
--      inlinable and was invoked once per row -- 4,159 calls, each querying
--      app_settings. Hoisted into the same anchor CTE as a column.
--
--        2,015 ms -> 91 ms
--
--      The plan made this hard to see: the Nested Loop building `scored` read
--      876 ms while its children totalled 60 ms. The missing 816 ms was the
--      projection, which EXPLAIN attributes to no node of its own.
--
--   c. Separately, player_bet_profile re-aggregated all 42,593 wagering bets on
--      every read, percentile_cont and all. Same situation the sport legs were
--      in, so the same answer: player_bet_stats, rebuilt at import. Verified
--      against the live aggregate across all 2,210 betting players -- bets,
--      total_stake, avg_stake, median_stake, last_bet_date, last_settlement_date
--      and open_bets all matched with zero differences.
--
-- One page of Segments, measured as `authenticated` with every column built:
--
--   | before                     | 3,190 ms |
--   | anchor materialized        | 2,015 ms |
--   | min_qualifying_deposit     |    91 ms |
--
-- Six other views still call min_qualifying_deposit() per row -- the cohort
-- views, dashboard_health. None of them is on a page anyone has reported slow,
-- so they are left alone rather than widening this change.

-- ---------------------------------------------------------------------------
-- 1. The lifecycle stage, in one place
-- ---------------------------------------------------------------------------

-- No SET clause and no SECURITY DEFINER: either one stops PostgreSQL inlining a
-- SQL function, and this is called once per row in two views. Pure arithmetic
-- on its arguments, so it is genuinely IMMUTABLE.
create or replace function public.lifecycle_stage(
  deposit_count      integer,
  days_since_deposit integer,
  bets               bigint
) returns text
language sql
immutable
parallel safe
as $$
  select case
    when deposit_count is null or deposit_count = 0
      or days_since_deposit is null              then 'Registered'
    when days_since_deposit >= 30                then 'Churned'
    when days_since_deposit >= 15                then 'At risk'
    when days_since_deposit >= 8                 then 'Cooling'
    -- Past here the player deposited inside the last 7 days.
    when deposit_count = 1
     and coalesce(bets, 0) < 5                   then 'New'
    when deposit_count >= 2 or coalesce(bets, 0) >= 5 then 'Active'
    else 'Casual'
  end
$$;

comment on function public.lifecycle_stage(integer, integer, bigint) is
  'The lifecycle stage for one player. New = deposited within 7 days, exactly one deposit ever, fewer than 5 bets; a single-deposit player with 5+ bets is Active. Kept as a function so player_lifecycle and player_tier_progress cannot drift. IMMUTABLE with no SET clause so it still inlines.';

-- Higher is healthier, so a move reads as a direction rather than a pair of
-- labels. Registered sits at the bottom: they have never paid. Churned above it
-- because they did once, and the climb back is shorter.
create or replace function public.lifecycle_rank(stage text)
returns integer
language sql
immutable
parallel safe
as $$
  select case stage
    when 'Registered' then 0
    when 'Churned'    then 1
    when 'At risk'    then 2
    when 'Cooling'    then 3
    when 'Casual'     then 3
    when 'New'        then 4
    when 'Active'     then 5
    else null
  end
$$;

comment on function public.lifecycle_rank(text) is
  'Health order for a lifecycle stage, higher being better, so a stage change reads as improved or declined. Churned outranks Registered because a churned player has paid at least once.';

-- ---------------------------------------------------------------------------
-- 2. The per-player bet aggregate becomes a cache
-- ---------------------------------------------------------------------------

create table if not exists public.player_bet_stats (
  player_key           text    primary key,
  bets                 bigint  not null,
  total_stake          numeric not null,
  avg_stake            numeric,
  median_stake         double precision,
  last_bet_date        timestamptz,
  last_settlement_date timestamptz,
  open_bets            bigint  not null default 0
);

alter table public.player_bet_stats enable row level security;

drop policy if exists player_bet_stats_team on public.player_bet_stats;
create policy player_bet_stats_team on public.player_bet_stats
  for select to authenticated
  using ((select public.is_team_member()));

revoke all on public.player_bet_stats from anon;
grant select on public.player_bet_stats to authenticated;

comment on table public.player_bet_stats is
  'Per-player bet aggregate, precomputed. Derived from bets and rebuilt by refresh_player_bet_stats() after every bet import, beside refresh_player_sport_counts() -- a cache, never a source. A real table rather than a materialized view because a matview has no RLS, and this must stay behind is_team_member().';

create or replace function public.refresh_player_bet_stats()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare n integer;
begin
  -- Rebuilt whole rather than patched, inside one transaction, so readers never
  -- see it empty. Same contract as refresh_player_sport_counts().
  delete from player_bet_stats;
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

-- SECURITY DEFINER functions are granted to public by default, which reaches
-- anon through the REST schema (CLAUDE.md).
revoke execute on function public.refresh_player_bet_stats() from anon, public;
grant execute on function public.refresh_player_bet_stats() to authenticated;

select public.refresh_player_bet_stats();

-- Same columns, same order, same types; the agg CTE is replaced by a read of
-- the cache. security_invoker restated because `create or replace view`
-- replaces reloptions wholesale.
create or replace view public.player_bet_profile with (security_invoker = true) as
 WITH sports AS (
         SELECT player_key, count(*) AS sports_played
           FROM player_sport_counts
          GROUP BY player_key
        ), top AS (
         SELECT DISTINCT ON (player_key) player_key, sport, bets
           FROM player_sport_counts
          ORDER BY player_key, bets DESC, sport
        )
 SELECT p.id,
    COALESCE(st.bets, 0::bigint) AS bets,
    COALESCE(st.total_stake, 0::numeric) AS total_stake,
    st.avg_stake,
    st.median_stake,
    st.last_bet_date,
    st.last_settlement_date,
    COALESCE(st.open_bets, 0::bigint) AS open_bets,
    COALESCE(sports.sports_played, 0::bigint) AS sports_played,
    top.sport AS top_sport,
        CASE
            WHEN COALESCE(st.bets, 0::bigint) > 0 AND top.bets IS NOT NULL
              THEN round(100.0 * top.bets::numeric / st.bets::numeric, 1)
            ELSE NULL::numeric
        END AS top_sport_share
   FROM players p
     LEFT JOIN player_bet_stats st ON st.player_key = p.id
     LEFT JOIN sports ON sports.player_key = p.id
     LEFT JOIN top ON top.player_key = p.id;

-- ---------------------------------------------------------------------------
-- 3. player_lifecycle: new stage definition, and the anchor hoisted
-- ---------------------------------------------------------------------------

-- Same columns, same order, same types as before. What changes:
--   * the lifecycle CASE becomes a call of lifecycle_stage()
--   * data_through and min_qualifying_deposit() move into one MATERIALIZED CTE
--     so each is evaluated once per statement instead of once per reference and
--     once per row (section 0)
--   * below_deposit_floor moves into `scored` for the same reason
create or replace view public.player_lifecycle with (security_invoker = true) as
 WITH anchor AS MATERIALIZED (
         SELECT dt.d, min_qualifying_deposit() AS min_dep FROM data_through dt
        ), base AS (
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
        ), scored AS MATERIALIZED (
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
                CASE WHEN b.deposits >= dt.min_dep THEN b.raw_deposit_count
                     ELSE 0 END AS deposit_count,
                b.deposits < dt.min_dep AND b.raw_deposit_count > 0 AS below_deposit_floor,
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
             CROSS JOIN anchor dt
        )
 SELECT id, name, username, email, country, vip_tier,
    registered_at, last_login_at, first_deposit_date, last_deposit_date,
    deposit_count, raw_deposit_count, deposits, ggr, cashback,
    bets, total_stake, avg_stake, median_stake,
    last_bet_date, last_settlement_date, open_bets,
    sports_played, top_sport, top_sport_share,
    last_activity, days_inactive, days_since_login, days_since_settlement, days_since_ftd,
    below_deposit_floor,
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
    lifecycle_stage(deposit_count, days_since_deposit, bets) AS lifecycle,
    days_since_deposit, days_since_bet, data_through,
    cash_balance, bonus_balance, total_balance, wallet_updated_at, days_since_wallet,
    restricted, restriction_reason
   FROM scored;

-- ---------------------------------------------------------------------------
-- 4. player_tier_progress gains the stage, without a join
-- ---------------------------------------------------------------------------

-- Opening a tier on the VIP page should say whether each player is active or
-- going cold. The stage is computed inline from columns this view already has:
-- joining player_lifecycle would pull player_bet_profile in a second time, and
-- this is the view that cost 10,321 ms once (CLAUDE.md). min_qualifying_deposit()
-- joins the existing `win` anchor for the reason in section 0.
--
-- Measured as `authenticated`, naming lifecycle, trailing_wager, top_sport and
-- median_stake: 1,647 ms with the function called per row, 425 ms hoisted. The
-- 324 ms that remain are the 90-day wager window over 42,593 bets, which is the
-- view's whole purpose.
--
-- Checked against player_lifecycle after both changes: the stage agrees on all
-- 4,159 players, zero differences.
create or replace view public.player_tier_progress with (security_invoker = true) as
 WITH win AS MATERIALIZED (
         SELECT ((dt.d + 1)::timestamp without time zone AT TIME ZONE 'America/Santo_Domingo'::text) AS hi,
            ((dt.d + 1)::timestamp without time zone AT TIME ZONE 'America/Santo_Domingo'::text) - '90 days'::interval AS lo,
            dt.d,
            min_qualifying_deposit() AS min_dep
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
    win.d AS data_through,
    -- Same deposit floor player_lifecycle applies, so the two agree on who
    -- counts as having deposited at all.
    lifecycle_stage(
      CASE WHEN COALESCE(p.total_deposit_amount, 0::numeric) >= win.min_dep
           THEN COALESCE(p.total_deposit_count, 0) ELSE 0 END,
      CASE WHEN p.last_deposit_date IS NULL THEN NULL::integer
           ELSE win.d - local_day(p.last_deposit_date) END,
      COALESCE(bp.bets, 0::bigint)
    ) AS lifecycle,
    p.restricted, p.restriction_reason
   FROM real_players p
     CROSS JOIN win
     LEFT JOIN wagered w ON w.id = p.id
     LEFT JOIN vip_tiers ct ON ct.tier_name = COALESCE(p.vip_tier, 'Prospecto'::text)
     LEFT JOIN LATERAL ( SELECT t.tier_name, t.wager_required_dop
           FROM vip_tiers t WHERE t.tier_order > ct.tier_order
          ORDER BY t.tier_order LIMIT 1) nt ON true
     LEFT JOIN player_bet_profile bp ON bp.id = p.id;

-- ---------------------------------------------------------------------------
-- 5. Stage history
-- ---------------------------------------------------------------------------

-- No foreign key to players(id), for the same two reasons player_notes has
-- none: ON DELETE CASCADE would let a re-import that drops a player row erase
-- history that cannot be rebuilt, and adding the constraint takes a lock on
-- players, which the dashboard reads constantly.
create table if not exists public.player_stage_history (
  player_id          text not null,
  captured_on        date not null,
  lifecycle          text not null,
  vip_tier           text,
  deposit_count      integer     not null default 0,
  deposits           numeric     not null default 0,
  bets               bigint      not null default 0,
  days_since_deposit integer,
  captured_at        timestamptz not null default now(),
  primary key (player_id, captured_on)
);

comment on table public.player_stage_history is
  'One row per player per import, keyed by the data_through it was captured at rather than by the clock. Written by snapshot_player_stages() at the end of the player report import. Never backfilled: the player report carries only the latest deposit date, so a past stage is not reconstructible, and deposit_periods knows the week a deposit landed in but not the day, which is finer than the 8/15/30-day thresholds need.';

create index if not exists player_stage_history_captured_idx
  on public.player_stage_history (captured_on, lifecycle);

alter table public.player_stage_history enable row level security;

drop policy if exists player_stage_history_team on public.player_stage_history;
create policy player_stage_history_team on public.player_stage_history
  for select to authenticated
  using ((select public.is_team_member()));

revoke all on public.player_stage_history from anon;
grant select on public.player_stage_history to authenticated;

create or replace function public.snapshot_player_stages()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare n integer; d date;
begin
  select dt.d into d from data_through dt;
  if d is null then
    return 0;
  end if;
  -- Keyed on the data cut-off, so re-importing the same week corrects that
  -- week's row instead of adding a second one. Two imports on the same day are
  -- one snapshot; two weeks of data are two.
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

-- Stage counts per capture, which is what the strip on Segments compares
-- against. One row per stage per import rather than per player.
create or replace view public.lifecycle_trend with (security_invoker = true) as
 select h.captured_on,
        h.lifecycle,
        count(*)::bigint                      as players,
        coalesce(sum(h.deposits), 0::numeric) as deposits
   from player_stage_history h
  group by h.captured_on, h.lifecycle;

-- Who moved, and in which direction, between one capture and the one before it
-- for that player. Consecutive captures per player rather than per calendar, so
-- a player who first appears in the second import has no phantom move.
create or replace view public.player_stage_moves with (security_invoker = true) as
 with ordered as (
   select h.player_id, h.captured_on, h.lifecycle, h.vip_tier,
          h.deposit_count, h.deposits, h.bets, h.days_since_deposit,
          lag(h.lifecycle)   over w as prev_lifecycle,
          lag(h.captured_on) over w as prev_captured_on,
          lag(h.vip_tier)    over w as prev_vip_tier,
          lag(h.deposits)    over w as prev_deposits
     from player_stage_history h
   window w as (partition by h.player_id order by h.captured_on)
 )
 select o.player_id,
        o.captured_on,
        o.prev_captured_on,
        o.lifecycle,
        o.prev_lifecycle,
        o.vip_tier,
        o.prev_vip_tier,
        lifecycle_rank(o.lifecycle) - lifecycle_rank(o.prev_lifecycle) as rank_change,
        case
          when lifecycle_rank(o.lifecycle) > lifecycle_rank(o.prev_lifecycle) then 'up'
          when lifecycle_rank(o.lifecycle) < lifecycle_rank(o.prev_lifecycle) then 'down'
          else 'sideways'
        end as direction,
        o.deposits - coalesce(o.prev_deposits, 0::numeric) as deposits_added,
        o.deposits, o.deposit_count, o.bets, o.days_since_deposit,
        p.name, p.username, p.email, p.restricted, p.restriction_reason,
        p.total_balance, p.last_deposit_date, p.last_login_at
   from ordered o
   join real_players p on p.id = o.player_id
  where o.prev_lifecycle is not null
    and o.lifecycle is distinct from o.prev_lifecycle;

comment on view public.player_stage_moves is
  'Every player whose lifecycle stage differs from their own previous capture. direction is signed by lifecycle_rank, so "Churned -> Active" reads as up and "Active -> Cooling" as down. Empty until a second import has been captured.';

-- Seed the first capture, so the next import has something to compare against.
select public.snapshot_player_stages();

-- ---------------------------------------------------------------------------
-- 6. Tickets
-- ---------------------------------------------------------------------------

-- A ticket is a bet slip. Counted on the same statuses that count as wagering
-- everywhere else, so the figures agree with GGR and with the VIP ladder.
-- stake is the player's own money and bonus_stake is promotional money; the two
-- are additive, which is how player_tier_progress already computes the trailing
-- wager.
create or replace view public.player_tickets with (security_invoker = true) as
 select b.player_key as id,
        count(*)::bigint                                  as tickets,
        sum(coalesce(b.stake, 0::numeric)
          + coalesce(b.bonus_stake, 0::numeric))          as ticket_value,
        sum(coalesce(b.stake, 0::numeric))                as cash_stake,
        sum(coalesce(b.bonus_stake, 0::numeric))          as bonus_stake,
        count(*) filter (where coalesce(b.bonus_stake, 0::numeric) > 0)::bigint as bonus_tickets
   from bets b
  where bet_counts_as_wagering(b.status)
    and b.player_key is not null
  group by b.player_key;

-- real_players, not players. avg_deposit stays the per-player average it always
-- was; avg_deposit_ticket is the new one and the one that answers "what is a
-- deposit worth here" -- total deposited over deposits made, not over players.
--
-- Measured as `authenticated` naming tickets, avg_ticket and cash_stake: 321 ms.
create or replace view public.vip_tier_summary with (security_invoker = true) as
 select t.tier_name,
    t.tier_order,
    t.wager_required_dop,
    t.cashback_pct,
    t.promotion_bonus_dop,
    count(p.id)                                               as players,
    coalesce(sum(p.total_deposit_amount), 0::numeric)         as total_deposits,
    coalesce(avg(p.total_deposit_amount), 0::numeric)         as avg_deposit,
    coalesce(sum(p.total_ggr_sportsbook), 0::numeric)         as total_ggr,
    count(p.id) filter (where p.is_ftd)                       as ftd_players,
    -- Everything below is new, and appended rather than slotted in beside what
    -- it belongs with: `create or replace view` refuses to reorder columns.
    coalesce(sum(p.total_deposit_count), 0::bigint)           as deposit_count,
    case when coalesce(sum(p.total_deposit_count), 0) > 0
         then sum(p.total_deposit_amount) / sum(p.total_deposit_count)
    end                                                       as avg_deposit_ticket,
    coalesce(sum(k.tickets), 0::bigint)                       as tickets,
    coalesce(sum(k.ticket_value), 0::numeric)                 as ticket_value,
    coalesce(sum(k.cash_stake), 0::numeric)                   as cash_stake,
    coalesce(sum(k.bonus_stake), 0::numeric)                  as bonus_stake,
    case when coalesce(sum(k.tickets), 0) > 0
         then sum(k.ticket_value) / sum(k.tickets)
    end                                                       as avg_ticket
   from vip_tiers t
     left join real_players p on p.vip_tier = t.tier_name
     left join player_tickets k on k.id = p.id
  group by t.tier_name, t.tier_order, t.wager_required_dop, t.cashback_pct, t.promotion_bonus_dop;

-- Tickets per deposit period, so the net cash table can say how much play the
-- money bought. Bets carry a real bet_date, so unlike the deposits themselves
-- these are attributable to a day; the period bounds are converted to
-- timestamptz once and compared against the raw column, which is what keeps
-- bets(bet_date) usable as an index (CLAUDE.md).
create or replace view public.deposit_period_tickets with (security_invoker = true) as
 with spans as (
   select distinct period_start, period_end
     from deposit_periods
    where scope = 'primary'
 )
 select s.period_start,
        s.period_end,
        count(b.bet_id)::bigint                            as tickets,
        count(distinct b.player_key)::bigint               as bettors,
        coalesce(sum(coalesce(b.stake, 0::numeric)
                   + coalesce(b.bonus_stake, 0::numeric)), 0::numeric) as ticket_value,
        coalesce(sum(coalesce(b.stake, 0::numeric)), 0::numeric)       as cash_stake,
        coalesce(sum(coalesce(b.bonus_stake, 0::numeric)), 0::numeric) as bonus_stake,
        case when count(b.bet_id) > 0
             then sum(coalesce(b.stake, 0::numeric) + coalesce(b.bonus_stake, 0::numeric))
                  / count(b.bet_id)
        end                                                as avg_ticket
   from spans s
   left join bets b
     on b.bet_date >= (s.period_start::timestamp at time zone 'America/Santo_Domingo')
    and b.bet_date <  ((s.period_end + 1)::timestamp at time zone 'America/Santo_Domingo')
    and bet_counts_as_wagering(b.status)
  group by s.period_start, s.period_end;

comment on view public.deposit_period_tickets is
  'Bet slips placed inside each primary deposit period. Deposits in that report are an aggregate over a date range with no day on them; bets are not, so these are attributed exactly. Tickets outside any primary period are in no row here.';
