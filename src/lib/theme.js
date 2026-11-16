/**
 * Every colour on this dashboard, as CSS custom properties.
 *
 * `C.panel` used to be the literal `"#161A21"`, written straight into 867
 * inline styles across 32 files. Inline styles are computed at render time, so
 * swapping a palette that way means re-rendering every screen from a React
 * context — and a module-level object cannot be swapped at all. Pointing each
 * token at a variable instead moves the switch to one attribute on `<html>`:
 * the browser recomputes, nothing re-renders, and not one of those 867 call
 * sites had to change.
 *
 * Two things follow from that and are easy to get wrong:
 *
 * - **A var cannot carry a hex alpha suffix.** `${C.accent}66` produced
 *   `#E4022B66`; with a variable it produces `var(--c-accent)66`, which is not
 *   a colour and silently renders as nothing. The handful of translucent uses
 *   therefore have tokens of their own, listed below.
 * - **Charts want real colours.** Recharts passes these through to SVG `fill`
 *   and `stroke`, where a var does resolve — but a canvas or an image export
 *   would not. LINE_COLORS and the tier and stage palettes stay literal,
 *   because they are data colours: a series must keep its colour when the
 *   theme changes, or two screenshots of the same chart stop being comparable.
 */
export const C = {
  bg: "var(--c-bg)",
  panel: "var(--c-panel)",
  panelBorder: "var(--c-panel-border)",
  // One step in from `panel`: inputs, secondary buttons, the inside of a bar.
  inset: "var(--c-inset)",
  // The background of an open or hovered row.
  rowOpen: "var(--c-row-open)",
  ink: "var(--c-ink)",
  inkDim: "var(--c-ink-dim)",
  inkFaint: "var(--c-ink-faint)",
  accent: "var(--c-accent)",
  accentDim: "var(--c-accent-dim)",
  positive: "var(--c-positive)",
  positiveSoft: "var(--c-positive-soft)",
  negative: "var(--c-negative)",
  // Amber. Not "negative": it marks something provisional or incomplete — an
  // estimated week, a partial month — rather than something wrong.
  warn: "var(--c-warn)",
  warnSoft: "var(--c-warn-soft)",
  // The tinted panel behind a real alert.
  dangerSoft: "var(--c-danger-soft)",
  overlay: "var(--c-overlay)",
  warnBorder: "var(--c-warn-border)",
  navActive: "var(--c-nav-active)",
  headCell: "var(--c-head-cell)",
  field: "var(--c-field)",
  pinned: "var(--c-pinned)",
  emptyCell: "var(--c-empty-cell)",

};

/**
 * A translucent version of any colour.
 *
 * This exists because `${C.accent}66` stopped working the moment the tokens
 * became variables: it produced `var(--c-accent)66`, which is not a colour and
 * renders as nothing — a border that silently disappears rather than an error
 * anybody notices. Worse, three palettes here (stage-move, watchlist, note
 * kind) mix literal hex with C tokens, so the call site cannot know which form
 * it is holding.
 *
 * `color-mix` takes both. Percentages are the hex suffixes they replace: 66 is
 * 40%, 55 is 33%, 40 is 25%, 30 is 19%, 2A is 16%, 1F is 12%.
 */
export const alpha = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

/** Series colours. Literal on purpose — see the note above. */
export const LINE_COLORS = ["#E4022B", "#3ECB9E", "#D9A848", "#6E9BF2", "#B073F0"];

/**
 * Which palette a clock reading should get.
 *
 * Light from 07:00, dark from 19:00, on the viewer's own clock. Marcos asked
 * for "morning light, night dark" rather than following the operating system,
 * so this follows the hour and the operating system's preference is not
 * consulted at all.
 */
export const THEME_DAY_START = 7;
export const THEME_NIGHT_START = 19;

export function themeForHour(hour) {
  return hour >= THEME_DAY_START && hour < THEME_NIGHT_START ? "light" : "dark";
}

/** "auto" resolves against the clock; "light" and "dark" are what they say. */
export function resolveTheme(mode, now = new Date()) {
  return mode === "light" || mode === "dark" ? mode : themeForHour(now.getHours());
}
