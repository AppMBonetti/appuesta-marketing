-- Rollback for 20261026_restricted_players_still_count.sql.
--
-- Puts the 15 banned/limited/self-excluded customers back into `excluded`,
-- which removes DOP 3.5M of real deposits and 3.6M of real withdrawals from
-- every figure again. Only do this if the decision is reversed.
update public.players
   set excluded         = true,
       exclusion_reason = restriction_reason,
       excluded_at      = coalesce(restricted_at, now()),
       restricted       = false,
       restriction_reason = null,
       restricted_at    = null
 where restricted;

drop function if exists public.set_player_restricted(text, boolean, text);

-- The columns are left in place: dropping them would need all three views
-- recreated first, and an unused boolean costs nothing.
