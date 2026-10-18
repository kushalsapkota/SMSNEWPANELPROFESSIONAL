/**
 * Small RFC 4180 CSV reader for the campaign wizard preview (the api parses
 * the uploaded file itself; this only has to agree with it on what the user
 * sees). Handles quoted fields, doubled quotes, CRLF/LF/CR line ends, a UTF-8
 * BOM, and auto-detects `,` `;` or tab as the delimiter from the header line.
 */

export interface ParsedCsv {
  delimiter: string;
  headers: string[];
  rows: string[][];
  /** data rows whose cell count differs from the header (still included) */
  ragged: number;
}

const CANDIDATES = [",", ";", "\t"] as const;

/** Count delimiter occurrences outside quotes in the first line. */
export function detectDelimiter(text: string): string {
  const firstLine: string[] = [];
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    firstLine.push(inQuotes ? "" : ch);
  }
  let best: string = ",";
  let bestCount = 0;
  for (const d of CANDIDATES) {
    const n = firstLine.filter((c) => c === d).length;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** Parse CSV text into records (array of fields). Blank lines are skipped. */
export function parseCsvRecords(text: string, delimiter = ","): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRecord();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (field !== "" || record.length > 0) endRecord();
  return records;
}

/** Parse with a header row. Header names are trimmed; empty names become `column_N`. */
export function parseCsv(text: string, delimiter?: string): ParsedCsv {
  const d = delimiter ?? detectDelimiter(text);
  const records = parseCsvRecords(text, d);
  if (records.length === 0) return { delimiter: d, headers: [], rows: [], ragged: 0 };
  const headers = records[0].map((h, i) => h.trim() || `column_${i + 1}`);
  const rows = records.slice(1);
  const ragged = rows.filter((r) => r.length !== headers.length).length;
  return { delimiter: d, headers, rows, ragged };
}

/** Rows as objects keyed by header (missing cells → ""). */
export function rowsToObjects(csv: ParsedCsv): Array<Record<string, string>> {
  return csv.rows.map((r) => {
    const o: Record<string, string> = {};
    csv.headers.forEach((h, i) => {
      o[h] = (r[i] ?? "").trim();
    });
    return o;
  });
}

/** Header that holds phone numbers: "phone" (case-insensitive) first, then common aliases. */
export function findPhoneColumn(headers: string[]): string | null {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const name of ["phone", "msisdn", "mobile", "number", "to", "destination"]) {
    const i = lower.indexOf(name);
    if (i >= 0) return headers[i];
  }
  return null;
}

/** Quote a value for CSV output when needed. */
export function csvEscape(value: string): string {
  return /[",\r\n;\t]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize headers + rows back to CSV (comma, CRLF). */
export function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}
