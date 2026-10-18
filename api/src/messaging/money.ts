/** Formats integer micros as a decimal string with 6 fractional digits, without floats. */
export function microsToDecimal(micros: number | null | undefined): string {
  if (micros === null || micros === undefined) return '';
  const neg = micros < 0;
  const abs = BigInt(Math.abs(Math.trunc(micros)));
  const units = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0');
  return `${neg ? '-' : ''}${units.toString()}.${frac}`;
}
