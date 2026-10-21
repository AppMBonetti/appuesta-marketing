-- APPLIED 2026-10-21. Additive: nothing existing reads it, so it could be
-- applied and then timed without risk. 1,240 ms as `authenticated` for the 137
-- rows the VIP page asks for (23 players and their sports).
--
-- Per player, per sport: which sports someone actually bets on, for the detail
-- panel behind each VIP row. player_lifecycle already carries top_sport and a
-- share, but not the rest of the mix.
--
-- Two things that look wrong and are not:
--
-- The `sport` column holds one line per leg of a bet, newline separated, so a
-- parlay reads as "Soccer\nSoccer\nBasketball". It is split on E'\n' and a bet
-- counts once per distinct sport it touches.
--
-- The share therefore divides by the player's own bet count, not by the sum
-- across sports, and so can add past 100% for someone who bets multi-sport
-- parlays. That is deliberate: it is the definition top_sport_share already
-- uses, and the two must agree. Dividing by the sum instead read Tomas36's
-- Basketball at 41% here against 57% in Segments -- the first version of this
-- view did exactly that, and the cross-check caught it.
create or replace view player_sport_mix with (security_invoker = true) as
select s.player_key as id, s.sport, s.bets, s.stake,
       round(100.0 * s.bets / nullif(t.total_bets, 0), 1) as share_pct
from (
  select b.player_key,
         coalesce(a.canonical, nullif(btrim(leg.leg), '')) as sport,
         count(distinct b.bet_id) as bets,
         sum(coalesce(b.stake, 0) + coalesce(b.bonus_stake, 0)) as stake
  from bets b
  cross join lateral unnest(string_to_array(b.sport, E'\n')) as leg(leg)
  left join sport_aliases a on a.alias = lower(btrim(leg.leg))
  where b.player_key is not null
    and bet_counts_as_wagering(b.status)
    and coalesce(a.canonical, nullif(btrim(leg.leg), '')) is not null
  group by 1, 2
) s
join (
  select player_key, count(distinct bet_id) as total_bets
  from bets where player_key is not null and bet_counts_as_wagering(status)
  group by 1
) t on t.player_key = s.player_key;

comment on view player_sport_mix is
  'One row per player per sport. Share divides by the player''s own bet count, so a multi-sport parlay counts in each sport and shares sum past 100% by design -- matching the top_sport share shown elsewhere.';

do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'player_sport_mix'
      and array_to_string(c.reloptions, ',') like '%security_invoker=true%'
  ) then
    raise exception 'security_invoker missing on player_sport_mix';
  end if;
end $$;
