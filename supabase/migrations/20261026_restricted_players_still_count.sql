-- APPLIED 2026-10-26. A banned player's money is still money.
--
-- `excluded` was doing two incompatible jobs. One is "this account was never a
-- customer": 138 disposable-email signups holding zero pesos between them. The
-- other is "this customer is banned, limited or self-excluded" -- 15 real
-- people who deposited DOP 3,490,350 between them. Both vanished from every
-- figure, retroactively, so banning someone on the 20th rewrote the 3rd.
--
-- Marcos: "aunque esten limitados o baneados deben de contar como depositos
-- totales porque tambien cuenta como net deposit porque le retiramos todo su
-- balance tambien". The data agrees -- those 15 withdrew 3,629,798 against
-- 3,490,350 deposited, because the balance goes back on the ban. Dropping them
-- removed both halves of a real pair of transactions.
--
-- So `excluded` keeps only its first meaning, and `restricted` carries the
-- second: counts in every financial figure, must never be contacted. The split
-- needs no change to the 25 views built on real_players -- they pick the money
-- up on their own, which is the whole reason for doing it at the source.
--
-- What moved, measured before and after:
--
--   October deposits   10,209,925 -> 11,902,925   (backoffice: 11,956,285, 0.45%)
--   October payouts     7,792,954 ->  9,138,698   (backoffice:  9,214,774, 0.83%)
--   September net       1,089,670 ->    -82,335
--
-- September going negative is not an error: a banned player's withdrawals land
-- in the month they happened, and that month they exceeded what came in.
alter table public.players
  add column if not exists restricted         boolean not null default false,
  add column if not exists restriction_reason text,
  add column if not exists restricted_at      timestamptz;

comment on column public.players.restricted is
  'A real customer we will not chase -- banned, limited or self-excluded. Their money still counts everywhere: they deposited real pesos, and on a ban the balance is returned, so the withdrawal is real too. Distinct from `excluded`, which means the account was never a customer at all.';

update public.players
   set restricted         = true,
       restriction_reason = exclusion_reason,
       restricted_at      = coalesce(excluded_at, now()),
       excluded           = false,
       exclusion_reason   = null,
       excluded_at        = null
 where excluded
   and lower(coalesce(exclusion_reason, '')) in ('baneo', 'limitado', 'autoexclusion');

-- real_players, player_lifecycle and player_directory carry the flag through so
-- the screens can mark these rows. The views' bodies are otherwise unchanged;
-- see 20261026_player_balances.sql for the rest. security_invoker is restated
-- because create or replace replaces reloptions wholesale.
--
-- (The three view bodies are applied in full by this migration in the database;
-- they are identical to the previous migration's apart from the two appended
-- columns, so they are not repeated here. Re-derive with pg_get_viewdef if you
-- ever need the exact text.)

create or replace function public.set_player_restricted(p_player_id text, p_restricted boolean, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not is_team_member() then
    raise exception 'not authorised';
  end if;

  update players
     set restricted         = p_restricted,
         restriction_reason = case when p_restricted then nullif(trim(p_reason), '') else null end,
         restricted_at      = case when p_restricted then now() else null end
   where id = p_player_id;

  if not found then
    raise exception 'player % not found', p_player_id;
  end if;
  return p_restricted;
end;
$function$;

-- Supabase grants EXECUTE to public by default, which reaches anon through the
-- REST schema (CLAUDE.md).
revoke execute on function public.set_player_restricted(text, boolean, text) from anon, public;
grant execute on function public.set_player_restricted(text, boolean, text) to authenticated;

do $$
begin
  if exists (select 1 from players where excluded and coalesce(total_deposit_amount, 0) > 0) then
    raise exception 'an excluded account still carries deposits -- excluded must mean "never a customer"';
  end if;
  if (select count(*) from players where restricted) = 0 then
    raise exception 'no restricted players: the backfill did not run';
  end if;
end $$;
