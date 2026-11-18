-- Rollback for 20261118_ga4_source_medium_and_weekly_traffic.sql
--
-- Dropping `ga4_source_medium_daily` and `channel_spend` discards data that
-- cannot be recomputed from anything else in this database: the source/medium
-- rows come from a GA4 export, and the channel spend was typed in by hand. Keep
-- the tables unless the point of the rollback is to lose them.
drop view if exists public.ga4_weekly_totals;
drop view if exists public.ga4_weekly_source_medium;
drop view if exists public.ga4_weekly_channel;
drop view if exists public.ga4_week_coverage;

-- drop table if exists public.channel_spend;             -- hand-entered
-- drop table if exists public.ga4_source_medium_daily;   -- re-importable only from the original export
-- alter table public.ga4_channel_daily drop column if exists new_users;
