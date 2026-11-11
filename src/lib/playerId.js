/**
 * The id a person sees is not the id the database keys on.
 *
 * The backoffice's own player id carries a three-digit skin prefix, and the
 * importers strip it: `playerIdFromExternal()` keeps the last 9 digits, so
 * `222100000109` is stored as `100000109`. That is the right call for storage —
 * it is short, it is stable, and every foreign key and twenty-odd views hang
 * off it — but it is the wrong thing to put on screen, because it is not what
 * anyone can paste into the backoffice to find the player.
 *
 * **The prefix is verified, not assumed.** `deposit_periods` keeps the original
 * `external_id` it was imported from: across all 3,620 rows carrying one, 1,017
 * distinct players, every single id is 12 digits beginning `222`. No second
 * prefix exists in the data.
 *
 * Two consequences worth keeping in mind:
 *
 * - **Nothing stored changes.** This is a display and export concern only. A
 *   migration that rewrote `players.id` would have to rewrite every table that
 *   references it, and would buy nothing the database cares about.
 * - **The 1,017 are the players who appear in the payments report.** The rest
 *   of the book — people who registered and never deposited — have no external
 *   id on file anywhere, so their prefix is inferred from the fact that the
 *   book is a single skin. If a second skin is ever added, this constant is the
 *   thing that has to stop being a constant.
 */
export const PLAYER_ID_PREFIX = "222";

/** The id as the backoffice writes it: what to show, export and paste. */
export function fullPlayerId(id) {
  if (id == null || id === "") return "";
  const raw = String(id);
  // Idempotent on purpose: a value that already carries the prefix must not
  // grow a second one if this is ever applied twice.
  return raw.startsWith(PLAYER_ID_PREFIX) && raw.length > 9
    ? raw
    : `${PLAYER_ID_PREFIX}${raw}`;
}

/**
 * Both forms, for a search haystack. Someone reading off the screen will type
 * `222100000109`; someone who remembers the short form will type `100000109`.
 * Both have to find the same player.
 */
export function playerIdHaystack(id) {
  if (id == null || id === "") return "";
  return `${id} ${fullPlayerId(id)}`;
}
