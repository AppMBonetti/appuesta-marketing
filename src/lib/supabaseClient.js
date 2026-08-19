import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/**
 * Missing configuration is reported, never thrown at module scope.
 *
 * Vite inlines these env vars at build time, so when they are absent the check
 * folds to a constant and a module-scope `throw` becomes unconditional — which
 * lets the bundler treat the entire application imported after it as
 * unreachable and drop it. The build still succeeds and still deploys; it just
 * ships a blank page. Surfacing the problem as a value keeps the app in the
 * bundle so it can render an explanation instead.
 */
export const supabaseConfigError = (!url || !key)
  ? "Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY — set them in the Netlify environment (or .env.local when running locally)."
  : null;

// Placeholders keep createClient from throwing; every request fails visibly
// against an unroutable host rather than the app disappearing at build time.
export const supabase = createClient(
  url || "https://unconfigured.invalid",
  key || "unconfigured"
);
