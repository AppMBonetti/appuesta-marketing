-- OPTIONAL. Tidy-up only. Apply this after 20261019_rls_initplan.sql, or never.
--
-- Four tables carry a SELECT policy that duplicates an ALL policy on the same
-- table with an identical qual, identical roles and identical permissiveness,
-- so the team check is evaluated twice per row. Supabase's linter flags them as
-- multiple_permissive_policies.
--
-- Why this is split out, and why it is worth very little:
--
-- Before the initplan migration, the duplicate cost a second full per-row
-- function call -- genuinely expensive. After it, the check is an InitPlan
-- evaluated once per statement, so the duplicate costs approximately nothing.
-- The performance case for dropping these largely disappears once the first
-- migration lands.
--
-- Meanwhile this is the only part of the work that can actually remove
-- somebody's access. Dropping a SELECT policy is safe only if the remaining ALL
-- policy really does cover SELECT under the same condition. That was verified
-- by comparing pg_policies rows (qual, roles, permissive all identical), but
-- NOT by executing a read as a team member with the drops applied -- four
-- attempts to measure that were killed by the ACCESS EXCLUSIVE lock wait.
--
-- So: small reward, non-zero risk, unverified by execution. Skip it unless the
-- linter warning bothers you. If you do run it, check the dashboard still loads
-- Depósitos and Configuración immediately afterwards, and keep the rollback to
-- hand.
--
-- sport_aliases_team_read is deliberately absent: it is the ONLY policy on that
-- table, so dropping it would lock the team out of it entirely.

begin;

set local lock_timeout = '10s';

drop policy deposit_periods_team_read on public.deposit_periods;
drop policy payment_transactions_team_read on public.payment_transactions;
drop policy player_sport_profile_team_read on public.player_sport_profile;
drop policy "team can view team list" on public.team_members;

-- Each of the four tables must still have an ALL policy left standing, or the
-- team has just lost the table.
do $$
declare t text; n int;
begin
  foreach t in array array['deposit_periods','payment_transactions','player_sport_profile','team_members']
  loop
    select count(*) into n
    from pg_policies
    where schemaname = 'public' and tablename = t and cmd = 'ALL';

    if n < 1 then
      raise exception 'Table % has no ALL policy left -- the team would lose it', t;
    end if;
  end loop;
end $$;

commit;
