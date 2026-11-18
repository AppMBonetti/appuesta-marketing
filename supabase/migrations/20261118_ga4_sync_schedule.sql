-- The daily GA4 pull: extensions, the on-demand trigger, and the schedule.
--
-- The Edge Function `ga4-sync` talks to Google's Data API, which is free — the
-- thing that expired on 2026-08-31 was a reseller's trial, not any Google
-- entitlement. See CLAUDE.md, "GA4 stopped on 18 August because a trial
-- expired".
--
-- Why the function authenticates itself instead of using the platform's JWT
-- check: the schedule calls it from inside Postgres, which has no session to
-- present. So `ga4-sync` is deployed with verify_jwt off and compares a token
-- that lives in exactly two places — the function's own secrets, and this
-- project's Vault under `ga4_sync_token`. Neither is in this repository, and
-- the token's only power is "cause a GA4 pull".

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- On demand
-- ---------------------------------------------------------------------------
-- So a backfill does not need the token in somebody's hands: the range is
-- optional, and omitting it pulls from two days before the newest stored day
-- up to yesterday.
--
-- SECURITY DEFINER because `vault.decrypted_secrets` is not readable by a team
-- member, and the authorization is therefore done here, explicitly, rather than
-- inherited.
create or replace function public.trigger_ga4_sync(p_start date default null, p_end date default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_request_id bigint;
begin
  if not (select public.is_team_member()) then
    raise exception 'not authorized';
  end if;

  select decrypted_secret into v_token
  from vault.decrypted_secrets where name = 'ga4_sync_token';

  if v_token is null then
    raise exception 'ga4_sync_token is not in the vault — the GA4 sync is not set up yet';
  end if;

  select net.http_post(
    url := 'https://jqnrohfidmszbcxwocmk.supabase.co/functions/v1/ga4-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-ga4-sync-token', v_token
    ),
    -- jsonb_strip_nulls so an omitted bound stays omitted rather than arriving
    -- as a null the function would have to second-guess.
    body := jsonb_strip_nulls(jsonb_build_object('start', p_start, 'end', p_end)),
    timeout_milliseconds := 240000
  ) into v_request_id;

  return v_request_id;
end;
$$;

-- A new SECURITY DEFINER function is granted to `public` by default, which
-- reaches `anon` through the REST schema. The same revoke `is_team_admin()`
-- needed.
revoke all on function public.trigger_ga4_sync(date, date) from public, anon;
grant execute on function public.trigger_ga4_sync(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Daily
-- ---------------------------------------------------------------------------
-- 10:17 UTC is 06:17 in Santo Domingo. GA4 keeps revising the last couple of
-- days as late hits are attributed, which is why the function re-reads two days
-- it already has rather than only asking for new ones; the upsert makes that
-- free. The minute is off the hour on purpose — every schedule written at :00
-- queues behind every other one.
--
-- cron.schedule replaces a job of the same name, so re-running this migration
-- does not leave two.
select cron.schedule(
  'ga4-sync-daily',
  '17 10 * * *',
  $cron$
  select net.http_post(
    url := 'https://jqnrohfidmszbcxwocmk.supabase.co/functions/v1/ga4-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-ga4-sync-token', (select decrypted_secret from vault.decrypted_secrets where name = 'ga4_sync_token')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 240000
  );
  $cron$
);
