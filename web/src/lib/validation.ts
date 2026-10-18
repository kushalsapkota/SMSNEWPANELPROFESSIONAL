import { z } from "zod";
import { checkCidr } from "./cidr";
import { isValidSender, normalizeMsisdn } from "./phone";

/** Shared zod schemas so every form validates the same way the DB does. */

export const emailSchema = z.string().trim().min(1, "Required").email("Enter a valid email");

export const passwordSchema = z
  .string()
  .min(8, "At least 8 characters")
  .max(128, "At most 128 characters");

export const msisdnSchema = z
  .string()
  .trim()
  .refine((v) => normalizeMsisdn(v) !== null, "6-15 digits, optionally with + / spaces / dashes")
  .transform((v) => normalizeMsisdn(v) as string);

/** Destination prefix: digits only, '' = all destinations. */
export const prefixSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{0,15}$/, "Digits only (max 15), empty = all destinations");

export const requiredPrefixSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{1,15}$/, "1-15 digits");

export const senderSchema = z
  .string()
  .trim()
  .refine(isValidSender, "Up to 11 letters/digits/space . _ - or up to 15 digits");

/** SMPP 3.4 passwords are at most 8 characters. */
export const smppPasswordSchema = z.string().min(1, "Required").max(8, "SMPP passwords are max 8 characters");

export const cidrSchema = z
  .string()
  .trim()
  .superRefine((v, ctx) => {
    const c = checkCidr(v);
    if (!c.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: c.error });
  });

/** RE2-compatible pattern check: valid JS regex without look-arounds / backreferences. */
export function re2Error(pattern: string): string | null {
  if (!pattern) return "Required";
  if (/\(\?[=!]|\(\?<[=!]/.test(pattern)) return "Look-arounds are not supported (RE2)";
  if (/\\[1-9]/.test(pattern)) return "Backreferences are not supported (RE2)";
  try {
    new RegExp(pattern);
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid pattern";
  }
  return null;
}

export const re2Schema = z.string().superRefine((v, ctx) => {
  const err = re2Error(v);
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
});

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^(\d{6}|[A-Za-z0-9-]{8,20})$/, "6-digit code or a recovery code");

export const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable();

export const positiveIntOrNull = z.number().int().positive("Must be > 0").nullable();

function isIpv4(v: string): boolean {
  const parts = v.split(".");
  return parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
}

function isIpv6(v: string): boolean {
  if (!v.includes(":") || !/^[0-9A-Fa-f:.]+$/.test(v)) return false;
  try {
    new URL(`http://[${v}]/`);
    return true;
  } catch {
    return false;
  }
}

/** Hostname (RFC 1123) or IPv4 / IPv6 address (optionally [bracketed]); same rule as the api. */
export function isHostOrIp(input: string): boolean {
  const v = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (isIpv4(v) || isIpv6(v)) return true;
  if (v.length === 0 || v.length > 253 || /^[0-9.]+$/.test(v)) return false;
  const name = v.endsWith(".") ? v.slice(0, -1) : v;
  return name.split(".").every((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l));
}

export const hostSchema = z
  .string()
  .trim()
  .min(1, "Required")
  .refine(isHostOrIp, "Enter a host name (smsc.example.net) or an IP address");
