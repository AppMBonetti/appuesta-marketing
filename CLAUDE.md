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
