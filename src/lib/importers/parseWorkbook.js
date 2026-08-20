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

// Operator timezone. Altenar's export writes wall-clock times with no offset,
// so without pinning a zone the same file produces different instants depending
// on where it was uploaded from — a laptop in Madrid would store every bet four
// hours away from one in Santo Domingo.
export const SOURCE_TIMEZONE = "America/Santo_Domingo";

/** Offset, in ms, that `timeZone` was from UTC at a given instant. */
function zoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const at = {};
  for (const part of parts) if (part.type !== "literal") at[part.type] = Number(part.value);
  const asIfUtc = Date.UTC(at.year, at.month - 1, at.day, at.hour % 24, at.minute, at.second);
  return asIfUtc - utcMs;
}

/**
 * Converts a wall-clock reading in `timeZone` to the correct UTC instant.
 * Applied twice because the offset itself depends on the instant, which matters
 * either side of a DST change (the Dominican Republic has none today, but this
 * must not quietly break if the zone setting is ever pointed elsewhere).
 */
export function wallClockToUtc(y, month, day, hh = 0, mm = 0, ss = 0, timeZone = SOURCE_TIMEZONE) {
  const naive = Date.UTC(y, month - 1, day, hh, mm, ss);
  let utc = naive - zoneOffsetMs(naive, timeZone);
  utc = naive - zoneOffsetMs(utc, timeZone);
  return utc;
}

/**
 * Timezones an export can be declared to be in. Altenar renders its reports in
 * whatever zone the template was configured with and writes no offset into the
 * file, so the zone has to be stated by whoever uploads it rather than guessed
 * from the numbers.
 */
export const IMPORT_TIMEZONES = [
  { value: "UTC", label: "UTC (+00:00)" },
  { value: "America/Santo_Domingo", label: "Santo Domingo (UTC−4)" },
  { value: "America/New_York", label: "New York (UTC−4/−5)" },
  { value: "America/Bogota", label: "Bogotá (UTC−5)" },
  { value: "Europe/Madrid", label: "Madrid (UTC+1/+2)" },
];

/** Hours `to` is ahead of `from` at a given instant — 0 when the zones agree. */
export function timezoneShiftHours(from, to, atMs = Date.now()) {
  if (!from || !to || from === to) return 0;
  return Math.round((zoneOffsetMs(atMs, to) - zoneOffsetMs(atMs, from)) / 3600000);
}

/**
 * The zone that would have made an import land where the stored data already
 * sits. Reading a wall clock in zone Z gives `wall - offset(Z)`, so a batch that
 * came out `shiftHours` off under `declaredZone` needs a zone whose offset is
 * `offset(declared) + shiftHours` — which is a far more useful thing to tell
 * someone than the size of the error.
 */
export function zoneCancellingShift(shiftHours, declaredZone, atMs = Date.now()) {
  if (!shiftHours) return null;
  const target = zoneOffsetMs(atMs, declaredZone) + shiftHours * 3600000;
  return IMPORT_TIMEZONES.find(tz => zoneOffsetMs(atMs, tz.value) === target) || null;
}

/** Wall-clock parts of an instant, read as if it were UTC. */
function utcParts(ms) {
  const d = new Date(ms);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
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

// "2026-08-14 09:41:00" / "2026-08-14T09:41" — ISO order with no offset, so the
// reading is wall clock and needs the source zone applied like any other.
const ISO_NO_OFFSET_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\.\d+)?$/;

/**
 * Parses a cell into a UTC ISO timestamp, reading offset-less values as wall
 * clock in `timeZone`. Excel stores a datetime as a bare serial number with no
 * zone attached, so the same cell means a different instant depending on which
 * zone the report was rendered in — that choice belongs to the caller.
 */
export function toISOTimestamp(rawValue, timeZone = SOURCE_TIMEZONE) {
  const value = unwrapCellValue(rawValue);
  if (value == null || value === "") return null;
  // ExcelJS builds dates from the serial as if it were UTC, so the Date it hands
  // back carries the file's wall clock, not an instant — re-read it in `timeZone`.
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    const utc = wallClockToUtc(...utcParts(value.getTime()), timeZone);
    return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
  }
  if (typeof value === "number") {
    // Excel serial date (days since 1899-12-30), in case a cell wasn't auto-parsed to a Date
    const excelEpoch = Date.UTC(1899, 11, 30);
    const utc = wallClockToUtc(...utcParts(excelEpoch + value * 86400000), timeZone);
    return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
  }

  const str = String(value).trim();
  if (!str) return null;

  const dayFirst = str.match(DAY_FIRST_RE);
  if (dayFirst) {
    const [, d, m, y, hh = "0", mm = "0", ss = "0"] = dayFirst;
    const day = Number(d), month = Number(m);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const utc = wallClockToUtc(Number(y), month, day, Number(hh), Number(mm), Number(ss), timeZone);
      return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
    }
  }

  const isoLocal = str.match(ISO_NO_OFFSET_RE);
  if (isoLocal) {
    const [, y, m, d, hh = "0", mm = "0", ss = "0"] = isoLocal;
    const utc = wallClockToUtc(Number(y), Number(m), Number(d), Number(hh), Number(mm), Number(ss), timeZone);
    return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
  }

  // Anything left carries its own offset (or a "Z"), which is authoritative.
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

  // A thousands group is never written as a bare leading zero, so "0.155" and
  // "0,155" are decimals in either locale — without this, GA4's fractional
  // rates (0.155) would parse as 155 under the three-digit grouping rule below.
  const leadingZero = /^0[.,]/.test(digits);

  let decimalSep = null;
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: whichever comes last is the decimal separator.
    decimalSep = lastDot > lastComma ? "." : ",";
  } else if (lastComma !== -1) {
    // Only commas. A single comma with exactly 3 digits after it reads as a
    // thousands group (1,234); anything else is a decimal comma (842,38 / 12,5).
    const trailing = digits.length - lastComma - 1;
    decimalSep = !leadingZero && trailing === 3 && digits.indexOf(",") === lastComma ? null : ",";
  } else if (lastDot !== -1) {
    const trailing = digits.length - lastDot - 1;
    decimalSep = !leadingZero && trailing === 3 && digits.indexOf(".") === lastDot ? null : ".";
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

/**
 * Parses a calendar date to a plain YYYY-MM-DD string. Unlike `toISOTimestamp`
 * this never round-trips through a timezone, so a date-only cell can't shift a
 * day when the browser runs at a negative UTC offset.
 */
export function toISODateOnly(rawValue) {
  const value = unwrapCellValue(rawValue);
  if (value == null || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    const excelEpoch = Date.UTC(1899, 11, 30);
    return new Date(excelEpoch + value * 86400000).toISOString().slice(0, 10);
  }

  const str = String(value).trim();
  if (!str) return null;

  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // Supermetrics sometimes emits GA4 dates in the API's compact form.
  const compact = str.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;

  const dayFirst = str.match(DAY_FIRST_RE);
  if (dayFirst) {
    const [, d, m, y] = dayFirst;
    const day = Number(d), month = Number(m);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const parsed = new Date(str);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
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

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

/**
 * Iterates elements by local name, ignoring any namespace prefix, yielding
 * [attributes, innerXml]. Only used for OOXML parts, whose row/cell elements
 * never nest inside themselves.
 */
function* xmlElements(xml, name) {
  const open = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}(\\s[^>]*?)?(/)?>`, "g");
  const close = new RegExp(`</(?:[A-Za-z_][\\w.-]*:)?${name}>`, "g");
  let match;
  while ((match = open.exec(xml))) {
    const attrs = match[1] || "";
    if (match[2]) { yield [attrs, ""]; continue; }
    close.lastIndex = open.lastIndex;
    const end = close.exec(xml);
    yield [attrs, end ? xml.slice(open.lastIndex, end.index) : ""];
    if (end) open.lastIndex = end.index + end[0].length;
  }
}

function xmlAttr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
}

/** "BC12" -> 54 (zero-based column index). */
function columnIndexFromRef(ref) {
  const letters = (ref || "").match(/^[A-Z]+/);
  if (!letters) return null;
  let index = 0;
  for (const ch of letters[0]) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * Minimal xlsx reader used when ExcelJS refuses a workbook. Altenar's export
 * writes every element with an `x:` namespace prefix (`<x:sheets><x:sheet/>`),
 * which is valid OOXML but leaves ExcelJS's tag-name matching with no sheets at
 * all — it then throws on `workbook.sheets`. Matching by local name reads those
 * files, and dates/numbers stay raw for the field converters to interpret.
 */
async function readSheetRowsNamespaceTolerant(file) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const readPart = async (path) => {
    const entry = zip.file(path.replace(/^\//, ""));
    return entry ? entry.async("string") : null;
  };

  const sharedStrings = [];
  const sharedXml = await readPart("xl/sharedStrings.xml");
  if (sharedXml) {
    for (const [, si] of xmlElements(sharedXml, "si")) {
      let text = "";
      for (const [, t] of xmlElements(si, "t")) text += t;
      sharedStrings.push(decodeXml(text));
    }
  }

  // Resolve the first sheet through the workbook's relationships, falling back
  // to the conventional path when the parts are missing or unreadable.
  let sheetPath = "xl/worksheets/sheet1.xml";
  const workbookXml = await readPart("xl/workbook.xml");
  const relsXml = await readPart("xl/_rels/workbook.xml.rels");
  if (workbookXml && relsXml) {
    const firstSheet = [...xmlElements(workbookXml, "sheet")][0];
    const relId = firstSheet ? xmlAttr(firstSheet[0], "r:id") || xmlAttr(firstSheet[0], "id") : null;
    if (relId) {
      for (const [attrs] of xmlElements(relsXml, "Relationship")) {
        if (xmlAttr(attrs, "Id") === relId) {
          const target = xmlAttr(attrs, "Target");
          if (target) sheetPath = target.replace(/^\//, "").replace(/^(?!xl\/)/, "xl/");
          break;
        }
      }
    }
  }

  const sheetXml = await readPart(sheetPath);
  if (!sheetXml) throw new Error("No worksheet found in file");

  const rows = [];
  for (const [, rowXml] of xmlElements(sheetXml, "row")) {
    const cells = [];
    let column = 0;
    for (const [attrs, cellXml] of xmlElements(rowXml, "c")) {
      const ref = xmlAttr(attrs, "r");
      const index = ref != null ? columnIndexFromRef(ref) : null;
      column = index == null ? column : index;

      const type = xmlAttr(attrs, "t");
      let value = null;
      if (type === "inlineStr") {
        let text = "";
        for (const [, t] of xmlElements(cellXml, "t")) text += t;
        value = decodeXml(text);
      } else {
        const raw = [...xmlElements(cellXml, "v")][0]?.[1];
        if (raw != null && raw !== "") {
          const decoded = decodeXml(raw);
          if (type === "s") value = sharedStrings[Number(decoded)] ?? null;
          else if (type === "b") value = decoded === "1";
          else if (type === "str" || type === "e") value = decoded;
          else {
            const numeric = Number(decoded);
            value = Number.isFinite(numeric) ? numeric : decoded;
          }
        }
      }
      cells[column] = value;
      column += 1;
    }
    if (cells.some(c => c != null && String(c).trim() !== "")) rows.push(cells);
  }
  return rows;
}

async function readSheetRows(file) {
  const isCsv = /\.(csv|tsv|txt)$/i.test(file.name || "");
  if (isCsv) return rowsFromDelimitedText(await file.text());

  let worksheet;
  try {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    worksheet = workbook.worksheets[0];
  } catch {
    // ExcelJS rejects namespace-prefixed workbooks (Altenar's exporter writes
    // them); the tolerant reader handles those rather than failing the import.
    return readSheetRowsNamespaceTolerant(file);
  }
  if (!worksheet) return readSheetRowsNamespaceTolerant(file);

  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, row => {
    const cells = [];
    // `values` is 1-indexed with a leading hole; drop it so both readers agree.
    const values = row.values || [];
    for (let i = 1; i < values.length; i++) cells.push(values[i]);
    rows.push(cells);
  });
  return rows;
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
