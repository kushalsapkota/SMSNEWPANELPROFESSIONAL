/**
 * `{column}` placeholders in campaign bodies, with exactly the api's rules
 * (api/src/campaigns/recipients.ts, CONTRACTS-CHANGES "api part 2" #11):
 *   - CSV headers become variable names: trimmed, lower-cased, runs of
 *     anything but [a-z0-9_] → "_", leading/trailing "_" removed
 *     ("First Name" → "first_name");
 *   - a placeholder is `{name}` with name in [A-Za-z0-9_], matched
 *     case-insensitively;
 *   - the phone column is not a variable; any placeholder without a matching
 *     column makes the api reject the campaign (400), so the wizard blocks it.
 */

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/** "First Name" → "first_name" (the placeholder spelling). */
export function normalizeColumn(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Distinct placeholder names (lower-cased) in order of first appearance. */
export function findPlaceholders(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) {
    const name = m[1].toLowerCase();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Replace `{name}` with vars[name] (names compared lower-cased); unknown placeholders stay as written. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(vars)) lower.set(k.toLowerCase(), v);
  return body.replace(PLACEHOLDER, (whole, name: string) => {
    const v = lower.get(name.toLowerCase());
    return v === undefined ? whole : v;
  });
}

/** Placeholders used in body that no variable column provides. */
export function missingPlaceholders(body: string, columns: string[]): string[] {
  const known = new Set(columns.map((c) => c.toLowerCase()));
  return findPlaceholders(body).filter((p) => !known.has(p));
}

/** Insert text at a textarea selection; returns new text + caret position. */
export function insertAt(
  text: string,
  insert: string,
  selectionStart: number | null | undefined,
  selectionEnd: number | null | undefined,
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(text.length, selectionStart ?? text.length));
  const end = Math.max(start, Math.min(text.length, selectionEnd ?? start));
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
}
