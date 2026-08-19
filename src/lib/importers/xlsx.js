/**
 * Minimal .xlsx reader.
 *
 * Altenar's bet-list export writes every part with a namespace prefix
 * (`<x:worksheet>`, `<x:sheet>`), which exceljs cannot open at all — it matches
 * bare tag names and ends up with no sheets. Matching on the local name instead
 * reads both that export and ordinary Excel files, and drops a ~930 kB
 * dependency in the process.
 *
 * Only what the importers need is supported: the first worksheet, shared and
 * inline strings, and raw cell values. Formatting, formulas, and dates stored as
 * styled serials are returned as their underlying numbers for the callers to
 * interpret.
 */

const EOCD_SIGNATURE = 0x06054b50;

function findEndOfCentralDirectory(view) {
  // The EOCD sits at the end, after a comment of at most 65535 bytes.
  const earliest = Math.max(0, view.byteLength - 22 - 65535);
  for (let i = view.byteLength - 22; i >= earliest; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads a zip archive into a Map of filename -> decoded UTF-8 text. */
async function readZipEntries(buffer, wanted) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error("Not a valid .xlsx file (no zip directory found)");

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const decoder = new TextDecoder("utf-8");
  const entries = new Map();

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (!wanted(name)) continue;

    // The local header repeats the name/extra with its own lengths.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) entries.set(name, decoder.decode(raw));
    else if (method === 8) entries.set(name, decoder.decode(await inflateRaw(raw)));
    else throw new Error(`Unsupported compression in ${name}`);
  }

  return entries;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlText(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code) => {
    if (code[0] === "#") {
      const value = code[1] === "x" || code[1] === "X"
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isNaN(value) ? whole : String.fromCodePoint(value);
    }
    return ENTITIES[code] ?? whole;
  });
}

/** Matches an element by local name, ignoring any namespace prefix. */
function tagPattern(name, flags = "g") {
  return new RegExp(`<(?:[\\w.-]+:)?${name}(\\s[^>]*?)?(/)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>|<(?:[\\w.-]+:)?${name}(\\s[^>]*?)?/>`, flags);
}

function textOfAllT(xml) {
  let out = "";
  for (const match of xml.matchAll(tagPattern("t"))) out += decodeXmlText(match[3] ?? "");
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  for (const match of xml.matchAll(tagPattern("si"))) strings.push(textOfAllT(match[3] ?? ""));
  return strings;
}

function attr(attrs, name) {
  const match = attrs ? new RegExp(`\\b${name}="([^"]*)"`).exec(attrs) : null;
  return match ? match[1] : null;
}

/** "BC12" -> 54 (zero-based column index). */
function columnIndexFromRef(ref) {
  const match = /^([A-Z]+)/.exec(ref || "");
  if (!match) return -1;
  let index = 0;
  for (const ch of match[1]) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function parseCell(attrs, inner, sharedStrings) {
  const type = attr(attrs, "t");

  if (type === "inlineStr") {
    const text = textOfAllT(inner ?? "");
    return text === "" ? null : text;
  }

  const valueMatch = tagPattern("v", "").exec(inner ?? "");
  const rawValue = valueMatch ? decodeXmlText(valueMatch[3] ?? "") : null;
  if (rawValue == null || rawValue === "") return null;

  if (type === "s") {
    const index = Number(rawValue);
    return sharedStrings[index] ?? null;
  }
  if (type === "b") return rawValue === "1";
  if (type === "e") return null;
  if (type === "str" || type === "d") return rawValue;

  const numeric = Number(rawValue);
  return Number.isNaN(numeric) ? rawValue : numeric;
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(tagPattern("row"))) {
    const inner = rowMatch[3];
    if (!inner) { rows.push([]); continue; }

    const cells = [];
    let cursor = 0;
    for (const cellMatch of inner.matchAll(tagPattern("c"))) {
      const attrs = cellMatch[1] ?? cellMatch[4];
      const value = cellMatch[2] === "/" || cellMatch[0].endsWith("/>")
        ? null
        : parseCell(attrs, cellMatch[3], sharedStrings);

      // Empty cells may be omitted entirely; place by reference when present.
      const index = columnIndexFromRef(attr(attrs, "r"));
      const target = index >= 0 ? index : cursor;
      while (cells.length < target) cells.push(null);
      cells[target] = value;
      cursor = target + 1;
    }
    rows.push(cells);
  }
  return rows;
}

function firstSheetPath(workbookXml, relsXml) {
  const sheetMatch = tagPattern("sheet", "").exec(workbookXml ?? "");
  const relId = attr(sheetMatch?.[1] ?? sheetMatch?.[4], "r:id");

  if (relId && relsXml) {
    for (const rel of relsXml.matchAll(/<Relationship\s[^>]*?\/?>/g)) {
      if (attr(rel[0], "Id") === relId) {
        const target = attr(rel[0], "Target");
        if (target) return target.replace(/^\/?(xl\/)?/, "xl/");
      }
    }
  }
  return "xl/worksheets/sheet1.xml";
}

/**
 * Reads the first worksheet of an .xlsx file as an array of row arrays.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Array<Array<string|number|boolean|null>>>}
 */
export async function readXlsxRows(buffer) {
  const needed = name =>
    name === "xl/workbook.xml" ||
    name === "xl/_rels/workbook.xml.rels" ||
    name === "xl/sharedStrings.xml" ||
    name.startsWith("xl/worksheets/sheet");

  const entries = await readZipEntries(buffer, needed);
  const sheetPath = firstSheetPath(entries.get("xl/workbook.xml"), entries.get("xl/_rels/workbook.xml.rels"));
  const sheetXml = entries.get(sheetPath) || entries.get("xl/worksheets/sheet1.xml");
  if (!sheetXml) throw new Error("No worksheet found in file");

  return parseSheet(sheetXml, parseSharedStrings(entries.get("xl/sharedStrings.xml")));
}
