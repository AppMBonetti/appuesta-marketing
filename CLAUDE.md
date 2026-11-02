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

## The sport legs are a cache now, not a computation

`player_bet_profile` unnested the sport string of every bet on every read —
`cross join lateral unnest(string_to_array(b.sport, chr(10)))`. 42,593 wagering
bets expand to ~87,000 legs and then two HashAggregates, and the plan showed
42,593 Memoize loops over that Function Scan. Measured as `authenticated`, one
page of Segments (1,000 players ordered by deposits):

| | |
|---|---|
| naming no sport column | 13 ms — the CTE reads `never executed` |
| naming `top_sport` | **4,627 ms** |
| after the cache | **337 ms** |

Segments pages through the whole list, so that was five pages, ~23 s in all,
against an 8 s `statement_timeout`. It had been fine at 33,522 bets; the week of
19–25 October took the table past where the shape could carry it.

- `player_sport_counts` holds distinct bets per player per sport, rebuilt by
  `refresh_player_sport_counts()` at the end of the Altenar import, beside
  `refresh_player_ggr()`. **Nothing else keeps it current** — if a future import
  path writes `bets` without calling it, `top_sport` goes quietly stale.
- **A real table, not a materialized view.** A matview has no RLS, and anything
  readable by `authenticated` is readable by the affiliate portal's users too.
  This stays behind `is_team_member()` like everything else.
- Checked against the view it replaced *before* switching: across all 4,403
  players, `top_sport`, `sports_played` and `top_sport_share` matched with zero
  differences.
- The `count(*)` trap bit twice here. The first measurement after the fix read
  173 ms because `count(*)` let the planner skip the sport joins entirely; the
  honest figure, with every sport column named, is 337 ms.

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

## The payments report's period is its *Created date* filter

`deposit_periods` is keyed by the range on the report's `Properties` sheet
("Date range"), and that line reflects only the backoffice's **Created date**
filter. A Completed date filter appears nowhere in the file — not in the header,
not in the rows, which are one aggregate per player with no dates at all.

So a report pulled with Created date = the whole month and Completed date = one
week arrives claiming to cover the month. It overlaps the weeks already loaded,
is parked as `validation`, and the week it actually holds stays empty. That is
exactly what happened on 2026-10-26.

- **Every week loaded so far is on the created-date basis.** Switching to
  completed-date is defensible — a deposit created on the 18th and completed on
  the 20th is money that arrived on the 20th — but it cannot be done for one
  week only, or week-on-week comparisons mix two definitions. It needs every
  week re-pulled, and a way to declare the range on upload, since the file
  cannot state it.
- A `validation` period counts toward nothing, so it must never block the next
  upload. It used to: the overlap check looked at every stored period, so one
  month-wide file locked out every week it touched, each correct weekly file
  being demoted in turn. The check now considers `scope = 'primary'` only.
- **A month-straddling week has to be split**, or its days outside the month are
  attributed to nothing: 28/09–04/10 put four days of October into neither
  month. Upload the two halves (28/09–30/09 and 01/10–04/10); both land as
  validation, and `reconcile_deposit_period_scopes()` then sees they tile the
  straddling week exactly, demotes it and promotes both halves.
- **`deposits_weekly` reports a week when its primary periods cover all seven
  days**, not when one period runs Monday to Sunday. The exact-week form made
  splitting a week erase it from the weekly grid. The split week of 2026-09-28
  reassembles from 3 days plus 4 to exactly what the single period gave: 449
  deposits, DOP 1,183,680, 199 depositors.
- `depositors` there counts **distinct** players. One row per player per period
  made `count(*)` distinct by accident; across two periods it double-counts
  anyone who deposited in both halves.

## A month still running is compared against the same days, not a whole month

The current month runs to the 31st on the calendar and to the 25th in the
database, because the reports land weekly. The Overview asked `kpis_for_range`
for the whole month and compared it against a whole previous month — 25 days of
numerator over 30 days of denominator — so every growth figure came out short.

| October 1–25 vs | registrations | FTDs |
|---|---|---|
| all of September (what it showed) | +165% | +196% |
| September 1–25 (like for like) | **+254%** | **+408%** |

Nothing looked wrong: both figures were real, the arithmetic was right, and
only the windows disagreed. Marcos caught it from memory — "we had ~900 reg in
sept, october is not 165%".

- `clampToCoverage()` trims the range at `data_through`, `matchPriorLength()`
  cuts the prior span to the same number of days **from its own start** — month
  to date against the same days of the month before.
- It corrects in both directions. GGR went **down**, +383% → +296%, because
  26–30 September had negative GGR, so the full month was worth less than its
  first 25 days.
- The label names the span it compares against (`vs. 1 sep – 25 sep 2026`)
  rather than saying "the previous N days", which is unreadable once the window
  is not a whole month.
- `scripts/verify-period-compare.mjs` guards it in the build. Confirmed it
  fails: removing the clamp breaks four of its nine cases. A finished month must
  stay untouched, or every historical comparison shifts.

## A banned player's money is still money

`excluded` was doing two incompatible jobs: "this account was never a customer"
(138 disposable-email signups holding zero pesos) and "this customer is banned,
limited or self-excluded" (15 real people, DOP 3,490,350 deposited). Both
vanished from every figure retroactively, so a ban on the 20th rewrote the 3rd.

They are now separate. `excluded` keeps only the first meaning. `restricted`
carries the second: **counts in every financial figure, must never be
contacted.**

- The 15 withdrew 3,629,798 against 3,490,350 deposited, because the balance is
  returned on the ban. Dropping them removed both halves of a real pair of
  transactions, not just the deposit.
- Doing it at the source means the ~25 views built on `real_players` pick the
  money up on their own. Forking the view graph into "financial" and
  "retention" copies would have touched 29 objects.
- **Restricted players are back in every player list**, so the screens must mark
  them — Segments and the VIP tracker show a red *Restringido* badge with the
  reason on hover. Without that, someone calls a banned player.
- `set_player_restricted()` mirrors `set_player_excluded()`, including the
  EXECUTE revoke from `anon`.
- Measured before and after: October deposits 10,209,925 → **11,902,925**
  against the backoffice's 11,956,285 (0.45%); payouts 7,792,954 → **9,138,698**
  against 9,214,774 (0.83%). **September net went 1,089,670 → −82,335** — not an
  error: a banned player's withdrawals land in the month they happened, and that
  month they exceeded what came in.
- Still unresolved: `internal_name_patterns` matches `test,prueba,demo,qa` as a
  **substring**, so `juliolorabaldemora@gmail.com` and `juniordemota1@gmail.com`
  are flagged internal by the Dominican surnames Baldemora and Demota, and four
  accounts whose random email prefix contains `qa`. Seven real players, trivial
  money, not yet fixed.

## Balances say what a player holds, not what they were worth

The player report gained `Cash Balance`, `Bonus Balance`, `Total Balance` and
`Wallet Last Updated UTC` in the week of 2026-10-19. Every other figure on this
dashboard is cumulative — what someone has deposited, wagered, lost. These are
the only ones that say what is in the account right now, which is what decides
how hard to chase a player who has gone quiet.

- **`wallet_updated_at` is per player, not the report's timestamp.** Values in
  the first file ran from 2025-12-05 to the morning it was generated. It is when
  that wallet last moved, so it can be months older than the import and is a
  recency signal of its own. `days_since_wallet` anchors to `data_through` like
  every other day counter here.
- **The bonus share is not the player's money.** Several of the largest balances
  are mostly a 50,000 promotional bonus, so the screens show the split rather
  than one number — a balance that is all bonus means something quite different
  from one that is all cash.
- **`total_balance` is stored as given, not derived.** Cash + bonus equalled
  total in all 4,403 rows of the first file. The importer counts disagreements
  and the import screen shows them, so a change in what the export means by
  "Total" surfaces instead of being recomputed away.
- The columns flow `players → real_players → player_lifecycle / player_directory`.
  `real_players` lists its columns one by one, so a new column on `players` does
  **not** reach the screens on its own.
- **A balance column that is still empty makes a timing meaningless.** Measuring
  `player_directory` before any file was imported gave 4.6 ms, because every
  `wallet_updated_at` was null, so the `CASE` never reached `dt.d` and the
  `data_through` aggregates read `never executed` — the `count(*)` trap again,
  in a new disguise. Re-timed with real balances loaded: **18.3 ms**, with those
  aggregates actually executing.
- **New columns only arrive if the import ran on code that knows about them.**
  The 2026-10-19 report was uploaded four minutes before the deploy that added
  the balance mapping, so all 4,403 players came in with the four columns null
  and nothing looked wrong — the import reported success. After re-uploading the
  same file: 580 holders, DOP 1,157,145, matching the workbook exactly.

## Claude Code settings are committed, because the container is not

`.claude/settings.json` sets `permissions.defaultMode` to `bypassPermissions`, so
a session acts without stopping to ask. It is **checked in on purpose**.

The same setting was first written to `.claude/settings.local.json`, which
`.gitignore` excludes. That works on a laptop and not here: a cloud session runs
in a fresh container that clones the repo from GitHub, so anything not committed
does not exist when the session starts. The whole `.claude/` directory was simply
gone at the next session, and the prompts came back.

- It only takes effect for a session whose **checkout already contains it**.
  Settings are read at startup, so adding or changing the file mid-session does
  nothing until the next one — and it has to be on the branch that session starts
  from, which is usually `main`.
- It applies to **anyone** who opens this repo in Claude Code, not just Marcos.
- `.claude/settings.local.json` stays gitignored, for per-person overrides. It
  loads after this file and wins, so that is where to put a narrower mode for
  yourself without changing it for everybody.

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

## `count(*)` hides the work a page actually does — the third disguise

The sport-legs cache was signed off at **337 ms a page** and Segments was still
timing out. That figure was measured with `count()`, and `count()` never builds
the output rows. What Segments really runs is

```sql
select * from player_lifecycle order by deposits desc, id asc limit 1000;
```

which measured **3,190 ms**, five pages of it, ~16 s against the 8 s
`statement_timeout`. Naming the expensive columns is not enough once a page
fetches rows rather than counting them: **measure the query the page sends.**

Two causes, both the inlining trap one more level down:

- **`data_through` was re-planned once per textual reference.** The plan carried
  21 separate InitPlan groups, each aggregating `players`. The note above says
  its aggregates "become InitPlans" — true, but one set per mention of `dt.d`,
  and `player_lifecycle` mentions it in a dozen `CASE` arms. Putting the anchor
  in a `MATERIALIZED` CTE collapsed them to one: **3,190 → 2,015 ms**.
- **`min_qualifying_deposit()` is `STABLE` with a `SET` clause**, so it is not
  inlinable and ran **once per row** — 4,159 calls, each querying `app_settings`.
  Hoisted into the same anchor CTE as a column: **2,015 → 91 ms**.

That second one was nearly invisible in the plan. The `Nested Loop` building
`scored` read 876 ms while its children totalled 60 ms; the missing 816 ms was
the projection, which `EXPLAIN` attributes to no node of its own. **A parent
node far slower than the sum of its children means a per-row expression, not a
join.**

- Six views still call `min_qualifying_deposit()` per row — the four cohort
  views, `cohort_deposit_retention_period` and `dashboard_health`. None is on a
  page anyone has reported slow. Fix them when one is, not before.
- `player_bet_profile` also re-aggregated all 42,593 wagering bets on every
  read, `percentile_cont` and all. Same situation the sport legs were in, same
  answer: `player_bet_stats`, rebuilt by `refresh_player_bet_stats()` at the end
  of the Altenar import beside `refresh_player_sport_counts()`. **Nothing else
  keeps it current.** Checked against the live aggregate across all 2,210
  betting players: all eight columns matched with zero differences.

## "Nuevo" now means what Marcos says it means

`New` meant "one deposit and the FTD was under 30 days ago", which put a player
with one deposit and 40 settled bets beside someone who deposited once and never
played. Of the 89 in New, **53 had five or more bets**. It now means: deposited
inside the last 7 days, exactly one deposit ever, fewer than 5 bets. Everyone
else who deposited inside 7 days is Active.

| | before | after |
|---|---|---|
| New | 89 | **36** |
| Active | 265 | **318** |

Those 53 are the only rows that move; checked before switching.

- **`Casual` is gone from the ladder**, and could never have held anyone: it
  required one deposit whose FTD was 30+ days old, but with a single deposit the
  FTD *is* the last deposit. It survives as the `ELSE` in `lifecycle_stage()` so
  nothing falls through to null, and is absent from `STAGES`.
- The stage lives in **`lifecycle_stage(deposit_count, days_since_deposit, bets)`**
  so `player_lifecycle` and `player_tier_progress` cannot drift. `IMMUTABLE`,
  **no `SET` clause** — adding one would stop it inlining, which is the whole
  point. It and `lifecycle_rank()` therefore carry a
  `function_search_path_mutable` warning from the linter, exactly as `local_day`
  and `local_week` do, for the same reason: they touch no table and no
  schema-qualified object, so there is nothing a search path could redirect.
- The two views are checked against each other: the stage agrees on all 4,159
  players.

## Stage history starts the day it is written, and cannot start earlier

`player_stage_history` keeps one row per player per import, keyed by
`data_through` rather than by the clock. `player_stage_moves` compares each
player against **their own** previous capture, so someone who first appears in
the second import has no phantom move.

**It is not backfilled, and cannot be.** The stage is a threshold on days since
the last deposit, and the player report only ever carries the *latest* deposit
date, so a player's stage on 11 October is not recoverable from what we hold
today. `deposit_periods` knows which week a player deposited in but not which
day, and the thresholds are 8/15/30 days — dating a deposit to its period end
would move players across stage lines on invented precision.

- Written by `snapshot_player_stages()` at the end of the **player report**
  import, because that is the only import that moves a stage.
- Keyed on the data cut-off, so re-uploading the same week corrects that week's
  row instead of adding a second one.
- The screens say so rather than showing a zero: with one capture the movement
  panel explains that the next import is what makes the question answerable.
- `lifecycle_rank()` orders stages by health, so a move reads as a direction.
  `Registered` is the floor and `Churned` sits above it — a churned player has
  paid once, and the climb back is shorter.
- No foreign key to `players(id)`, for the two reasons `player_notes` has none.

## A ticket is a bet slip, and the money on it is two kinds

`player_tickets` counts bet slips and splits their value into `stake` (the
player's own money) and `bonus_stake` (promotional), which are additive — the
same pair `player_tier_progress` already sums for the trailing wager. Rolled up
per VIP tier in `vip_tier_summary` and per deposit period in
`deposit_period_tickets`.

- **Bets carry a real `bet_date`; deposits do not.** The payments report sums a
  range with no day on it, so the ticket columns beside each deposit period are
  attributed exactly while the deposits beside them are not.
- The bonus share is worth reading on its own: it ran ~4% through August and
  September and **13–17% across October**.
- `avg_deposit_ticket` is new and `avg_deposit` is not the same thing —
  total deposited over *deposits made*, not over players. The old column
  answered a different question and is no longer shown on the tier table.
- **`vip_tier_summary` was joining `players`, not `real_players`**, so the tier
  table counted 4,298 players and DOP 16,905,042 against the book's 4,159 and
  16,855,042 — 139 internal and excluded accounts, DOP 50,000 of their money, on
  a page that gets checked against the backoffice. It now ties exactly.

## The deposit funnel and "FTDs this month" are two different questions

The funnel follows a **registration cohort**: of the people who signed up in
these days, how many went on to pay. Marcos reads the FTD bar as "this month's
FTDs", which is a different figure — first deposits *made* in the window,
whoever they came from. For October 1–25 that is **427** against the funnel's
**370**, and the gap is September's signups paying in October.

Both are now on screen, the cohort note says which is which, and the growth
figures match the Overview.

- **The period filter is anchored to the data** (`dataAnchoredRange`), not to
  the clock. Picking "this week" off the calendar asked for 26 Oct – 1 Nov
  against data through the 25th, so the week filter rendered an empty page and
  read as broken. Week now means the last week there are numbers for, month the
  month that week sits in, trimmed where the data stops, prior cut to the same
  length.
- **PostgREST cannot call `local_day()`**, so a range filter on a timestamptz
  column has to carry the offset itself. Comparing against a bare date string
  compares in UTC and moves the boundary four hours: the funnel counted 2,268
  registrations for October where `local_day()` counts 2,249. `dayStartUTC()`
  and `dayAfterUTC()` in `period.js` are the only correct way to filter a
  timestamp column by local day from the client.
- **`avg_deposit_amount` is a dead column.** The report stopped supplying it and
  the importer never maps it, so all 4,403 rows are null — which is why that
  card read DOP 0. Derived now from the two figures that are real.
- `scripts/verify-period-compare.mjs` covers the anchoring, 20 cases.
  Mutation-tested: anchoring to the clock breaks 7, dropping the length match
  breaks 2.

## A direct connection cannot see a whole class of failure

CLAUDE.md already says to *measure* as `authenticated` rather than as yourself.
The same applies to *running* a function, and for a different reason:
`authenticator`, the role PostgREST connects as, carries

```
session_preload_libraries = supautils, safeupdate
```

and `safeupdate` rejects a `DELETE` or `UPDATE` with no `WHERE` clause **for the
whole session** — inside a `SECURITY DEFINER` function too, because it is an
executor hook, not a permission check. `SECURITY DEFINER` changes the user, not
the loaded libraries.

So `delete from player_sport_counts;` inside `refresh_player_sport_counts()`
succeeded every time it was called from the MCP connection and failed the first
time the dashboard called it, with **"DELETE requires a WHERE clause"**. The
Altenar import on 2026-11-02 died there; 12,424 bets had already landed, and
only the refreshes after them were lost.

- `LOAD 'safeupdate'` is not permitted from a normal connection, so the guard
  cannot be reproduced from here. **The real proof is an import from the
  dashboard.** Verifying a cache function by calling it over MCP proves it
  computes the right rows and nothing about whether the app can run it.
- Both refresh functions now delete with a predicate on a real `NOT NULL`
  column, not `where true` — it matches every row just the same and does not
  depend on whether a tautology survives constant folding long enough for the
  hook to see it.
- `refresh_player_ggr()`, `assign_vip_tiers()`, `refresh_internal_flags()` and
  `reconcile_deposit_period_scopes()` contain no `DELETE` at all, so nothing
  else in the import path was affected.

## A capture taken while the anchor lags describes nothing

`data_through` is the **earliest** of its three sources. On screen that is the
right kind of conservative — the whole point of the anchor. For a *capture* it
is a trap, and the upload order walks straight into it: player report, payments,
Altenar.

On 2026-11-02 the player report put deposits and logins at 1 November while
`bets` still stopped on 25 October, so `data_through` was still 25 October.
`snapshot_player_stages()` ran at the end of that import and wrote the whole
roster under `captured_on = 2026-10-25`, holding **333 players with a negative
`days_since_deposit`** — down to −7, because they had deposited *after* the
cut-off their stage was measured against.

It also overwrote the genuine 25 October row, the key being
`(player_id, captured_on)`, and the 268 "stage moves" that then appeared against
the 1 November capture were pure artefact. Left alone it would have recurred
every week, each capture a week stale in its key, every comparison between the
wrong pair.

- The function now **returns 0 and writes nothing** while `data_through` is
  behind the newest `last_deposit_date` / `last_login_at` in `real_players`.
- **The Altenar import calls it too**, so whichever upload brings the anchor
  level is the one that records the week. Neither call needs to be "the last
  one" and the order can change without breaking it.
- Verified both ways: it writes when the anchor is level, and returns 0 with the
  bets rolled back behind the player data inside a `begin … rollback`.
- The corrupt row was deleted. **1 November is the first real baseline**, so the
  first stage-movement comparison is the import after it.
- The general shape: anything *stored* keyed by `data_through` has to check that
  the anchor is not lagging. Anything merely *displayed* does not.

## A `SET` clause on a hot predicate costs more than the query it protects

Fourth time now, and the two worst offenders were the oldest functions in the
database. `weekly_kpis` measured **3,753 ms** as `authenticated` — under the 8 s
limit warm, over it cold, and climbing with every week of bets. The whole cost
was two calls in the scan qual over `bets`:

| `weekly_kpis`, as `authenticated` | |
|---|---|
| before | 3,753 ms |
| `bet_counts_as_wagering()` inlined | 2,760 ms |
| `operations_start()` inlined | **870 ms** |

The Seq Scan on `bets` alone went **1,385 ms → 93 ms** for the same 54,699 rows.
One page of Segments fell to 171 ms. Every other view filtering `bets` got the
same benefit for nothing.

- **`bet_counts_as_wagering()` was `IMMUTABLE` with `SET search_path`.** The body
  compares a text value against four literals — it touches no table and no
  schema-qualified object, so the `SET` protected nothing and only blocked
  inlining. Rewritten with a standard SQL body (`BEGIN ATOMIC`), which is parsed
  and bound at creation, so dropping the clause costs nothing even in principle.
- **`operations_start()` was `STABLE SECURITY DEFINER` with a `SET` clause,
  reading `app_settings`.** Either property alone blocks inlining, so
  `local_day(bet_date) >= operations_start()` was a per-row call that queried a
  table — and because the value was opaque, no expression index could serve the
  predicate either. It is now the literal `date '2026-08-10'`, `IMMUTABLE`, with
  a guard in the migration that fails if `app_settings.operations_start_date`
  stops matching — the same shape `local_day()` uses for the timezone.
  It also dropped out of both "definer function reachable by anon /
  authenticated" lints, since it reads nothing and needs no elevated rights.
- Both now carry `function_search_path_mutable`, deliberately, alongside
  `local_day`, `local_week`, `lifecycle_stage` and `lifecycle_rank`.
- Verified: `weekly_kpis` returns identical figures for all 12 weeks, and
  `bet_counts_as_wagering` classifies all 56,839 bets exactly as the
  hand-written predicate, zero disagreements.

**The rule, generalised:** before adding `SET search_path` to a function, ask
whether the body can resolve anything through the search path at all. If it only
touches its own arguments and literals, the clause buys nothing and costs an
inlining opportunity on every row of every scan that calls it.

## The month-straddling week is a standing tax, and the screen has to say so

October read **DOP 11,856,425** where the backoffice read **14,995,928** for the
same month, and the dashboard was right. The week of 26 Oct – 1 Nov was loaded,
primary, worth 3,867,480 — but six of its days are October and one is November,
and the payments report is one aggregate per player with no dates inside the
period, so those days cannot be separated. `deposits_monthly` therefore leaves
the whole period out and October stops at `covered_to = 2026-10-25`.

This recurs **every month**, so it is not a one-off to remember:

- The remedy is unchanged: pull the report twice, 1st-to-month-end and
  1st-of-next-to-Sunday, upload both, and `reconcile_deposit_period_scopes()`
  demotes the straddling week and promotes the pair.
- The screens used to say this only in a hover on a small "(incompleto)" tag.
  A hover is invisible to someone comparing a number against the backoffice,
  which is exactly when it is needed, so `GoalTracker` now renders it as a
  visible line that names the remedy.
- Nothing can fix this in the database. A split needs day-level deposits, which
  only the transaction export has.
