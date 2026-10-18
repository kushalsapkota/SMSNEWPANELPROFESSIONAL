/**
 * RFC 4180 CSV field encoding. Fields containing a comma, quote, CR or LF are quoted with
 * inner quotes doubled. Free-text columns can additionally be guarded against spreadsheet
 * formula injection (OWASP): a leading = + - @ TAB or CR is prefixed with a single quote.
 */
export function csvField(value: unknown, guardFormula = false): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (guardFormula && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(fields: string[]): string {
  return fields.join(',') + '\r\n';
}
