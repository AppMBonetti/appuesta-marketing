-- APPLIED 2026-11-02. The real players flagged internal by a substring match.
--
-- internal_name_patterns was `test,prueba,demo,qa`, matched with
-- `like '%' || pattern || '%'` against username and email. Two of those four
-- patterns caught nothing real and three real players:
--
--   juliolorabaldemora@gmail.com   "demo" inside the surname Baldemora
--   moisesbaldemora07@gmail.com    same
--   juniordemota1@gmail.com        "demo" inside the surname Demota
--
-- plus five accounts whose random 10-character email prefix happens to contain
-- `qa` (rw8qagyj4n, qagk0y9s5o, c6kqa9gkrp, qamy6k2kqm, rch1nd7qau).
--
-- The obvious fix -- match on word boundaries -- is wrong here, and only
-- checking the data showed it. The house convention glues the pattern to a
-- name: `cuentatesting`, `josetest10`, `marcostest1008`, `mbtest6@gmail.com`,
-- `joseurenatesting@gmail.com`. A bounded match would have released all of
-- those, including DOP 5,000 and DOP 1,500 of genuine test deposits.
--
-- What actually separates the false positives is length, not boundaries: `demo`
-- and `qa` are short enough to collide with Dominican surnames and random
-- strings, `test` and `prueba` are not. And every `demo` match in the data is
-- either a surname or the DEMON01..DEMON31 ring, never a genuine demo account,
-- so the pattern becomes `demon` -- keeping the ring, dropping the surnames.
-- `qa` goes entirely: it flagged nothing but noise.
update public.app_settings
   set value = 'test,prueba,demon'
 where key = 'internal_name_patterns';

-- Checked before applying: exactly 8 accounts change, all released, none newly
-- flagged, every DEMON* account still flagged. Of the 8, three are real players
-- and five are disposable-email signups -- releasing those into the book would
-- have been a worse error than the one being fixed, so they are held out under
-- the reason that actually describes them. `excluded`, not `restricted`: these
-- were never customers.
update public.players
   set excluded = true,
       exclusion_reason = 'Correo desechable — registro fraudulento',
       excluded_at = coalesce(excluded_at, now())
 where id in ('100003924', '100003960', '100004233', '100004341', '100004751')
   and not excluded;

-- tanpony.com is where three of those five sit, and it was not on the list.
update public.app_settings
   set value = value || ',tanpony.com'
 where key = 'disposable_email_domains'
   and position('tanpony.com' in value) = 0;

select public.refresh_internal_flags();

-- ---------------------------------------------------------------------------
-- The disposable list becomes a rule -- approved by Marcos after seeing the cost
-- ---------------------------------------------------------------------------
--
-- `disposable_email_domains` was a note, not a rule. The 138 accounts marked
-- "Correo desechable — registro fraudulento" were excluded by a one-off sweep in
-- August and nothing applied the list afterwards, so adding a domain to
-- app_settings did nothing on its own. That is how tanpony.com reached 100
-- accounts unnoticed.
--
-- Applying it was written, tested in a rolled-back transaction, and then put to
-- Marcos rather than shipped, because of what the test showed. He approved it.
--
--   | book                      | 4,742 -> 4,071  (-671) |
--   | excluded                  |   145 ->   847  (+702) |
--   | October registrations     | 2,749 -> 2,128  (-621) |
--   | September registrations   |   847 ->   847  (none) |
--   | October FTDs              |   508 ->   507         |
--   | deposits, all time        | 20,621,176 -> 20,620,776 |
--
-- 707 accounts across seven domains still taking signups through 1 November,
-- holding **DOP 400 between all of them**. Growth for October against September
-- goes from +224% to **+151%** -- the honest figure. September had none of
-- them: the ring arrived in October, which is exactly why the month looked so
-- good.
--
-- The rule is one-directional on purpose:
--   * it only ever sets `excluded`, never clears it;
--   * it skips any row that already carries an exclusion_reason, so an
--     operator's decision through set_player_excluded() is never overwritten;
--   * it writes its own reason, so the two stay distinguishable.
--
-- `excluded`, not `restricted` -- the distinction the 2026-10-26 migration drew.
-- These were never customers; a restricted player is a customer whose money
-- still counts.
create or replace function public.refresh_internal_flags()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  ops_start      date;
  domains        text[];
  usernames      text[];
  patterns       text[];
  disposable     text[];
  flagged        integer;
begin
  select value::date into ops_start from app_settings where key = 'operations_start_date';
  select string_to_array(lower(value), ',') into domains    from app_settings where key = 'internal_email_domains';
  select string_to_array(lower(value), ',') into usernames  from app_settings where key = 'internal_usernames';
  select string_to_array(lower(value), ',') into patterns   from app_settings where key = 'internal_name_patterns';
  select string_to_array(lower(value), ',') into disposable from app_settings where key = 'disposable_email_domains';

  update players p
     set is_internal = rule.flag
    from (
      select id,
             (
               (ops_start is not null and registered_at < ops_start)
               or exists (
                 select 1 from unnest(coalesce(domains, '{}')) d
                  where d <> '' and lower(coalesce(email, '')) like '%@' || trim(d)
               )
               or exists (
                 select 1 from unnest(coalesce(usernames, '{}')) u
                  where u <> '' and lower(coalesce(username, '')) = trim(u)
               )
               -- Matched as a substring on purpose -- see the header.
               or exists (
                 select 1 from unnest(coalesce(patterns, '{}')) t
                  where t <> ''
                    and (lower(coalesce(username, '')) like '%' || trim(t) || '%'
                      or lower(coalesce(email, ''))    like '%' || trim(t) || '%')
               )
             ) as flag
        from players
    ) rule
   where p.id = rule.id
     and p.is_internal is distinct from rule.flag;

  get diagnostics flagged = row_count;

  update players p
     set excluded = true,
         exclusion_reason = 'Correo desechable — registro fraudulento',
         excluded_at = coalesce(p.excluded_at, now())
   where not p.excluded
     and p.exclusion_reason is null
     and p.email is not null
     and exists (
       select 1 from unnest(coalesce(disposable, '{}')) d
        where d <> '' and lower(p.email) like '%@' || trim(d)
     );

  return flagged;
end;
$function$;

revoke execute on function public.refresh_internal_flags() from anon, public;
grant execute on function public.refresh_internal_flags() to authenticated;

select public.refresh_internal_flags();
select public.assign_vip_tiers();

-- ---------------------------------------------------------------------------
-- And the tier table could silently drop a player
-- ---------------------------------------------------------------------------
--
-- vip_tier_summary joined `real_players p on p.vip_tier = t.tier_name`, so a
-- player whose vip_tier is null fell out of it entirely. That is every player
-- until assign_vip_tiers() next runs -- including the three released above,
-- which is how the tier table came to report 4,068 players and DOP 20,620,276
-- against the book's 4,071 and 20,620,776, DOP 500 of it one real player.
--
-- COALESCE to 'Prospecto', which is what player_tier_progress has always done.
-- After it: 4,071 in vip_tier_summary, lifecycle_summary and real_players
-- alike, and total_deposits ties to house_totals exactly.
create or replace view public.vip_tier_summary with (security_invoker = true) as
 with tiered as (
   select p.*, coalesce(p.vip_tier, 'Prospecto') as tier_key from real_players p
 )
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
     left join tiered p on p.tier_key = t.tier_name
     left join player_tickets k on k.id = p.id
  group by t.tier_name, t.tier_order, t.wager_required_dop, t.cashback_pct, t.promotion_bonus_dop;
