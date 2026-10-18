import { parse } from 'csv-parse/sync';
import { AppError } from '../common/errors';
import { normalizeDestination } from '../messaging/msisdn';

export const MAX_CAMPAIGN_RECIPIENTS = 100_000;
const MAX_VAR_LENGTH = 1000;
const MAX_COLUMNS = 50;
const SAMPLE_ERRORS = 20;

export interface ParsedRecipient {
  destination: string;
  vars: Record<string, string>;
}

export interface RecipientImport {
  recipients: ParsedRecipient[];
  /** Variable names available to {placeholders} (all non-phone columns). */
  columns: string[];
  invalid_rows: number;
  duplicate_rows: number;
  errors: { row: number; phone: string; reason: string }[];
}

/** "First Name" → "first_name": the placeholder spelling `{first_name}`. */
export function normalizeColumn(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

export function placeholders(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1].toLowerCase()))];
}

/** Replaces `{col}` with the recipient's value; unknown placeholders are left as written. */
export function renderBody(body: string, vars: Record<string, unknown>): string {
  return body.replace(PLACEHOLDER, (whole, name: string) => {
    const v = vars[name.toLowerCase()];
    return v === undefined || v === null ? whole : String(v);
  });
}

/** Every {placeholder} in the body must name a recipient column (catches typos before sending). */
export function assertPlaceholders(body: string, columns: string[]): void {
  const known = new Set(columns);
  const unknown = placeholders(body).filter((p) => !known.has(p));
  if (unknown.length > 0) {
    throw AppError.invalid(`body uses placeholders with no matching column: ${unknown.map((u) => `{${u}}`).join(', ')}`, {
      field: 'body',
      unknown_placeholders: unknown,
      available: columns,
    });
  }
}

class Collector {
  readonly recipients: ParsedRecipient[] = [];
  readonly errors: RecipientImport['errors'] = [];
  invalid = 0;
  duplicates = 0;
  private readonly seen = new Set<string>();

  add(row: number, phoneRaw: unknown, vars: Record<string, string>): void {
    const phone = phoneRaw === undefined || phoneRaw === null ? '' : String(phoneRaw).trim();
    const dest = phone ? normalizeDestination(phone) : null;
    if (!dest) {
      this.invalid += 1;
      if (this.errors.length < SAMPLE_ERRORS) this.errors.push({ row, phone, reason: phone ? 'invalid phone number' : 'phone is empty' });
      return;
    }
    if (this.seen.has(dest)) {
      this.duplicates += 1;
      return;
    }
    this.seen.add(dest);
    if (this.recipients.length >= MAX_CAMPAIGN_RECIPIENTS) {
      throw AppError.invalid(`A campaign may have at most ${MAX_CAMPAIGN_RECIPIENTS} recipients`, { max: MAX_CAMPAIGN_RECIPIENTS });
    }
    this.recipients.push({ destination: dest, vars });
  }

  result(columns: string[]): RecipientImport {
    return { recipients: this.recipients, columns, invalid_rows: this.invalid, duplicate_rows: this.duplicates, errors: this.errors };
  }
}

/**
 * CSV with a header row that includes a `phone` column (case/spacing-insensitive). Delimiter
 * `,` `;` or TAB; UTF-8 with or without BOM. Phones are normalised (CONTRACTS §3) and
 * de-duplicated (first row wins); invalid rows are counted and sampled, not fatal.
 * Every other column becomes a `{column}` variable.
 */
export function parseRecipientsCsv(buf: Buffer): RecipientImport {
  let header: string[] = [];
  let records: string[][];
  try {
    records = parse(buf, {
      bom: true,
      delimiter: [',', ';', '\t'],
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      max_record_size: 64 * 1024,
    }) as string[][];
  } catch (e) {
    throw AppError.invalid(`CSV could not be parsed: ${(e as Error).message}`, { field: 'file' });
  }
  if (records.length === 0) throw AppError.invalid('CSV file is empty', { field: 'file' });
  header = records[0].map(normalizeColumn);
  if (header.length > MAX_COLUMNS) throw AppError.invalid(`CSV may have at most ${MAX_COLUMNS} columns`, { field: 'file' });
  const dup = header.find((h, i) => h && header.indexOf(h) !== i);
  if (dup) throw AppError.invalid(`CSV header has a duplicate column "${dup}"`, { field: 'file' });
  const phoneIdx = header.indexOf('phone');
  if (phoneIdx < 0) throw AppError.invalid('CSV header must include a "phone" column', { field: 'file', columns: header });
  // Rows beyond the cap (+ slack for invalid/duplicate rows) are refused outright.
  if (records.length - 1 > MAX_CAMPAIGN_RECIPIENTS * 2) {
    throw AppError.invalid(`A campaign may have at most ${MAX_CAMPAIGN_RECIPIENTS} recipients`, { max: MAX_CAMPAIGN_RECIPIENTS, rows: records.length - 1 });
  }

  const varCols = header.map((h, i) => ({ h, i })).filter(({ h, i }) => i !== phoneIdx && h.length > 0);
  const c = new Collector();
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    const vars: Record<string, string> = {};
    for (const { h, i } of varCols) vars[h] = (rec[i] ?? '').slice(0, MAX_VAR_LENGTH);
    c.add(r + 1, rec[phoneIdx], vars); // r + 1 = 1-based line number incl. header
  }
  return c.result(varCols.map((v) => v.h));
}

/** JSON variant: [{phone, ...vars}]; variable names normalised like CSV headers. */
export function parseRecipientsJson(rows: Record<string, unknown>[]): RecipientImport {
  if (rows.length > MAX_CAMPAIGN_RECIPIENTS * 2) throw AppError.invalid(`A campaign may have at most ${MAX_CAMPAIGN_RECIPIENTS} recipients`);
  const columns = new Set<string>();
  const c = new Collector();
  rows.forEach((row, idx) => {
    const vars: Record<string, string> = {};
    let phone: unknown;
    for (const [k, v] of Object.entries(row)) {
      const name = normalizeColumn(k);
      if (!name) continue;
      if (name === 'phone') {
        phone = v;
        continue;
      }
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') throw AppError.invalid(`recipients[${idx}].${k} must be a string or number`, { field: `recipients.${idx}.${k}` });
      vars[name] = String(v).slice(0, MAX_VAR_LENGTH);
      columns.add(name);
    }
    if (Object.keys(vars).length > MAX_COLUMNS) throw AppError.invalid(`recipients[${idx}] has more than ${MAX_COLUMNS} variables`);
    c.add(idx + 1, phone, vars);
  });
  return c.result([...columns]);
}
