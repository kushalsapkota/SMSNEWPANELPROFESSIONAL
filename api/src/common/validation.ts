import { isIP } from 'node:net';
import { z } from 'zod';

/** Reusable zod building blocks. */
export const uuid = z.string().uuid();
export const digitsPrefix = z.string().regex(/^[0-9]{0,15}$/, 'must be 0-15 digits');
export const micros = z.number().int().safe();
export const nonNegMicros = micros.nonnegative();
export const password = z.string().min(8, 'must be at least 8 characters').max(128);
export const email = z.string().trim().toLowerCase().email().max(254);

/** Query-string boolean ("true"/"false"/"1"/"0"). */
export const queryBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/** Normalises an MSISDN per CONTRACTS §3: strip +, spaces, dashes; must be 6-15 digits. */
export function normalizeMsisdn(input: string): string | null {
  const digits = input.replace(/[\s\-+().]/g, '');
  return /^[0-9]{6,15}$/.test(digits) ? digits : null;
}

/** RE2-compatibility check for patterns the Go engine evaluates (CONTRACTS §9). */
export function re2SafetyError(pattern: string): string | null {
  if (pattern.length === 0) return 'pattern must not be empty';
  if (pattern.length > 500) return 'pattern must be at most 500 characters';
  if (/\(\?<?[=!]/.test(pattern)) return 'look-around assertions are not supported (RE2)';
  if (/\(\?>/.test(pattern)) return 'atomic groups are not supported (RE2)';
  if (/(^|[^\\])(\\\\)*\\[1-9]/.test(pattern)) return 'backreferences are not supported (RE2)';
  if (/\\k[<{']/.test(pattern)) return 'named backreferences are not supported (RE2)';
  if (/[*+?}]\+/.test(pattern.replace(/\\./g, ''))) return 'possessive quantifiers are not supported (RE2)';
  if (/\((\?(R|[0-9]|[+-][0-9]|&|P>|P=))/.test(pattern)) return 'recursion / subroutine calls are not supported (RE2)';
  if (/\(\?'/.test(pattern)) return "(?'name') groups are not supported (RE2); use (?P<name>)";
  // Must also be a syntactically valid regex. Translate RE2-only syntax JS lacks.
  const jsCompatible = pattern
    .replace(/\(\?P</g, '(?<')
    .replace(/\(\?[imsU]+\)/g, '')
    .replace(/\(\?[imsU-]+:/g, '(?:');
  try {
    new RegExp(jsCompatible, 'u');
  } catch (e) {
    try {
      new RegExp(jsCompatible);
    } catch {
      return `invalid regular expression: ${(e as Error).message}`;
    }
  }
  return null;
}

export const re2Pattern = z.string().superRefine((v, ctx) => {
  const err = re2SafetyError(v);
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
});

/** Escapes LIKE/ILIKE wildcards in user input and wraps it for a substring match. */
export function likeContains(input: string): string {
  return `%${input.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}

/** SMPP source address rules mirrored from sender_ids CHECK (numeric E.164 or alphanumeric ≤ 11). */
export const senderAddress = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .refine((v) => /^\+?[0-9]{1,15}$/.test(v) || /^[A-Za-z0-9 ._-]{1,11}$/.test(v), 'must be numeric (≤15 digits) or alphanumeric (≤11 chars)');

/** True for an IPv4/IPv6 literal (IPv6 optionally in [brackets]) or an RFC 1123 hostname. */
export function isHostOrIp(input: string): boolean {
  const v = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
  if (isIP(v) !== 0) return true;
  if (v.length === 0 || v.length > 253) return false;
  // All-numeric dotted strings that are not valid IPv4 (e.g. 999.1.1.1) are typos, not hostnames.
  if (/^[0-9.]+$/.test(v)) return false;
  const name = v.endsWith('.') ? v.slice(0, -1) : v;
  return name.split('.').every((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l));
}

export const hostOrIp = z
  .string()
  .trim()
  .min(1, 'host is required')
  .max(253)
  .refine(isHostOrIp, 'must be a hostname (e.g. smsc.example.net) or an IP address (e.g. 10.0.0.5)');
