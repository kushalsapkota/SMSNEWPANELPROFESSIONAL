/**
 * Client-side SMS encoding/parts calculator (CONTRACTS §3), mirroring
 * engine/internal/smpp/coding exactly:
 *
 *   - GSM-7 if every character is in the GSM 03.38 basic table or the
 *     extension table; extension characters cost 2 septets (ESC + char).
 *     The ESC control character itself (0x1B) is NOT a valid input character.
 *   - otherwise UCS-2, counted in UTF-16 code units (emoji outside the BMP = 2).
 *   - parts: GSM7 ≤160 → 1 else ceil(n/153); UCS2 ≤70 → 1 else ceil(n/67).
 *   - more than 10 parts → MESSAGE_TOO_LONG.
 *
 * The engine is the source of truth (it applies templates first); this gives
 * instant feedback while typing. Empty text reports 0 parts (nothing to send).
 */
import type { MsgEncoding } from "@/lib/api/types";

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€\f";

const basic = new Set(Array.from(GSM_BASIC));
const ext = new Set(Array.from(GSM_EXT));

export const GSM7_SINGLE = 160;
export const GSM7_PART = 153;
export const UCS2_SINGLE = 70;
export const UCS2_PART = 67;
export const MAX_PARTS = 10;

export interface SmsAnalysis {
  encoding: MsgEncoding;
  /** septets for GSM7, UTF-16 code units for UCS2 */
  units: number;
  /** number of SMS segments (0 for empty text) */
  parts: number;
  /** capacity of one segment at the current part count (160/153 or 70/67) */
  perPart: number;
  /** units still free in the last segment before another part is needed */
  remaining: number;
  /** more than MAX_PARTS segments → the engine rejects with MESSAGE_TOO_LONG */
  tooLong: boolean;
  /** user-visible characters (code points) */
  chars: number;
  /** GSM extension-table characters (each costs 2 septets); 0 for UCS2 */
  extChars: number;
  /** distinct characters that forced UCS-2 (empty for GSM7) */
  nonGsm: string[];
}

/** Septets a code point takes in GSM-7 (1 basic, 2 extension) or 0 if not representable. */
export function gsmSeptets(ch: string): 0 | 1 | 2 {
  if (basic.has(ch)) return 1;
  if (ext.has(ch)) return 2;
  return 0;
}

export function isGsm7(text: string): boolean {
  for (const ch of Array.from(text)) if (gsmSeptets(ch) === 0) return false;
  return true;
}

/** Segment count for a length in units (CONTRACTS §3 arithmetic). */
export function partCount(units: number, encoding: MsgEncoding): number {
  if (units <= 0) return 0;
  const [single, part] = encoding === "GSM7" ? [GSM7_SINGLE, GSM7_PART] : [UCS2_SINGLE, UCS2_PART];
  return units <= single ? 1 : Math.ceil(units / part);
}

export function analyzeSms(text: string): SmsAnalysis {
  const codePoints = Array.from(text);
  let septets = 0;
  let extChars = 0;
  const nonGsm: string[] = [];
  const seen = new Set<string>();
  for (const ch of codePoints) {
    const s = gsmSeptets(ch);
    if (s === 0) {
      if (!seen.has(ch)) {
        seen.add(ch);
        nonGsm.push(ch);
      }
    } else {
      septets += s;
      if (s === 2) extChars += 1;
    }
  }
  const encoding: MsgEncoding = nonGsm.length === 0 ? "GSM7" : "UCS2";
  const units = encoding === "GSM7" ? septets : text.length; // String.length = UTF-16 code units
  const parts = partCount(units, encoding);
  const [single, part] = encoding === "GSM7" ? [GSM7_SINGLE, GSM7_PART] : [UCS2_SINGLE, UCS2_PART];
  const perPart = parts > 1 ? part : single;
  const remaining = parts === 0 ? single : parts === 1 ? single - units : parts * part - units;
  return {
    encoding,
    units,
    parts,
    perPart,
    remaining,
    tooLong: parts > MAX_PARTS,
    chars: codePoints.length,
    extChars: encoding === "GSM7" ? extChars : 0,
    nonGsm,
  };
}

/** Human label for an encoding. */
export function encodingLabel(e: MsgEncoding): string {
  return e === "GSM7" ? "GSM-7" : "UCS-2 (Unicode)";
}

/** Printable form of a character for "forces Unicode" hints (control chars, spaces). */
export function visibleChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20 || cp === 0x7f || (cp >= 0x2000 && cp <= 0x200f) || cp === 0xa0 || cp === 0xfeff) {
    return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return ch;
}

/** Common look-alikes that silently force UCS-2 → GSM-safe replacements. */
const SMART_REPLACEMENTS: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "–": "-",
  "—": "-",
  "−": "-",
  "…": "...",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  "​": "",
  "﻿": "",
  "\t": " ",
};

/** Replace typographic quotes/dashes/ellipsis/odd spaces with GSM equivalents. */
export function toGsmSafe(text: string): string {
  return Array.from(text)
    .map((ch) => (ch in SMART_REPLACEMENTS ? SMART_REPLACEMENTS[ch] : ch))
    .join("");
}

/** True when `toGsmSafe` would make a UCS-2 text GSM-7. */
export function canBecomeGsm(text: string): boolean {
  return !isGsm7(text) && isGsm7(toGsmSafe(text));
}
