-- The VIP tier table, by period instead of by all time.
--
-- The ladder has only ever shown lifetime totals: what each tier has deposited
-- since 10 August. Marcos asked to see it "por fecha tambien envez de un
-- agregado de por siempre" -- what GOAT put in last month, not ever.
--
-- Two things make this not a date filter:
--
-- 1. **Deposits have no day.** The payments report is one aggregate per player
--    per period with no dates inside it, so the smallest unit that can be
--    attributed is a whole period. An arbitrary "17-23 October" cannot be
--    answered at all, and the honest grains are the ones deposits_weekly and
--    deposits_monthly already use: a period, and a month assembled from the
--    periods that sit inside it. Bets are different -- they carry a real
--    bet_date -- so the ticket columns beside each period are exact while the
--    deposit columns are attributed to the period as a whole.
--
-- 2. **The tier is today's tier.** vip_tier is recomputed on every import from
--    trailing 90-day wagering, and nothing stores what somebody's tier was in
--    September. So these views answer "what did the players who are GOAT *now*
--    deposit in September", not "what did September's GOATs deposit". That is
--    still the question being asked -- the ladder is read to decide who to look
--    after -- but the screens have to say which one it is, and they do.
--
-- Both views inherit the two bugs already fixed in vip_tier_summary:
--   * real_players, not players, or 139 internal and excluded accounts and
--     DOP 50,000 of their money land on a page checked against the backoffice;
--   * coalesce(vip_tier, 'Prospecto'), or every player whose tier is null --
--     which is all of them until assign_vip_tiers() next runs -- drops out.

-- Per primary period, per tier. `validation` periods count toward nothing, so
-- they are out: a month-wide file parked for checking must not add itself to a
-- tier's total on top of the weeks it overlaps.
create or replace view public.vip_tier_period_summary with (security_invoker = true) as
with spans as (
  select distinct d.period_start, d.period_end,
         -- A week straddling a month boundary cannot be split into its two
         -- halves (the standing monthly tax), so the month rollup below has to
         -- leave it out. Flagged here so the screens can say so rather than
         -- quietly reporting a short month.
         (date_trunc('month', d.period_start::timestamp)
            <> date_trunc('month', d.period_end::timestamp)) as straddles_month
    from deposit_periods d
   where d.scope = 'primary'
),
tiered as (
  select p.id, coalesce(p.vip_tier, 'Prospecto') as tier_key from real_players p
),
dep as (
  select s.period_start, s.period_end, t.tier_key,
         count(distinct d.player_id) filter (where d.deposit_count > 0) as depositors,
         coalesce(sum(d.deposit_count), 0)::bigint   as deposit_count,
         coalesce(sum(d.deposit_amount), 0)::numeric as deposits,
         coalesce(sum(d.payout_count), 0)::bigint    as payout_count,
         coalesce(sum(d.payout_amount), 0)::numeric  as payouts
    from spans s
    join deposit_periods d
      on d.period_start = s.period_start and d.period_end = s.period_end
     and d.scope = 'primary'
    join tiered t on t.id = d.player_id
   group by s.period_start, s.period_end, t.tier_key
),
-- The window converted to timestamptz once and compared against the raw
-- column, which is the form that made deposit_period_tickets fast. Never
-- local_day(bet_date) between a and b over a table this size.
-- One day per covered day, so the bets side is an equi-join on a date
-- instead of a range join evaluated once per period. The range form worked and
-- did not scale: every period re-scanned the whole bets table, 12 x 54,699 =
-- 656k join-filter rows today, and both sides grow weekly, so the cost is the
-- product. local_day() is IMMUTABLE and expression-indexed, which is the whole
-- reason it can carry an equality here.
span_days as (
  select period_start, period_end,
         generate_series(period_start, period_end, interval '1 day')::date as d
    from spans
),
tix as (
  select sd.period_start, sd.period_end, t.tier_key,
         count(b.bet_id)                 as tickets,
         count(distinct b.player_key)    as bettors,
         coalesce(sum(coalesce(b.stake, 0) + coalesce(b.bonus_stake, 0)), 0)::numeric as ticket_value,
         coalesce(sum(coalesce(b.stake, 0)), 0)::numeric       as cash_stake,
         coalesce(sum(coalesce(b.bonus_stake, 0)), 0)::numeric as bonus_stake
    from span_days sd
    join bets b
      on local_day(b.bet_date) = sd.d
     and bet_counts_as_wagering(b.status)
    join tiered t on t.id = b.player_key
   group by sd.period_start, sd.period_end, t.tier_key
)
select s.period_start,
       s.period_end,
       s.straddles_month,
       v.tier_name,
       v.tier_order,
       coalesce(d.depositors, 0)    as depositors,
       coalesce(d.deposit_count, 0) as deposit_count,
       coalesce(d.deposits, 0)      as deposits,
       coalesce(d.payout_count, 0)  as payout_count,
       coalesce(d.payouts, 0)       as payouts,
       coalesce(d.deposits, 0) - coalesce(d.payouts, 0) as net_cash,
       case when coalesce(d.deposit_count, 0) > 0
            then d.deposits / d.deposit_count end as avg_deposit_ticket,
       coalesce(x.tickets, 0)       as tickets,
       coalesce(x.bettors, 0)       as bettors,
       coalesce(x.ticket_value, 0)  as ticket_value,
       coalesce(x.cash_stake, 0)    as cash_stake,
       coalesce(x.bonus_stake, 0)   as bonus_stake,
       case when coalesce(x.tickets, 0) > 0
            then x.ticket_value / x.tickets end as avg_ticket
  -- Every tier for every period, so a tier that deposited nothing reads as a
  -- zero rather than vanishing from the table that month.
  from spans s
  cross join vip_tiers v
  left join dep d on d.period_start = s.period_start and d.period_end = s.period_end
                 and d.tier_key = v.tier_name
  left join tix x on x.period_start = s.period_start and x.period_end = s.period_end
                 and x.tier_key = v.tier_name;

-- The same figures per calendar month, assembled exactly the way
-- deposits_monthly assembles them: only primary periods that begin and end in
-- the same month, so a straddling week is left out rather than putting its
-- out-of-month days somewhere they do not belong.
--
-- Deposits and tickets are each aggregated to (month, player) *before* they
-- meet, for two separate reasons. Deposits, because a player who deposited in
-- three weeks of the month is one depositor and count(distinct) cannot be
-- summed from per-period counts. Tickets, because joining them onto one row
-- per period would multiply them by the number of periods the player appears
-- in. And the bets side is one grouped pass over the month's windows rather
-- than a correlated lateral per player: three of those cost player_bet_profile
-- 2.3s, and aggregating once took it to 1ms.
create or replace view public.vip_tier_month_summary with (security_invoker = true) as
with month_periods as (
  select date_trunc('month', d.period_start::timestamp)::date as month_start,
         d.period_start, d.period_end
    from deposit_periods d
   where d.scope = 'primary'
     and date_trunc('month', d.period_start::timestamp)
       = date_trunc('month', d.period_end::timestamp)
   group by 1, 2, 3
),
months as (
  select month_start,
         min(period_start) as covered_from,
         max(period_end)   as covered_to
    from month_periods group by month_start
),
tiered as (
  select p.id, coalesce(p.vip_tier, 'Prospecto') as tier_key from real_players p
),
dep as (
  select mp.month_start, d.player_id,
         sum(d.deposit_count)  as deposit_count,
         sum(d.deposit_amount) as deposits,
         sum(d.payout_count)   as payout_count,
         sum(d.payout_amount)  as payouts
    from month_periods mp
    join deposit_periods d
      on d.period_start = mp.period_start and d.period_end = mp.period_end
     and d.scope = 'primary'
   group by mp.month_start, d.player_id
),
-- Expanded to days for the same reason as the period view above. Days, not
-- the month's covered_from..covered_to span: a month missing a week has a gap
-- in the middle, and a span would swallow the bets placed in it.
month_days as (
  select month_start,
         generate_series(period_start, period_end, interval '1 day')::date as d
    from month_periods
),
tix as (
  select md.month_start, b.player_key as player_id,
         count(b.bet_id) as tickets,
         coalesce(sum(coalesce(b.stake, 0) + coalesce(b.bonus_stake, 0)), 0)::numeric as ticket_value,
         coalesce(sum(coalesce(b.stake, 0)), 0)::numeric       as cash_stake,
         coalesce(sum(coalesce(b.bonus_stake, 0)), 0)::numeric as bonus_stake
    from month_days md
    join bets b on local_day(b.bet_date) = md.d
                and bet_counts_as_wagering(b.status)
   where b.player_key is not null
   group by md.month_start, b.player_key
),
-- A player who bet in the month without depositing still belongs to their
-- tier's ticket figures, and one who deposited without betting to its deposit
-- figures, so neither side may drop the other's rows.
joined as (
  select j.month_start, j.player_id, t.tier_key,
         j.deposit_count, j.deposits, j.payout_count, j.payouts,
         j.tickets, j.ticket_value, j.cash_stake, j.bonus_stake
    from (
      select coalesce(d.month_start, x.month_start) as month_start,
             coalesce(d.player_id, x.player_id)     as player_id,
             d.deposit_count, d.deposits, d.payout_count, d.payouts,
             x.tickets, x.ticket_value, x.cash_stake, x.bonus_stake
        from dep d
        full join tix x on x.month_start = d.month_start and x.player_id = d.player_id
    ) j
    -- Inner, and this is what holds the figures to the book: deposit_periods
    -- carries rows for internal and excluded accounts too, and real_players is
    -- what keeps them out. The same join deposits_monthly makes.
    join tiered t on t.id = j.player_id
)
select m.month_start,
       m.covered_from,
       m.covered_to,
       greatest(m.month_start, operations_start())        as first_coverable_day,
       (m.month_start + interval '1 month -1 days')::date as month_last_day,
       (m.covered_from <= greatest(m.month_start, operations_start())
        and m.covered_to >= (m.month_start + interval '1 month -1 days')::date) as complete,
       v.tier_name,
       v.tier_order,
       count(distinct j.player_id) filter (where j.deposit_count > 0) as depositors,
       coalesce(sum(j.deposit_count), 0)::bigint   as deposit_count,
       coalesce(sum(j.deposits), 0)::numeric       as deposits,
       coalesce(sum(j.payout_count), 0)::bigint    as payout_count,
       coalesce(sum(j.payouts), 0)::numeric        as payouts,
       coalesce(sum(j.deposits), 0) - coalesce(sum(j.payouts), 0) as net_cash,
       case when coalesce(sum(j.deposit_count), 0) > 0
            then sum(j.deposits) / sum(j.deposit_count) end as avg_deposit_ticket,
       count(distinct j.player_id) filter (where j.tickets > 0) as bettors,
       coalesce(sum(j.tickets), 0)::bigint       as tickets,
       coalesce(sum(j.ticket_value), 0)::numeric as ticket_value,
       coalesce(sum(j.cash_stake), 0)::numeric   as cash_stake,
       coalesce(sum(j.bonus_stake), 0)::numeric  as bonus_stake,
       case when coalesce(sum(j.tickets), 0) > 0
            then sum(j.ticket_value) / sum(j.tickets) end as avg_ticket
  -- Every tier in every month, so a tier that deposited nothing that month
  -- reads as a zero instead of disappearing from the table.
  from months m
  cross join vip_tiers v
  left join joined j on j.month_start = m.month_start and j.tier_key = v.tier_name
 group by m.month_start, m.covered_from, m.covered_to, v.tier_name, v.tier_order;

-- Verified before shipping, as `authenticated` with a team JWT:
--
--   * The month view ties to deposits_monthly exactly -- deposits, deposit
--     count and distinct depositors -- for all four months: August 2,437,252;
--     September 2,633,016.23; October 14,716,376.94; November 458,992.
--     Difference 0.00 on every one.
--   * The day equi-join returns identical figures to the range-join form it
--     replaced: 24 and 72 rows, deposits 20,245,637.17, 5,258 deposits, 52,632
--     tickets, ticket value 99,385,191.41, bonus stake 10,728,777.19 -- every
--     column of both views unchanged. month 899 ms -> 209 ms, period 361 ms.
--
-- And one difference that is not a bug and has to stay visible on screen: the
-- months sum to DOP 41,991 MORE than real_players.total_deposit_amount, over
-- 16 players out of 850 (15 higher, 1 lower, the rest exact). The windows come
-- from the payments report, which is keyed on the deposit's *created* date;
-- the lifetime column comes from the player report. 0.2%, and the ladder's
-- footnote says so, because somebody adding the months up and comparing them
-- against "Historico" would otherwise find the gap on their own.
