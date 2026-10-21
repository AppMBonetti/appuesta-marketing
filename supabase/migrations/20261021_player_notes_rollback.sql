-- Rollback for 20261021_player_notes.sql.
--
-- This drops the notes themselves, which are typed by hand and exist nowhere
-- else. Export them first if any have been written:
--   copy (select * from public.player_notes) to stdout with csv header;
drop trigger if exists player_notes_stamp on public.player_notes;
drop table if exists public.player_notes;
drop function if exists public.player_notes_stamp();

-- is_team_admin() is left in place: it is a read-only helper that nothing else
-- depends on, and dropping it would break any policy added against it later.
-- Drop it by hand if the rollback is meant to be total:
--   drop function if exists public.is_team_admin();
