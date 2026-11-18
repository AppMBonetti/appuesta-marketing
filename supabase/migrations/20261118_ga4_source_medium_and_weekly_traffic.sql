-- GA4: source/medium alongside channel, and a week-over-week traffic rollup.
--
-- Three things were missing for "resumen semanal del trafico por canal,
-- source/medium, y el costo por trafico":
--
--   1. source/medium was not stored at all. `ga4_channel_daily` holds only the
--      default channel grouping, which collapses every Meta placement into
--      "Paid Social" and every referrer into "Referral".
--   2. the channel screen aggregates whatever the period bar selects, so there
--      was no week-by-week grid and no week-over-week change per channel.
--   3. spend exists only as one weekly total (`weekly_spend`), so cost per
--      session could never be split by channel.
--
-- Week boundaries are Monday, via date_trunc('week', ...), which is the same
-- boundary `weekly_spend.week_start`, `local_week()` and the front end's
-- weekStartOf() already use. A traffic week is therefore the same seven days as
-- a KPI week rather than a different seven with the same name.

-- ---------------------------------------------------------------------------
-- 1. New users on the channel table
-- ---------------------------------------------------------------------------
-- Every GA4 traffic export carries it and it is the one column that separates
-- "more traffic" from "more of the same traffic". Nullable, so the 101 rows
-- already loaded stay valid rather than claiming zero new users.
alter table public.ga4_channel_daily add column if not exists new_users integer;

-- ---------------------------------------------------------------------------
-- 2. source/medium daily
-- ---------------------------------------------------------------------------
-- Keyed on (date, source_medium) rather than (date, source, medium): the export
-- gives the pair as one string ("google / organic"), and splitting it is for
-- filtering, not identity. A row whose medium is absent ("(direct) / (none)")
-- still has a stable key this way.
--
-- `channel` is carried when the file supplies both dimensions, because GA4
-- derives the channel grouping from source/medium, so the pair maps to exactly
-- one channel and keeping it lets one table answer both questions.
create table if not exists public.ga4_source_medium_daily (
  date            date    not null,
  source_medium   text    not null,
  source          text,
  medium          text,
  channel         text,
  sessions        integer not null default 0,
  active_users    integer,
  new_users       integer,
  engagement_rate numeric,
  conversions     integer,
  primary key (date, source_medium)
);

alter table public.ga4_source_medium_daily enable row level security;

-- The (select ...) wrapper is not optional: is_team_member() is STABLE
-- SECURITY DEFINER with a SET clause, so PostgreSQL will not inline it and a
-- bare call is evaluated once per row, each one querying team_members.
drop policy if exists "team full access" on public.ga4_source_medium_daily;
create policy "team full access" on public.ga4_source_medium_daily
  for all using ((select public.is_team_member()))
  with check ((select public.is_team_member()));

-- A source/medium list is read a week at a time, and sorted by sessions.
create index if not exists ga4_source_medium_daily_date_idx
  on public.ga4_source_medium_daily (date);

-- ---------------------------------------------------------------------------
-- 3. Spend per channel per week
-- ---------------------------------------------------------------------------
-- `weekly_spend` holds one total per week, which is all the weekly report
-- needed. Cost per session *by channel* cannot be derived from a single total,
-- so this is the one new hand-entered input. It is deliberately optional: a
-- week with no rows here still shows traffic, just without a cost column, and
-- `ga4_weekly_totals.channel_spend_total` below is what tells you the parts do
-- not sum to the total you already entered.
create table if not exists public.channel_spend (
  week_start date    not null,
  channel    text    not null,
  spend_dop  numeric not null default 0,
  notes      text,
  updated_at timestamptz not null default now(),
  primary key (week_start, channel)
);

alter table public.channel_spend enable row level security;

drop policy if exists "team full access" on public.channel_spend;
create policy "team full access" on public.channel_spend
  for all using ((select public.is_team_member()))
  with check ((select public.is_team_member()));

-- ---------------------------------------------------------------------------
-- 4. Weekly rollups
-- ---------------------------------------------------------------------------
-- security_invoker=true on every view, as everywhere else here: without it the
-- view runs as its owner and the base table's RLS is bypassed, which would make
-- the affiliate portal's anon role able to read the whole traffic history.

-- How many distinct days of GA4 data a week holds, counted across ALL channels
-- rather than per channel. GA4 writes no row for a channel on a day it saw no
-- sessions, so counting a single channel's days would call a quiet week a
-- partial one. Seven means the week is complete; fewer means it is not, and the
-- screens say so instead of drawing a short week at full height.
create or replace view public.ga4_week_coverage
with (security_invoker = true) as
select date_trunc('week', g.date)::date as week_start,
       count(distinct g.date)           as days_with_data,
       min(g.date)                      as first_day,
       max(g.date)                      as last_day
from public.ga4_channel_daily g
group by 1;

create or replace view public.ga4_weekly_channel
with (security_invoker = true) as
with agg as (
  select date_trunc('week', g.date)::date as week_start,
         g.channel,
         sum(g.sessions)                  as sessions,
         sum(g.active_users)              as users,
         sum(g.new_users)                 as new_users,
         sum(g.conversions)               as conversions,
         -- Engagement rate is a ratio per row, so it is re-weighted by
         -- sessions. Averaging the daily rates would over-weight quiet days.
         case when sum(g.sessions) > 0
              then sum(g.engagement_rate * g.sessions) / sum(g.sessions)
         end                              as engagement_rate
  from public.ga4_channel_daily g
  group by 1, 2
)
select a.week_start,
       a.channel,
       a.sessions,
       a.users,
       a.new_users,
       a.conversions,
       a.engagement_rate,
       c.days_with_data,
       -- Joined on week_start - 7, not lag(): lag would compare against the
       -- previous week *present in the data*, so a missing week would be
       -- silently treated as adjacent and the change would be wrong rather
       -- than absent.
       p.sessions as prev_sessions,
       case when p.sessions > 0
            then (a.sessions - p.sessions)::numeric / p.sessions
       end as sessions_change,
       s.spend_dop as spend,
       case when a.sessions > 0 and s.spend_dop is not null
            then s.spend_dop / a.sessions
       end as cost_per_session
from agg a
join public.ga4_week_coverage c on c.week_start = a.week_start
left join agg p on p.channel = a.channel and p.week_start = a.week_start - 7
left join public.channel_spend s on s.week_start = a.week_start and s.channel = a.channel;

create or replace view public.ga4_weekly_source_medium
with (security_invoker = true) as
with cov as (
  select date_trunc('week', g.date)::date as week_start,
         count(distinct g.date)           as days_with_data
  from public.ga4_source_medium_daily g
  group by 1
),
agg as (
  select date_trunc('week', g.date)::date as week_start,
         g.source_medium,
         min(g.source)  as source,
         min(g.medium)  as medium,
         -- One source/medium maps to one GA4 channel, so min() is picking the
         -- only value there is; it is written as an aggregate because the
         -- column is nullable when the export carried no channel dimension.
         min(g.channel) as channel,
         sum(g.sessions)     as sessions,
         sum(g.active_users) as users,
         sum(g.new_users)    as new_users,
         sum(g.conversions)  as conversions,
         case when sum(g.sessions) > 0
              then sum(g.engagement_rate * g.sessions) / sum(g.sessions)
         end as engagement_rate
  from public.ga4_source_medium_daily g
  group by 1, 2
)
select a.week_start,
       a.source_medium,
       a.source,
       a.medium,
       a.channel,
       a.sessions,
       a.users,
       a.new_users,
       a.conversions,
       a.engagement_rate,
       c.days_with_data,
       p.sessions as prev_sessions,
       case when p.sessions > 0
            then (a.sessions - p.sessions)::numeric / p.sessions
       end as sessions_change
       -- No cost column here on purpose. Spend is entered per channel, and
       -- dividing a channel's spend across the source/medium pairs inside it
       -- would invent a split nobody supplied.
from agg a
join cov c on c.week_start = a.week_start
left join agg p on p.source_medium = a.source_medium and p.week_start = a.week_start - 7;

-- Week totals, joined to the single weekly spend figure the weekly report
-- already uses, so cost per session at the top of the screen ties to the
-- cost per session in the weekly grid instead of being a second opinion.
create or replace view public.ga4_weekly_totals
with (security_invoker = true) as
with agg as (
  select date_trunc('week', g.date)::date as week_start,
         sum(g.sessions)     as sessions,
         sum(g.active_users) as users,
         sum(g.new_users)    as new_users,
         sum(g.conversions)  as conversions,
         case when sum(g.sessions) > 0
              then sum(g.engagement_rate * g.sessions) / sum(g.sessions)
         end as engagement_rate
  from public.ga4_channel_daily g
  group by 1
)
select a.week_start,
       a.sessions,
       a.users,
       a.new_users,
       a.conversions,
       a.engagement_rate,
       c.days_with_data,
       ws.spend_dop as spend,
       -- What the per-channel rows add up to, beside the total that was
       -- entered for the week. A gap means the channel split is incomplete,
       -- which is the difference between "Direct cost DOP 0" and "nobody has
       -- said what Direct cost".
       cs.channel_spend_total,
       case when a.sessions > 0 and ws.spend_dop is not null
            then ws.spend_dop / a.sessions
       end as cost_per_session,
       p.sessions as prev_sessions,
       case when p.sessions > 0
            then (a.sessions - p.sessions)::numeric / p.sessions
       end as sessions_change,
       -- Appended last on purpose: `create or replace view` can add a column
       -- at the end of the select list but cannot rename or reorder the ones
       -- already there, so a column inserted mid-list needs a drop and the
       -- drop needs every dependent object rebuilt.
       --
       -- The last day of GA4 data inside the week, so a screen can say how
       -- current it is from the data rather than from the clock.
       c.last_day
from agg a
join public.ga4_week_coverage c on c.week_start = a.week_start
left join public.weekly_spend ws on ws.week_start = a.week_start
left join (
  select week_start, sum(spend_dop) as channel_spend_total
  from public.channel_spend group by 1
) cs on cs.week_start = a.week_start
left join agg p on p.week_start = a.week_start - 7;
