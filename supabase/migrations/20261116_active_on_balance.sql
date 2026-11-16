-- A player betting their own money is active, whatever the deposit says.
--
-- The stage was a threshold on days since the last deposit and nothing else, so
-- somebody who deposited 40 days ago, still holds cash, and placed a bet on
-- Tuesday read as Churned. That is the opposite of true: they are playing. The
-- deposit counter was measuring the wrong thing for them -- it says when money
-- last came in, not whether the player is still here.
--
-- So: deposited 8+ days ago, bet within 3 days, and holding cash of their own
-- -> Active. Measured on the book of 5,460 before shipping, at three thresholds:
--
--   bet within   players moved   from Cooling / At risk / Churned   their cash
--   3 days            38               17 / 12 / 9                   349,249
--   5 days            43               20 / 13 / 10                  354,124
--   7 days            52               24 / 15 / 13                  358,216
--
-- 3 days, as asked. The curve is flat enough that the choice is not delicate;
-- changing it is one literal in active_on_balance().
--
-- **Cash, not bonus.** `cash_balance` and `bonus_balance` are separate columns
-- and only the first counts. A balance that is all promotional bonus is not the
-- player's money and says nothing about whether they will come back; 82 players
-- hold bonus and 610 hold cash, so the distinction is not hypothetical.

-- The override, as its own IMMUTABLE function, so the stage and the flag that
-- explains it on screen cannot disagree -- they are the same expression.
-- BEGIN ATOMIC and no SET clause, both so it stays inlinable: it touches no
-- table and no schema-qualified object, so a search path could redirect nothing.
create or replace function public.active_on_balance(
  days_since_deposit integer,
  days_since_bet     integer,
  cash_balance       numeric
) returns boolean
language sql immutable parallel safe
begin atomic
  select days_since_deposit is not null
     and days_since_deposit >= 8
     and days_since_bet is not null
     and days_since_bet <= 3
     and coalesce(cash_balance, 0) > 0;
end;

create or replace function public.lifecycle_stage(
  deposit_count      integer,
  days_since_deposit integer,
  bets               bigint,
  days_since_bet     integer,
  cash_balance       numeric
) returns text
language sql immutable parallel safe
begin atomic
  select case
    when deposit_count is null or deposit_count = 0
      or days_since_deposit is null              then 'Registered'
    -- Before the recency thresholds, and deliberately after Registered: a
    -- player who never funded an account is not Active on a balance they do
    -- not have.
    when active_on_balance(days_since_deposit, days_since_bet, cash_balance)
                                                 then 'Active'
    when days_since_deposit >= 30                then 'Churned'
    when days_since_deposit >= 15                then 'At risk'
    when days_since_deposit >= 8                 then 'Cooling'
    when deposit_count = 1
     and coalesce(bets, 0) < 5                   then 'New'
    when deposit_count >= 2 or coalesce(bets, 0) >= 5 then 'Active'
    else 'Casual'
  end;
end;

-- The three-argument form stays, as history's form. `reconstruct_player_stages()`
-- rebuilds past weeks from deposit_periods and bets, and balances are a
-- point-in-time snapshot -- nothing anywhere records what somebody held on 4
-- October. Passing nulls turns the override off, which is the honest answer for
-- a week whose balances are unknowable, and keeps every reconstructed row on
-- exactly the rule it was reconstructed under.
create or replace function public.lifecycle_stage(
  deposit_count integer, days_since_deposit integer, bets bigint
) returns text
language sql immutable parallel safe
begin atomic
  select lifecycle_stage(deposit_count, days_since_deposit, bets, null::integer, null::numeric);
end;

-- Both views are patched from their own current definitions rather than
-- retyped. Nine thousand characters of view body copied by hand is a drift
-- waiting to happen, and the two stages agreeing is the property this
-- arrangement exists to protect. Each replacement is guarded: a whitespace
-- mismatch raises instead of silently changing nothing.
do $mig$
declare
  d text;
  before_txt text;
begin
  -- player_lifecycle: has days_since_bet and cash_balance in `scored` already.
  d := pg_get_viewdef('public.player_lifecycle'::regclass, true);

  before_txt := d;
  d := replace(d,
    'lifecycle_stage(deposit_count, days_since_deposit, bets) AS lifecycle',
    'lifecycle_stage(deposit_count, days_since_deposit, bets, days_since_bet, cash_balance) AS lifecycle');
  if d = before_txt then
    raise exception 'player_lifecycle: the lifecycle_stage call was not found';
  end if;

  before_txt := d;
  d := replace(d,
    E'    restriction_reason\n   FROM scored;',
    E'    restriction_reason,\n    active_on_balance(days_since_deposit, days_since_bet, cash_balance) AS active_on_balance\n   FROM scored;');
  if d = before_txt then
    raise exception 'player_lifecycle: the select tail was not found';
  end if;

  execute 'create or replace view public.player_lifecycle with (security_invoker = true) as ' || d;

  -- player_tier_progress: last_bet_date comes from player_bet_profile, cash
  -- balance straight off real_players.
  d := pg_get_viewdef('public.player_tier_progress'::regclass, true);

  before_txt := d;
  d := replace(d,
    'COALESCE(bp.bets, 0::bigint)) AS lifecycle',
    E'COALESCE(bp.bets, 0::bigint),\n        CASE\n            WHEN bp.last_bet_date IS NULL THEN NULL::integer\n            ELSE win.d - local_day(bp.last_bet_date)\n        END, p.cash_balance) AS lifecycle');
  if d = before_txt then
    raise exception 'player_tier_progress: the lifecycle_stage call was not found';
  end if;

  before_txt := d;
  d := replace(d,
    E'    p.restriction_reason\n   FROM real_players p',
    E'    p.restriction_reason,\n    active_on_balance(\n        CASE\n            WHEN p.last_deposit_date IS NULL THEN NULL::integer\n            ELSE win.d - local_day(p.last_deposit_date)\n        END,\n        CASE\n            WHEN bp.last_bet_date IS NULL THEN NULL::integer\n            ELSE win.d - local_day(bp.last_bet_date)\n        END, p.cash_balance) AS active_on_balance\n   FROM real_players p');
  if d = before_txt then
    raise exception 'player_tier_progress: the select tail was not found';
  end if;

  execute 'create or replace view public.player_tier_progress with (security_invoker = true) as ' || d;
end
$mig$;

-- Verified after applying, as `authenticated`:
--
--   * The two views still agree on the stage for all 5,460 players, zero
--     differences. That property is the reason the rule lives in one function
--     and both views call it rather than each carrying its own CASE.
--   * Active 382 -> 420. The 38 are flagged `active_on_balance`, so the screens
--     can say why somebody with no recent deposit is Active instead of leaving
--     it looking like a bug. No other stage gained anybody: Cooling 121 -> 104,
--     At risk 182 -> 170, Churned 235 -> 226, and the book still totals 5,460.
--   * player_lifecycle, the query Segments actually sends (select *, ordered by
--     deposits, limit 1000): 127 ms.
--
-- One consequence to expect rather than be surprised by: the next player-report
-- import captures these 38 under the new rule, and `player_stage_moves` will
-- report them as Cooling/At risk/Churned -> Active. Those are a definition
-- change, not players who came back. Reconstructed weeks keep the old rule --
-- the three-argument lifecycle_stage() above -- because no balance history
-- exists to apply the new one with.
