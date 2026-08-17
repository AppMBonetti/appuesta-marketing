function normalizeHeader(h) {
  return String(h ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function unwrapCellValue(value) {
  if (value && typeof value === "object") {
    if (value.result !== undefined) return unwrapCellValue(value.result);
    if (value.text !== undefined) return value.text;
    if (Array.isArray(value.richText)) return value.richText.map(t => t.text).join("");
  }
  return value;
}

export function toISOTimestamp(rawValue) {
  const value = unwrapCellValue(rawValue);
  if (value == null || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") {
    // Excel serial date (days since 1899-12-30), in case a cell wasn't auto-parsed to a Date
    const excelEpoch = Date.UTC(1899, 11, 30);
    return new Date(excelEpoch + value * 86400000).toISOString();
  }
  const parsed = new Date(String(value));
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function toNumber(rawValue) {
  const value = unwrapCellValue(rawValue);
  if (value == null || value === "") return null;
  if (typeof value === "number") return value;
  const n = parseFloat(String(value).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}

export function toText(rawValue) {
  const value = unwrapCellValue(rawValue);
  if (value == null || value === "") return null;
  return String(value).trim();
}

// Large numeric IDs must stay as exact-integer text (no scientific notation, no ".0").
export function toIdText(rawValue) {
  const value = unwrapCellValue(rawValue);
  if (value == null || value === "") return null;
  if (typeof value === "number") return String(Math.round(value));
  return String(value).trim();
}

/**
 * Parses the first worksheet of an .xlsx file into row objects mapped by a
 * normalized-header -> target-field lookup table.
 * @param {File} file
 * @param {Record<string,string>} headerMap normalized source header -> target field name
 * @returns {Promise<{rows: Array<Record<string, any>>, matchedHeaders: string[], unmatchedHeaders: string[]}>}
 */
export async function parseXlsxFile(file, headerMap) {
  const { default: ExcelJS } = await import("exceljs");
  const buffer = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("No worksheet found in file");

  const headerRow = worksheet.getRow(1);
  const colIndexToField = new Map();
  const matchedHeaders = [];
  const unmatchedHeaders = [];

  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const norm = normalizeHeader(cell.value);
    const field = headerMap[norm];
    if (field) {
      colIndexToField.set(colNumber, field);
      matchedHeaders.push(norm);
    } else if (norm) {
      unmatchedHeaders.push(norm);
    }
  });

  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};
    let hasAnyValue = false;
    colIndexToField.forEach((field, colNumber) => {
      const cellValue = row.getCell(colNumber).value;
      if (cellValue != null && cellValue !== "") hasAnyValue = true;
      obj[field] = cellValue;
    });
    if (hasAnyValue) rows.push(obj);
  });

  return { rows, matchedHeaders, unmatchedHeaders };
}

export async function upsertInChunks(supabase, table, rows, onConflict, chunkSize = 500) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict });
    if (error) throw error;
  }
}
