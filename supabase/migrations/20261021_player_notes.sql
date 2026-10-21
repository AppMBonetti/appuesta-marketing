-- APPLIED 2026-10-21. A new, empty table that nothing existing reads or writes,
-- so it could go in ahead of the UI without changing a figure anywhere. Checked
-- afterwards as the `authenticated` role with real JWTs, each inside
-- begin/rollback:
--
--   * a forged created_by and created_at on insert were both overwritten by the
--     trigger with the caller's own email and now();
--   * a non-admin team member read every note but could neither update nor
--     delete a note written by someone else (0 rows affected on both);
--   * an admin deleted that member's note (1 row);
--   * an authenticated user who is not on the team saw 0 rows;
--   * a blank body, an unknown kind and an unknown channel were each rejected.
--
-- A log of notes and contacts per player.
--
-- Two needs, one table. Marcos wanted somewhere to record that djpeti
-- self-excluded after a problem -- a standing fact no backoffice column
-- carries, and without which he reads on the VIP page as an MVP worth ringing.
-- The VIP advisor needs the other half: one entry every time he writes to a
-- player and one for the answer, kept in order.
--
-- So: many rows per player, each dated and typed, and a `pinned` flag for the
-- few that must be visible without opening the player. A single editable note
-- per player would have served the first need and lost the second -- the second
-- message arrived before this was applied, which is the only reason it is one
-- table instead of two.
--
-- Deliberately NOT a foreign key to players(id). Two reasons: adding one takes
-- a lock on players, which the dashboard reads constantly (the first attempt at
-- this migration timed out waiting for it), and `on delete cascade` would mean
-- a re-import that removes a player row silently deletes notes that were typed
-- by hand and exist nowhere else. An orphaned note is a far smaller problem
-- than a deleted one.
create table if not exists public.player_notes (
  id          bigint generated always as identity primary key,
  player_id   text not null,

  -- What the entry is. 'outreach' and 'reply' are the two halves of a
  -- conversation; 'no_reply' records the silence, which is itself the signal
  -- that matters after two attempts.
  kind        text not null default 'note'
              constraint player_notes_kind check (kind in ('note', 'outreach', 'reply', 'no_reply')),

  -- Null for a plain note. Over time this is the answer to "what actually
  -- reaches this player", which the reports cannot tell us.
  channel     text
              constraint player_notes_channel
              check (channel is null or channel in ('whatsapp', 'email', 'phone', 'telegram', 'in_person', 'other')),

  body        text not null constraint player_notes_body_not_blank check (btrim(body) <> ''),

  -- Shown on the player's row in the list, not only inside the detail panel.
  -- For facts that change whether you contact someone at all.
  pinned      boolean not null default false,

  -- When it happened, which is not when it was typed: the advisor may be
  -- catching up on Friday for a call he made on Tuesday.
  happened_on date not null default current_date,

  created_at  timestamptz not null default now(),
  created_by  text,
  updated_at  timestamptz not null default now()
);

create index if not exists player_notes_player_idx
  on public.player_notes (player_id, happened_on desc, id desc);

-- Pinned entries are read for every player on screen at once, so they get their
-- own small partial index rather than riding the one above.
create index if not exists player_notes_pinned_idx
  on public.player_notes (player_id) where pinned;

comment on table public.player_notes is
  'Dated log of notes, outreach and replies per player. created_at/created_by/updated_at are stamped by a trigger from the request JWT; the client cannot set or change them.';
comment on column public.player_notes.pinned is
  'Surfaced on the player row rather than only in the detail panel -- for standing facts such as a self-exclusion.';
comment on column public.player_notes.happened_on is
  'When the contact happened, which may be earlier than when it was typed.';

-- plpgsql, so it is never a candidate for inlining and the SET clause costs
-- nothing here (CLAUDE.md on local_day() and is_team_member()). search_path is
-- empty and every name is qualified.
create or replace function public.player_notes_stamp()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := pg_catalog.now();
    -- auth.jwt() reads the request's own token, so it is the one value the
    -- browser cannot choose. Falls back to what was supplied when there is no
    -- JWT, which is a write from the SQL console rather than the dashboard.
    -- coalesce and nullif are grammar, not catalog functions, so they cannot be
    -- schema-qualified and need no path. Qualifying them fails at runtime with
    -- "function pg_catalog.nullif(text, unknown) does not exist".
    new.created_by := coalesce(nullif(auth.jwt() ->> 'email', ''), new.created_by);
  else
    -- The byline is not editable. A log is only worth reading if who wrote an
    -- entry is who the stamp says wrote it.
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end $$;

drop trigger if exists player_notes_stamp on public.player_notes;
create trigger player_notes_stamp
  before insert or update on public.player_notes
  for each row execute function public.player_notes_stamp();

-- Mirrors is_team_member() exactly, including the SECURITY DEFINER and the SET
-- clause, so the same rule applies: always call it through (select ...).
create or replace function public.is_team_admin()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from team_members
    where email = auth.jwt() ->> 'email' and role = 'admin'
  );
$$;

-- Supabase grants EXECUTE to public by default, which reaches anon through the
-- REST schema. is_team_member() does not carry that grant and neither should
-- this one; the linter flagged it the moment it was created.
revoke execute on function public.is_team_admin() from anon, public;
grant execute on function public.is_team_admin() to authenticated;

alter table public.player_notes enable row level security;

-- Four policies rather than one ALL policy, because reading and writing differ
-- here: the whole team reads every note, but an entry belongs to whoever wrote
-- it. The advisor should not be able to rewrite Marcos's note about a player,
-- or quietly delete his own after the fact without an admin being able to.
--
-- (select ...) around is_team_member() and is_team_admin() for the usual
-- InitPlan reason. created_by is compared to a scalar subquery over auth.jwt()
-- for the same reason: the value cannot vary between rows, only the column can.
drop policy if exists player_notes_read on public.player_notes;
create policy player_notes_read on public.player_notes
  for select to authenticated
  using ((select public.is_team_member()));

drop policy if exists player_notes_insert on public.player_notes;
create policy player_notes_insert on public.player_notes
  for insert to authenticated
  with check ((select public.is_team_member()));

drop policy if exists player_notes_update on public.player_notes;
create policy player_notes_update on public.player_notes
  for update to authenticated
  using (
    (select public.is_team_member())
    and (created_by = (select auth.jwt() ->> 'email') or (select public.is_team_admin()))
  )
  with check ((select public.is_team_member()));

drop policy if exists player_notes_delete on public.player_notes;
create policy player_notes_delete on public.player_notes
  for delete to authenticated
  using (
    (select public.is_team_member())
    and (created_by = (select auth.jwt() ->> 'email') or (select public.is_team_admin()))
  );

-- RLS already blocks anon, but the grant is the outer door and a signed-out
-- client has no reason to hold one.
revoke all on public.player_notes from anon;
grant select, insert, update, delete on public.player_notes to authenticated;

do $$
declare
  bare integer;
begin
  select count(*) into bare
  from pg_policies
  where schemaname = 'public' and tablename = 'player_notes'
    and (coalesce(qual, '') like '%is_team_member()%' and coalesce(qual, '') not like '%( SELECT is_team_member%');
  if bare > 0 then
    raise exception 'player_notes has % policy(ies) calling is_team_member() unwrapped', bare;
  end if;

  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'player_notes') <> 4 then
    raise exception 'expected 4 policies on player_notes';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.player_notes'::regclass) then
    raise exception 'row level security is off on player_notes';
  end if;
end $$;
