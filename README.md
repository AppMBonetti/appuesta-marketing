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

## Build

```bash
npm run build
```
