# Appuesta — Marketing Dashboard

Vite + React marketing dashboard for Appuesta (sports betting, Dominican Republic), backed by Supabase. Replaces pi.appuesta.com.

## Stack

- Vite + React 19
- `@supabase/supabase-js` — auth (magic link) + data
- `recharts` — charts
- `exceljs` — client-side `.xlsx` parsing for the Import Data tab
- `lucide-react` — icons

## Setup

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project URL + publishable key
npm run dev
```

## Auth

Passwordless magic-link login (`supabase.auth.signInWithOtp`). Access is gated by the `team_members` table via Row Level Security — any authenticated Supabase user can sign in, but only emails present in `team_members` can read or write data. Users who sign in without being on the team list see a "not authorized" screen.

## Data model

See the live Supabase project for the source of truth. Tables: `players`, `bets`, `vip_tiers`, `ga4_channel_daily`, `budgets`, `goals`, `channel_reports`, `channel_budgets`, `data_imports`, `optimization_notes`, `team_members`. `players.vip_tier` is (re)computed by the `assign_vip_tiers()` Postgres function, called via RPC after every import.

## Data import

The **Import Data** tab parses InTarget player reports and Altenar bet list exports (`.xlsx`) entirely client-side, upserts into `players` / `bets`, logs a row to `data_imports`, and calls `assign_vip_tiers()`. Column mappings live in `src/lib/importers/`.

## Affiliates

The affiliate dashboard is a separate page at **`/afiliados`** (`src/AffiliatesApp.jsx`), chosen by path in `src/main.jsx`; it shares the marketing dashboard's build, login, team gating and database. It tracks influencer/affiliate codes. Each affiliate (`affiliates`) has a revenue-share % of GGR and an optional flat CPA per FTD. Their players report (the backoffice "Reports" CSV filtered by their code: `name;playerId;registeredAt;totalDepositAmount;totalGGRSportsbook`) is uploaded from the affiliate's page into `affiliate_players`; the importer is `src/lib/importers/affiliateReport.js`. `affiliate_player_stats` takes each figure from whichever is fresher — the upload or the player report — and `affiliate_summary` computes commission, payouts (`affiliate_payouts`) and balance due. Internal/test/excluded players never earn commission.

**Affiliate portal** — `/portal` (`src/PortalApp.jsx`) is what an affiliate signs into. The team links login emails to an affiliate on its page (`affiliate_users`). Affiliates have no table access: the portal reads only the `my_affiliate_*` security-definer functions, which resolve the affiliate from the signed-in email and return that affiliate's figures, masked player refs (last 4 digits) and payout amounts — no names, emails, notes or other affiliates.

**Sign-up allowlist** — the `hook_signup_allowlist` Postgres function (Supabase Auth → Hooks → Before User Created) refuses to create an account for any email not in `team_members` or `affiliate_users`. Add a new team member or affiliate email *before* they request their first login link.

## Build

```bash
npm run build
```
