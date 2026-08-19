// Module-level so every money formatter in the app reads the same setting
// without threading a prop through every chart, table and tile. App holds the
// selection in React state, so changing it re-renders the whole tree.
const STORAGE_KEY = "appuesta.currency";

const state = {
  currency: "DOP",
  dopPerUsd: null,     // null until a rate is known; USD stays unavailable
  rateDate: null,
  rateSource: null,
};

export function getCurrencyState() {
  return { ...state };
}

export function setCurrency(currency) {
  state.currency = currency === "USD" ? "USD" : "DOP";
  try { localStorage.setItem(STORAGE_KEY, state.currency); } catch { /* private mode */ }
  return state.currency;
}

export function restoreCurrency() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "USD" || saved === "DOP") state.currency = saved;
  } catch { /* private mode */ }
  return state.currency;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Resolves today's DOP-per-USD rate. Reads the cached row first so every viewer
 * sees one number for the day; only the first visitor of the day hits the
 * upstream API. If that call fails the most recent stored rate is used, since a
 * slightly stale rate is far better than blanking every figure on the page.
 */
export async function loadFxRate() {
  // Imported lazily so the formatting side of this module stays free of the
  // Supabase client, which needs build-time env vars to construct.
  const { supabase } = await import("./supabaseClient");
  const today = todayISO();

  const { data: cached } = await supabase
    .from("fx_rates").select("*").eq("rate_date", today).maybeSingle();
  if (cached?.dop_per_usd) {
    Object.assign(state, {
      dopPerUsd: Number(cached.dop_per_usd), rateDate: cached.rate_date, rateSource: cached.source,
    });
    return state.dopPerUsd;
  }

  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    if (!res.ok) throw new Error(`FX HTTP ${res.status}`);
    const body = await res.json();
    const rate = Number(body?.rates?.DOP);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("FX response missing DOP");

    Object.assign(state, { dopPerUsd: rate, rateDate: today, rateSource: "open.er-api.com" });
    await supabase.from("fx_rates").upsert(
      { rate_date: today, dop_per_usd: rate, source: "open.er-api.com" },
      { onConflict: "rate_date" }
    );
    return rate;
  } catch {
    const { data: last } = await supabase
      .from("fx_rates").select("*").order("rate_date", { ascending: false }).limit(1).maybeSingle();
    if (last?.dop_per_usd) {
      Object.assign(state, {
        dopPerUsd: Number(last.dop_per_usd), rateDate: last.rate_date, rateSource: `${last.source} (cached)`,
      });
      return state.dopPerUsd;
    }
    return null;
  }
}

/** Converts a DOP amount into the active currency. */
export function toDisplayAmount(dopAmount) {
  if (dopAmount == null || dopAmount === "") return null;
  const n = Number(dopAmount);
  if (!Number.isFinite(n)) return null;
  if (state.currency === "USD" && state.dopPerUsd) return n / state.dopPerUsd;
  return n;
}

export function currencyCode() {
  // Without a rate, USD cannot be shown honestly, so figures stay in DOP.
  return state.currency === "USD" && state.dopPerUsd ? "USD" : "DOP";
}

/** All money in the dashboard is stored in DOP and rendered through here. */
export function fmtMoney(dopAmount, { decimals = 0 } = {}) {
  const value = toDisplayAmount(dopAmount);
  if (value == null) return "—";
  const code = currencyCode();
  const locale = code === "USD" ? "en-US" : "es-DO";
  return `${code} ${value.toLocaleString(locale, {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  })}`;
}
