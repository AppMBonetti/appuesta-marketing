/**
 * Serialises rows to CSV and hands the browser a download. Values are always
 * quoted and internal quotes doubled, so a player name containing a comma or a
 * caption containing a newline can't shift every following column.
 */
function escapeCell(value) {
  if (value == null) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function toCsv(columns, rows) {
  const header = columns.map(c => escapeCell(c.label)).join(",");
  const body = rows.map(row => columns.map(c => escapeCell(c.value(row))).join(",")).join("\n");
  // BOM so Excel opens accented Spanish names in the right encoding.
  return `﻿${header}\n${body}\n`;
}

export function downloadCsv(filename, columns, rows) {
  const blob = new Blob([toCsv(columns, rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke on the next tick so the click has already been handled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
