# Appuesta Marketing Dashboard — working notes

## Deploy

Netlify builds from this repo on every push. `netlify.toml` holds the build
config (`npm run build` → `dist`, Node 22, SPA fallback). Supabase credentials
live in Netlify's env vars (`VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`) — never commit them.

- Push to `main` → deploys to the live dashboard, ~1–2 min.
- Push to any other branch → Netlify deploy preview URL, no production impact.

## Where changes go

Small, self-contained, visually obvious changes go straight to `main`: copy and
translation strings, colors and spacing, chart options, icon swaps, adding a
column to an existing table.

Anything that can silently produce wrong numbers or lock someone out goes to a
branch with a preview URL first, for Marcos to approve:

- `src/lib/importers/` — column mappings, parsing, upsert logic
- auth, `team_members` gating, RLS assumptions (`src/lib/AuthContext.jsx`)
- metric definitions and period math (`src/lib/period.js`)
- anything calling `assign_vip_tiers()` or writing to Supabase
- dependency upgrades

When in doubt, preview first — a wrong number on a dashboard people trust is
worse than a slow change.

## Verify before pushing

`npm run build` and `npm run lint` both pass. The build has no test suite, so
the build and lint are the gate.

## Query performance — the `local_day()` trap

`local_day()` and `local_week()` are `IMMUTABLE` and have **America/Santo_Domingo
hardcoded**. They used to read the timezone from `app_settings` via `report_tz()`,
which made them uninlinable — PostgreSQL skips inlining for `SECURITY DEFINER`
functions and for any function carrying a `SET` clause. Every call then became a
real function invocation that queried a table, once per row, and because the
result is an expression over the column no index could serve the predicate.

That cost `weekly_kpis` 16.4s against an 8s `statement_timeout`, which is what
the "canceling statement due to statement timeout" errors were.

Consequences to remember:

- **Changing the reporting timezone needs a migration**, not an `app_settings`
  update. A guard in `local_day_immutable_and_indexed` fails the migration if the
  stored setting ever stops matching the literal, so the two cannot drift.
- There are expression indexes on `local_day(bet_date)`, `local_week(bet_date)`,
  `local_day(registered_at)` and `local_day(first_deposit_date)`. They only work
  while these functions stay `IMMUTABLE`.
- In new SQL, prefer a plain timestamp range over `local_day(col) between a and b`
  when filtering a large table — `kpis_for_range` converts the window to
  timestamptz once and compares raw columns, which is why it dropped 40x.
- Avoid a correlated `LATERAL` per player over `bets`. `player_bet_profile` used
  three and took 2.3s; aggregating once per player and joining made it 1ms.

Before pushing anything that touches these views, time it:
`explain (analyze, timing) select count(*) from (select * from <view>) x;`

Two traps in that measurement itself:

- **Measure as `authenticated`, not as yourself.** Your connection bypasses RLS;
  the dashboard does not. Wrap the measurement so it matches what the app does:
  ```sql
  begin;
  set local role authenticated;
  set local request.jwt.claims = '{"email":"<a team email>","role":"authenticated"}';
  explain (analyze, timing off) select count(*) from <view>;
  rollback;
  ```
- **`count(*)` lets the planner skip columns it does not need**, including whole
  CTEs. `player_lifecycle` measured 231 ms that way and 2,934 ms once the query
  named `top_sport`, because the sport-legs CTE showed `never executed`. Name
  the expensive columns: `select count(*), count(top_sport) from <view>`.

## RLS — the same inlining trap, one level down

`is_team_member()` is `STABLE SECURITY DEFINER` with a `SET` clause, so it has
the same problem `local_day()` had: PostgreSQL will not inline it. Written bare
in a policy qual it is evaluated **once per row**, and each call queries
`team_members`.

Every policy is therefore written as `using ((select public.is_team_member()))`.
The scalar subquery makes the planner hoist it into an `InitPlan`, evaluated
once per statement. Measured as `authenticated`:

| | before | after |
|---|---|---|
| `weekly_kpis` | 5,340 ms | 1,943–3,053 ms |
| `player_lifecycle` | 2,934 ms | 641 ms |

RLS also distorts plan *shape*, not just per-row cost: the `bets` scan was a
Nested Loop of 3,470 iterations and went back to a Hash Join once the qual
stopped being opaque.

- **Keep the `(select ...)` wrapper on every new policy.** Supabase's linter does
  not catch a bare call through a wrapper function like this one, so nothing
  will warn you.
- Hoisting is only safe because `is_team_member()` takes no arguments and reads
  only the JWT, so its value cannot vary between rows. A policy that depends on
  the row (`is_owner(t.user_id)`) must **not** be wrapped this way.
- `ALTER POLICY` takes `ACCESS EXCLUSIVE`, and new queries queue behind it while
  it waits. Set `lock_timeout` and run it when the dashboard is idle — four
  attempts were killed by this lock wait. Apply in small batches if needed; a
  partial state is safe, since both forms grant identical access.
- A deploy preview **cannot** test an RLS change: preview and production share
  one database. Test with `begin … rollback` instead.

`supabase/migrations/` holds the migration and its rollback.

## Recency is measured against the data, not the clock

Reports land weekly. A day counter written as `CURRENT_DATE - last_deposit_date`
therefore grows every day while the data stands still, and since the lifecycle
stage is a set of thresholds on it (8 → Cooling, 15 → At risk, 30 → Churned),
the whole funnel decays on its own between imports and snaps back on import
day. Measured on 2026-10-21 against data through 2026-10-18 — three days, no
new information:

| | today | at the cut-off |
|---|---|---|
| Active | 180 | 212 |
| At risk | 108 | 79 |

Forty-two players had slid down a stage because the calendar moved. The deeper
fault is that `CURRENT_DATE` cannot tell "has not deposited" from "we have not
imported it yet", and quietly assumes the worse of the two.

So day counters anchor to the `data_through` view — one row holding the last
day every player-recency source covers — and `player_lifecycle`,
`player_tier_progress` and `player_directory` cross join it. The VIP tier
window does too: it was `now() - 90 days`, which shrank each VIP's cushion
above their tier floor daily on unchanged data.

- **`data_through` is a view, not a function.** A STABLE function with
  `SECURITY DEFINER` or a `SET` clause cannot be inlined and would run per row —
  the trap above, twice over. As a view it is rewritten into the query and its
  aggregates become InitPlans. Confirmed in the plan; `player_lifecycle` went
  641 ms → 658 ms.
- **New recency columns must use the anchor**, not `CURRENT_DATE`. Nothing warns
  you: the old form looks right and is wrong only between imports.
- **Anchoring a *window* is not a find-and-replace.** `player_tier_progress`
  computed the trailing wager with a correlated subquery per player and
  `bet_date >= now() - '90 days'`. Swapping that constant for bounds arriving
  from a join took the view to **10,321 ms** against the 8s timeout and broke
  the VIP page in production: the planner can fold a constant into
  `bets(bet_date)`, but not a joined value, so it re-scanned the whole index —
  3,467 correlated executions, twice over, since `trailing_wager` appears more
  than once in the select list. One grouped pass over the window joined to the
  players gives the same figures in **378 ms**. Any predicate that stops being
  a constant needs re-timing, not just re-reading.
- The anchor is the *earliest* of the three sources, so a lagging source makes
  the dashboard conservative rather than inventing coverage.
- Screens that show stage counts show the cut-off date beside them
  (`s.dataThrough`), so a figure that has not moved since Monday reads as
  correct rather than stale.
- **Still on `CURRENT_DATE`, deliberately:** `cohort_retention_by_tier`,
  `cohort_deposit_detail`, `cohort_month_detail`,
  `cohort_deposit_retention_period` (cohort maturity, not player recency — the
  question is whether a window has elapsed), and `stale_open_bets`,
  `bet_coverage`, `account_watchlist` (operational chase lists, where
  overstating staleness is the safe direction). Revisit the cohort ones if
  retention starts drifting between imports the same way.

Once reports arrive daily the anchor sits a day behind today and these numbers
converge on what the old form gave; nothing needs undoing.

## Hand-typed data is the one kind we cannot re-import

Everything else in this database comes from a weekly report and can be rebuilt
by importing it again. `player_notes` cannot: what the VIP advisor wrote about a
player exists nowhere else. That changes the defaults.

- **No foreign key to `players(id)`.** `on delete cascade` would mean a re-import
  that drops a player row silently deletes notes nobody can get back, and adding
  the constraint takes a lock on `players`, which the dashboard reads constantly
  — the first attempt at the migration timed out waiting for it. An orphaned
  note is a much smaller problem than a deleted one.
- **The byline is stamped by a trigger from `auth.jwt()`, not sent by the
  client.** A log is only worth reading if "Marcos wrote this" is a fact. The
  trigger also holds `created_by` and `created_at` steady on update.
- **Write policies are split.** `select`/`insert` for any team member;
  `update`/`delete` only for the row's author or an admin (`is_team_admin()`,
  which mirrors `is_team_member()` and therefore needs the same `(select ...)`
  wrapper). Once the advisor has a login, the team is no longer two admins who
  trust each other with everything.
- **New SECURITY DEFINER functions are granted to `public` by default**, which
  reaches `anon` through the REST schema. `is_team_member()` does not carry that
  grant; `is_team_admin()` had to have it revoked. The Supabase linter catches
  this one — run `get_advisors` after adding a function.
- `coalesce` and `nullif` are grammar, not catalog functions. Under
  `set search_path = ''` they still resolve bare; writing `pg_catalog.nullif(...)`
  fails at runtime, not at creation, so only an actual insert finds it.
- A note's age is measured against **`CURRENT_DATE`**, unlike every player
  recency counter. Someone typed it at a real moment; the calendar moving is
  news here.
