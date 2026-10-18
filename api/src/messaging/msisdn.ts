/**
 * MSISDN normalisation, mirroring the engine's lenient superset of CONTRACTS §3
 * (CONTRACTS-CHANGES engine-core #5): strip spaces (any Unicode whitespace), `-`, Unicode
 * dashes, `(`, `)`, `.` and ONE leading `+`; the rest must be 6-15 ASCII digits.
 */
const STRIP = /[\s  -​  　\-‐-―−().]/g;

export function normalizeDestination(input: string): string | null {
  let v = input.replace(STRIP, '');
  if (v.startsWith('+')) v = v.slice(1);
  return /^[0-9]{6,15}$/.test(v) ? v : null;
}

/**
 * Splits a `to` value into individual recipients. A string may hold several numbers
 * separated by commas, semicolons or newlines (legacy GET clients); arrays are taken as-is.
 */
export function splitRecipients(to: string | string[]): string[] {
  const list = Array.isArray(to) ? to : to.split(/[,;\n]/);
  return list.map((s) => s.trim()).filter((s) => s.length > 0);
}
