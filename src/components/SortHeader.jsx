import { C } from "../lib/theme";
import { sortIndicator } from "../lib/sortRows";

/**
 * The header row for a sortable table.
 *
 * Every table on the dashboard styles its own `th` — some right-align numbers,
 * some left-align names — so the caller passes its own `th` in and this only
 * replaces the cell's contents with a button. The padding moves from the `th`
 * onto the button so the whole cell stays clickable rather than just the text.
 *
 * `columns` is the same array given to `useSortedRows`, with a `label` on each:
 * either a string or a function of the string table (and `lang`, for the few
 * labels built inline rather than held in a key).
 *
 * `trailing` adds that many empty header cells for columns that carry buttons,
 * bars or badges rather than data, and so have nothing to sort on;
 * `trailingStyle` is merged into them where one needs a width of its own.
 */
export function SortHeader({ columns, sort, toggle, s, lang, th, hint, trailing = 0, trailingStyle }) {
  // The portal and the affiliate pages have string tables of their own, so the
  // tooltip can be passed in separately from the one that resolves the labels.
  const tip = hint ?? s?.sortHint;
  return (
    <tr>
      {columns.map(col => {
        const active = sort?.key === col.key;
        // A column can override the table's default alignment: the period
        // column in the deposit tables reads left while its numbers read right.
        const alignRight = (col.align ?? th?.textAlign) === "right";
        const label = typeof col.label === "function" ? col.label(s, lang) : col.label;
        return (
          <th key={col.key} style={{ ...th, padding: 0, textAlign: col.align ?? th?.textAlign }}>
            <button
              onClick={() => toggle(col.key)}
              title={tip}
              style={{
                all: "unset", cursor: "pointer", display: "flex", alignItems: "center",
                justifyContent: alignRight ? "flex-end" : "flex-start",
                gap: 4, padding: th?.padding ?? "9px 12px", width: "100%", boxSizing: "border-box",
                whiteSpace: "nowrap", fontSize: th?.fontSize ?? 11.5,
                color: active ? C.ink : C.inkDim,
                fontWeight: active ? 600 : 500,
              }}
            >
              {label}
              <span style={{ color: active ? C.accent : C.inkFaint, fontSize: 10 }}>
                {sortIndicator(sort, col.key)}
              </span>
            </button>
          </th>
        );
      })}
      {Array.from({ length: trailing }, (_, i) => <th key={`pad${i}`} style={{ ...th, ...trailingStyle }} />)}
    </tr>
  );
}
