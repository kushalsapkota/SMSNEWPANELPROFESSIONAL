import { isIP } from 'node:net';

export interface ParsedCidr {
  cidr: string;
  version: 4 | 6;
}

function ipv4ToBits(ip: string): bigint {
  return ip.split('.').reduce((acc, o) => (acc << 8n) | BigInt(Number(o)), 0n);
}

function expandIpv6(ip: string): number[] | null {
  let addr = ip;
  // embedded IPv4 tail (::ffff:1.2.3.4)
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const b = ipv4ToBits(v4[1]);
    addr = addr.slice(0, -v4[1].length) + `${((b >> 16n) & 0xffffn).toString(16)}:${(b & 0xffffn).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

function ipv6ToBits(ip: string): bigint | null {
  const g = expandIpv6(ip);
  if (!g) return null;
  return g.reduce((acc, x) => (acc << 16n) | BigInt(x), 0n);
}

/**
 * Validates a CIDR (or bare IP, treated as /32 or /128) exactly as Postgres `cidr` would:
 * host bits right of the mask must be zero. Returns an error message or the parsed value.
 */
export function parseCidr(input: string): ParsedCidr | { error: string } {
  const s = input.trim();
  const [ip, maskStr, extra] = s.split('/');
  if (extra !== undefined) return { error: 'invalid CIDR' };
  const version = isIP(ip);
  if (version === 0) return { error: 'invalid IP address' };
  const max = version === 4 ? 32 : 128;
  let mask = max;
  if (maskStr !== undefined) {
    if (!/^[0-9]{1,3}$/.test(maskStr)) return { error: 'invalid prefix length' };
    mask = Number(maskStr);
    if (mask > max) return { error: `prefix length must be <= ${max}` };
  }
  const bits = version === 4 ? ipv4ToBits(ip) : ipv6ToBits(ip);
  if (bits === null) return { error: 'invalid IP address' };
  const hostBits = BigInt(max - mask);
  const hostMask = (1n << hostBits) - 1n;
  if ((bits & hostMask) !== 0n) {
    const network = bits & ~hostMask;
    const net =
      version === 4
        ? [24n, 16n, 8n, 0n].map((sh) => ((network >> sh) & 0xffn).toString()).join('.')
        : null;
    return { error: `host bits set to the right of the mask${net ? ` (did you mean ${net}/${mask}?)` : ''}` };
  }
  return { cidr: `${ip.toLowerCase()}/${mask}`, version: version as 4 | 6 };
}

/** Does `ip` fall inside `cidr`? (both already validated) */
export function cidrContains(cidr: string, ip: string): boolean {
  const [net, maskStr] = cidr.split('/');
  const v = isIP(net);
  if (v !== isIP(ip)) return false;
  const max = v === 4 ? 32 : 128;
  const mask = Number(maskStr ?? max);
  const a = v === 4 ? ipv4ToBits(net) : ipv6ToBits(net);
  const b = v === 4 ? ipv4ToBits(ip) : ipv6ToBits(ip);
  if (a === null || b === null) return false;
  const shift = BigInt(max - mask);
  return a >> shift === b >> shift;
}
