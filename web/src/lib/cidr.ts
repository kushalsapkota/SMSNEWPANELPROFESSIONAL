/** IPv4 / IPv6 address and CIDR validation (Postgres `cidr` semantics, host bits must be zero). */

function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255 || (p.length > 1 && p.startsWith("0"))) return null;
    out.push(n);
  }
  return out;
}

function parseIPv6(s: string): number[] | null {
  // returns 16 bytes
  let head = s;
  let v4tail: number[] | null = null;
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".") && lastColon >= 0) {
    v4tail = parseIPv4(s.slice(lastColon + 1));
    if (!v4tail) return null;
    head = s.slice(0, lastColon) + ":0:0";
  }
  const dbl = head.split("::");
  if (dbl.length > 2) return null;
  const left = dbl[0] ? dbl[0].split(":") : [];
  const right = dbl.length === 2 && dbl[1] ? dbl[1].split(":") : [];
  const total = left.length + right.length;
  if (dbl.length === 1 && total !== 8) return null;
  if (dbl.length === 2 && total > 7) return null;
  const groups = [...left, ...Array(8 - total).fill("0"), ...right];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (v4tail) bytes.splice(12, 4, ...v4tail);
  return bytes;
}

export type CidrCheck = { ok: true; normalized: string } | { ok: false; error: string };

/** Accepts "1.2.3.4", "10.0.0.0/8", "2001:db8::/32". Plain IPs become /32 or /128. */
export function checkCidr(input: string): CidrCheck {
  const s = input.trim();
  if (!s) return { ok: false, error: "Required" };
  const [addr = "", maskStr, extra] = s.split("/");
  if (extra !== undefined) return { ok: false, error: "Invalid CIDR" };
  const v4 = parseIPv4(addr);
  const v6 = v4 ? null : parseIPv6(addr);
  const bytes = v4 ?? v6;
  if (!bytes) return { ok: false, error: "Not a valid IPv4 or IPv6 address" };
  const maxBits = v4 ? 32 : 128;
  let bits = maxBits;
  if (maskStr !== undefined) {
    if (!/^\d{1,3}$/.test(maskStr)) return { ok: false, error: "Invalid prefix length" };
    bits = Number(maskStr);
    if (bits > maxBits) return { ok: false, error: `Prefix length must be ≤ ${maxBits}` };
  }
  for (let i = 0; i < bytes.length; i++) {
    const bitStart = i * 8;
    const keep = Math.max(0, Math.min(8, bits - bitStart));
    const mask = keep === 8 ? 0xff : (0xff << (8 - keep)) & 0xff;
    if ((bytes[i] & ~mask & 0xff) !== 0) {
      return { ok: false, error: "Host bits must be zero for this prefix length" };
    }
  }
  return { ok: true, normalized: `${addr.toLowerCase()}/${bits}` };
}
