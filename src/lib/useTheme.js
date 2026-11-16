import { useEffect, useState } from "react";
import { useSticky } from "./sticky";
import { resolveTheme, THEME_DAY_START, THEME_NIGHT_START } from "./theme";

/**
 * Light in the morning, dark at night, with a manual override that sticks.
 *
 * The mode is one of "auto", "light" or "dark" and is remembered per browser.
 * "auto" is the default and reads the viewer's own clock: light from 07:00,
 * dark from 19:00.
 *
 * It re-checks every minute rather than once at mount. A dashboard left open
 * on a wall or a second monitor would otherwise still be in daylight at
 * midnight, which is exactly the case the automatic mode exists for. A minute
 * is cheap: the effect sets one attribute and does nothing when it has not
 * changed.
 *
 * The attribute goes on `<html>`, not on a React provider, because every
 * colour is already a CSS variable — so switching recomputes styles in the
 * browser without re-rendering a single component.
 */
export function useTheme() {
  const [mode, setMode] = useSticky("appuesta.themeMode", "auto");
  const [resolved, setResolved] = useState(() => resolveTheme(mode));

  useEffect(() => {
    const apply = () => {
      const next = resolveTheme(mode);
      setResolved(prev => (prev === next ? prev : next));
      document.documentElement.setAttribute("data-theme", next);
    };
    apply();
    if (mode !== "auto") return undefined;
    const id = setInterval(apply, 60_000);
    // Coming back to a tab that slept through the evening should not wait up
    // to a minute to catch up.
    window.addEventListener("focus", apply);
    return () => { clearInterval(id); window.removeEventListener("focus", apply); };
  }, [mode]);

  return { mode, setMode, resolved, dayStart: THEME_DAY_START, nightStart: THEME_NIGHT_START };
}
