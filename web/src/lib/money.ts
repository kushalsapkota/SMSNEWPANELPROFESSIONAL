/**
 * Money helpers. All amounts are integer micros (1 unit = 1_000_000).
 * Conversion is done on strings / bigint so no float rounding ever touches
 * a stored value.
 */

export const MICROS_PER_UNIT = 1_000_000;

/** Parse a user-typed decimal ("12", "-0.0045", "1,234.5") into micros. null if invalid. */
export function parseMoneyToMicros(input: string): number | null {
  const s = input.trim().replace(/[,\s_]/g, "");
  if (!s) return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const [, sign, intPart = "", frac = ""] = m;
  if (!intPart && !frac) return null;
  if (frac.length > 6) return null;
  const micros = BigInt(intPart || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
  const signed = sign === "-" ? -micros : micros;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    return null;
  }
  return Number(signed);
}

/** Micros → plain decimal string with up to `maxDecimals` (trailing zeros trimmed, min 2). */
export function microsToDecimalString(micros: number, maxDecimals = 6, minDecimals = 0): string {
  const negative = micros < 0;
  const abs = BigInt(Math.abs(Math.trunc(micros)));
  const intPart = abs / 1_000_000n;
  let frac = (abs % 1_000_000n).toString().padStart(6, "0").slice(0, maxDecimals);
  frac = frac.replace(/0+$/, "");
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, "0");
  return `${negative ? "-" : ""}${intPart.toString()}${frac ? "." + frac : ""}`;
}

const formatterCache = new Map<string, Intl.NumberFormat>();

function formatter(currency: string, maxDecimals: number): Intl.NumberFormat {
  const key = `${currency}:${maxDecimals}`;
  let f = formatterCache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: maxDecimals,
      });
    } catch {
      f = new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: maxDecimals,
      });
    }
    formatterCache.set(key, f);
  }
  return f;
}

/**
 * Display micros as currency with up to 4 decimals (CONTRACTS §12),
 * e.g. 5000 → "$0.005", 12_340_000 → "$12.34".
 */
export function formatMoney(
  micros: number | null | undefined,
  currency = "USD",
  maxDecimals = 4,
): string {
  if (micros === null || micros === undefined || Number.isNaN(micros)) return "—";
  // Round to maxDecimals in integer space, then format the exact decimal string.
  const step = 10 ** (6 - maxDecimals);
  const rounded = Math.round(micros / step) * step;
  const decimal = microsToDecimalString(rounded, maxDecimals);
  const f = formatter(currency.trim().toUpperCase() || "USD", maxDecimals);
  // Intl accepts string input as an exact decimal in modern engines.
  return f.format(decimal as unknown as number);
}

/** Margin (rate - cost) and percentage over cost. */
export function margin(rateMicros: number, costMicros: number | null | undefined) {
  if (costMicros === null || costMicros === undefined) return null;
  const diff = rateMicros - costMicros;
  const pct = costMicros > 0 ? (diff / costMicros) * 100 : null;
  return { diff, pct };
}
