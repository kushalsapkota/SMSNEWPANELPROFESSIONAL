/** MSISDN helpers (CONTRACTS §3). */

/** Strip "+", spaces, dashes, dots and parentheses. */
export function stripPhone(input: string): string {
  return input.replace(/[+\s\-().]/g, "");
}

/** Normalize to digits-only E.164 without "+"; null when not 6-15 digits. */
export function normalizeMsisdn(input: string): string | null {
  const s = stripPhone(input);
  return /^[0-9]{6,15}$/.test(s) ? s : null;
}

/** Digits-only prefix (used by routes/rates/blocklist); '' allowed when allowEmpty. */
export function isDigitPrefix(input: string, { allowEmpty = true, max = 15 } = {}): boolean {
  if (input === "") return allowEmpty;
  return new RegExp(`^[0-9]{1,${max}}$`).test(input);
}

/** Split a textarea of recipients (newline / comma / semicolon separated). */
export function parseRecipients(input: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(/[\n,;]+/)) {
    const t = raw.trim();
    if (!t) continue;
    const n = normalizeMsisdn(t);
    if (!n) invalid.push(t);
    else if (!seen.has(n)) {
      seen.add(n);
      valid.push(n);
    }
  }
  return { valid, invalid };
}

/** Sender validity per sender_ids CHECK constraint. */
export function isValidSender(sender: string): boolean {
  return /^\+?[0-9]{1,15}$/.test(sender) || /^[A-Za-z0-9 ._-]{1,11}$/.test(sender);
}
