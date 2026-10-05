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
