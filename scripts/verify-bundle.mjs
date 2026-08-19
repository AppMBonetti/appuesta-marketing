import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Asserts the built bundle actually contains the application.
 *
 * A build can succeed while emitting nothing but vendor code — that is exactly
 * what happened when the Supabase env vars were absent and the app was
 * tree-shaken away behind a constant-folded throw. `vite build` exiting 0 is
 * therefore not sufficient evidence that the app was compiled, so this checks
 * for markers that can only come from our own source.
 */
const MARKERS = ["Segmentos", "weekly_kpis", "Prospecto"];
const ASSETS = "dist/assets";

let files;
try {
  files = readdirSync(ASSETS).filter(f => f.endsWith(".js"));
} catch {
  console.error(`verify-bundle: ${ASSETS} not found — did the build run?`);
  process.exit(1);
}

const combined = files.map(f => readFileSync(join(ASSETS, f), "utf8")).join("");
const missing = MARKERS.filter(m => !combined.includes(m));

if (missing.length) {
  console.error(
    `\nverify-bundle: the build produced no application code.\n` +
    `Missing markers: ${missing.join(", ")}\n` +
    `This usually means VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY were\n` +
    `unset, so the app was dropped as unreachable. Set them and rebuild.\n`
  );
  process.exit(1);
}

console.log(`verify-bundle: application present in ${files.length} chunk(s).`);
