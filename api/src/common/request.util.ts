import type { Request } from 'express';
import { BlockList, isIP } from 'node:net';

export function normalizeIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  let v = ip.trim();
  // "[2001:db8::1]" / "1.2.3.4:5678" forms some proxies emit
  if (v.startsWith('[') && v.includes(']')) v = v.slice(1, v.indexOf(']'));
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(':'));
  if (v.toLowerCase().startsWith('::ffff:') && isIP(v.slice(7)) === 4) v = v.slice(7);
  return isIP(v) ? v : null;
}

/** Named ranges, same names as Express / proxy-addr. */
const NAMED_RANGES: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

/** Default TRUSTED_PROXIES: loopback + private networks (nginx on the host, the compose bridge, the web container). */
export const DEFAULT_TRUSTED_PROXIES = 'loopback,linklocal,uniquelocal';

/** The set of peer addresses whose X-Forwarded-For header is believed. */
export interface ProxyTrust {
  readonly spec: string;
  isTrusted(ip: string): boolean;
}

/**
 * Parses a TRUSTED_PROXIES list: comma/space separated CIDRs, bare IPs, or the names
 * loopback / linklocal / uniquelocal. Throws on an invalid entry.
 */
export function parseTrustedProxies(spec: string): ProxyTrust {
  const list = new BlockList();
  const entries = spec.split(/[\s,]+/).filter(Boolean);
  for (const entry of entries) {
    const named = NAMED_RANGES[entry.toLowerCase()];
    for (const item of named ?? [entry]) {
      const [addr, bitsRaw, extra] = item.split('/');
      const family = isIP(addr);
      if (!family || extra !== undefined) throw new Error(`invalid trusted proxy "${entry}"`);
      const max = family === 4 ? 32 : 128;
      const bits = bitsRaw === undefined ? max : Number(bitsRaw);
      if (!/^\d+$/.test(bitsRaw ?? String(max)) || bits > max) throw new Error(`invalid trusted proxy "${entry}"`);
      list.addSubnet(addr, bits, family === 4 ? 'ipv4' : 'ipv6');
    }
  }
  return {
    spec: entries.join(','),
    isTrusted(ip: string): boolean {
      const v = normalizeIp(ip);
      if (!v) return false;
      return list.check(v, isIP(v) === 4 ? 'ipv4' : 'ipv6');
    },
  };
}

/** The proxy trust in effect for a config: null when TRUST_PROXY is off. */
export function proxyTrustOf(config: { TRUST_PROXY: boolean; TRUSTED_PROXIES: ProxyTrust }): ProxyTrust | null {
  return config.TRUST_PROXY ? config.TRUSTED_PROXIES : null;
}

let defaultTrust: ProxyTrust | undefined;

/**
 * Client IP. Without proxy trust: the socket peer. With it: walk the chain
 * [X-Forwarded-For hops..., socket peer] from the right and return the first address that is
 * NOT a trusted proxy. Hops a client prepends itself are therefore never used unless every hop
 * to their right is a trusted proxy. A malformed hop stops the walk (the hop to its right wins).
 * `true` means the default trusted set (loopback + private networks).
 */
export function clientIp(req: Request, trust: ProxyTrust | boolean | null): string | null {
  const peer = normalizeIp(req.socket?.remoteAddress);
  if (trust === true) trust = defaultTrust ??= parseTrustedProxies(DEFAULT_TRUSTED_PROXIES);
  if (!trust || !peer || !trust.isTrusted(peer)) return peer;

  const raw = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(raw) ? raw.join(',') : raw ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  let ip = peer;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeIp(hops[i]);
    if (!hop) break;
    ip = hop;
    if (!trust.isTrusted(hop)) break;
  }
  return ip;
}

export function userAgent(req: Request): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 512) : null;
}
