import { useEffect, useState } from "react";

/**
 * A piece of view state that survives a reload, kept in localStorage.
 *
 * Only for preferences, never for data: a filter position, a chosen tab. The
 * one that needs it is "hide restricted players" — somebody is marked
 * restricted precisely so they stop turning up in the lists, and a filter that
 * resets on every page load means ticking the same box on three screens every
 * morning.
 *
 * Reads and writes are wrapped because localStorage throws rather than
 * returning null in a private window with site data blocked, and a dashboard
 * that fails to render over a remembered checkbox is worse than one that
 * forgets it.
 */
export function useSticky(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? initial : JSON.parse(stored);
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Nothing to do and nothing worth saying: the filter still works for
      // this visit, it just will not be remembered for the next one.
    }
  }, [key, value]);

  return [value, setValue];
}
