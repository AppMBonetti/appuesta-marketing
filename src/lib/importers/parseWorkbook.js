function normalizeHeader(h) {
  // Accepts both display-style headers ("Total GGR Sportsbook") and the camelCase
  // headers InTarget's CSV export uses ("totalGGRSportsbook"), normalizing both to
  // "total ggr sportsbook" so one HEADER_MAP covers either export format.
  return String(h ?? "")
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function unwrapCellValue(value) {
  if (value && typeof value === "object") {
    if (value.result !== undefined) return unwrapCellValue(value.result);
    if (value.text !== undefined) return value.text;
    if (Array.isArray(value.richText)) return value.richText.map(t => t.text).join("");
  }
  return value;
}

// "27.11.2025 08:51" / "27-11-2025" — day-first, as shown in InTarget's web grid.
// The CSV export uses ISO-8601 with an offset, which `new Date()` handles natively;
// this is the fallback for files exported straight from the UI table.
const DAY_FIRST_RE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

export function toISOTimestamp(rawValue) {
  const value = unwrapCellValue(rawValue);
  if (value == null || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") {
    // Excel serial date (days since 1899-12-30), in case a cell wasn't auto-parsed to a Date
    const excelEpoch = Date.UTC(1899, 11, 30);
    return new Date(excelEpoch + value * 86400000).toISOString();
  }

  const str = String(value).trim();
  if (!str) return null;

  const dayFirst = str.match(DAY_FIRST_RE);
  if (dayFirst) {
    const [, d, m, y, hh = "0", mm = "0", ss = "0"] = dayFirst;
    const day = Number(d), month = Number(m);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const parsed = new Date(Number(y), month - 1, day, Number(hh), Number(mm), Number(ss));
      return isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
  }

  const parsed = new Date(str);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Parses a number that may be formatted in either European ("1.063,87") or
 * anglophone ("1,063.87") style. InTarget exports the European form, where a
 * naive strip-the-commas parse turns 295.986,87 into 295.98687 — silently off
 * by 1000x — so the separators have to be resolved rather than discarded.
 */
export function toNumber(rawValue) {
  const value = unwrapCellValue(rawValue);
  if (value == null || value === "") return null;
  if (typeof value === "number") return isNaN(value) ? null : value;

  const raw = String(value).trim();
  if (!raw) return null;

  const negative = raw.startsWith("-") || /^\(.*\)$/.test(raw);
  const digits = raw.replace(/[^0-9.,]/g, "");
  if (!digits || !/[0-9]/.test(digits)) return null;

  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");

  let decimalSep = null;
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: whichever comes last is the decimal separator.
    decimalSep = lastDot > lastComma ? "." : ",";
  } else if (lastComma !== -1) {
    // Only commas. A single comma with exactly 3 digits after it reads as a
    // thousands group (1,234); anything else is a decimal comma (842,38 / 12,5).
    const trailing = digits.length - lastComma - 1;
    decimalSep = trailing === 3 && digits.indexOf(",") === lastComma ? null : ",";
  } else if (lastDot !== -1) {
    const trailing = digits.length - lastDot - 1;
    decimalSep = trailing === 3 && digits.indexOf(".") === lastDot ? null : ".";
  }

  let intPart = digits;
  let fracPart = "";
  if (decimalSep) {
    const idx = digits.lastIndexOf(decimalSep);
    intPart = digits.slice(0, idx);
    fracPart = digits.slice(idx + 1).replace(/[.,]/g, "");
  }
  intPart = intPart.replace(/[.,]/g, "");

  const n = parseFloat(`${intPart || "0"}${fracPart ? `.${fracPart}` : ""}`);
  if (isNaN(n)) return null;
  return negative ? -Math.abs(n) : n;
}

export function toText(rawValue) {
  const value = unwrapCellValue(rawValue);
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

// Large numeric IDs must stay as exact-integer text (no scientific notation, no ".0").
export function toIdText(rawValue) {
  const value = unwrapCellValue(rawValue);
  if (value == null || value === "") return null;
  if (typeof value === "number") return String(Math.round(value));
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** Splits delimited text into rows of raw string cells, honoring quoted fields. */
function parseDelimitedText(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let touched = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; touched = true; }
    else if (ch === delimiter) { row.push(field); field = ""; touched = true; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; touched = false; }
    else if (ch !== "\r") { field += ch; touched = true; }
  }
  if (touched || field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function detectDelimiter(firstLine) {
  let best = ",";
  let bestCount = 0;
  for (const candidate of [";", ",", "\t", "|"]) {
    const count = parseDelimitedText(firstLine, candidate)[0]?.length ?? 0;
    if (count > bestCount) { bestCount = count; best = candidate; }
  }
  return best;
}

function rowsFromDelimitedText(text) {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const cells = parseDelimitedText(clean, detectDelimiter(firstLine));
  return cells.filter(r => r.some(c => String(c).trim() !== ""));
}

async function readSheetRows(file) {
  const isCsv = /\.(csv|tsv|txt)$/i.test(file.name || "");
  if (isCsv) return rowsFromDelimitedText(await file.text());

  const { readXlsxRows } = await import("./xlsx");
  return readXlsxRows(await file.arrayBuffer());
}

/**
 * Parses the first worksheet of an .xlsx file, or the contents of a delimited
 * .csv/.tsv, into row objects mapped by a normalized-header -> target-field table.
 * @param {File} file
 * @param {Record<string,string>} headerMap normalized source header -> target field name
 * @returns {Promise<{rows: Array<Record<string, any>>, matchedHeaders: string[], unmatchedHeaders: string[]}>}
 */
export async function parseXlsxFile(file, headerMap) {
  const sheetRows = await readSheetRows(file);
  if (!sheetRows.length) throw new Error("No rows found in file");

  const [headerCells, ...dataRows] = sheetRows;
  const colIndexToField = new Map();
  const matchedHeaders = [];
  const unmatchedHeaders = [];

  headerCells.forEach((cell, index) => {
    const norm = normalizeHeader(unwrapCellValue(cell));
    if (!norm) return;
    const field = headerMap[norm];
    if (field) {
      colIndexToField.set(index, field);
      matchedHeaders.push(norm);
    } else {
      unmatchedHeaders.push(norm);
    }
  });

  const rows = [];
  for (const cells of dataRows) {
    const obj = {};
    let hasAnyValue = false;
    colIndexToField.forEach((field, index) => {
      const cellValue = cells[index];
      if (cellValue != null && String(cellValue).trim() !== "") hasAnyValue = true;
      obj[field] = cellValue;
    });
    if (hasAnyValue) rows.push(obj);
  }

  return { rows, matchedHeaders, unmatchedHeaders };
}

export async function upsertInChunks(supabase, table, rows, onConflict, chunkSize = 500) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict });
    if (error) throw error;
  }
}
