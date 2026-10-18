import { LookupAddress, lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, LookupFunction, isIP } from 'node:net';
import { AppError } from '../common/errors';

/**
 * SSRF protection for webhook targets (client-controlled URLs fetched from inside the
 * platform network). A target must resolve only to public unicast addresses: loopback,
 * RFC 1918, CGNAT, link-local (cloud metadata), unique-local, multicast, reserved,
 * documentation and NAT64/6to4-embedded private addresses are refused. Checked when the
 * webhook is saved AND again on the address actually connected to (custom DNS lookup), so a
 * DNS answer that changes after validation (rebinding) can't reach an internal service.
 */
const BLOCKED_V4 = [
  '0.0.0.0/8', // "this" network
  '10.0.0.0/8', // RFC 1918
  '100.64.0.0/10', // CGNAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local (cloud metadata 169.254.169.254)
  '172.16.0.0/12', // RFC 1918
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1
  '192.88.99.0/24', // 6to4 relay anycast
  '192.168.0.0/16', // RFC 1918
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved + broadcast
];
const BLOCKED_V6 = [
  '::/128', // unspecified
  '::1/128', // loopback
  '100::/64', // discard
  '2001:db8::/32', // documentation
  'fc00::/7', // unique local
  'fe80::/10', // link-local
  'fec0::/10', // site-local (deprecated)
  'ff00::/8', // multicast
];

const blocked = new BlockList();
for (const c of BLOCKED_V4) {
  const [a, b] = c.split('/');
  blocked.addSubnet(a, Number(b), 'ipv4');
}
for (const c of BLOCKED_V6) {
  const [a, b] = c.split('/');
  blocked.addSubnet(a, Number(b), 'ipv6');
}

/** IPv4 embedded in an IPv6 address by a translation scheme, if any. */
function embeddedV4(v6: string): string | null {
  const groups = expandV6(v6);
  if (!groups) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zero = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  if (zero(0, 5) && groups[5] === 0xffff) return v4(groups[6], groups[7]); // ::ffff:a.b.c.d (mapped)
  if (zero(0, 6)) return v4(groups[6], groups[7]); // ::a.b.c.d (compatible, deprecated)
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return v4(groups[6], groups[7]); // 64:ff9b::/96 NAT64
  if (groups[0] === 0x2002) return v4(groups[1], groups[2]); // 6to4
  return null;
}

function expandV6(addr: string): number[] | null {
  let a = addr.toLowerCase();
  const pct = a.indexOf('%');
  if (pct >= 0) a = a.slice(0, pct);
  // trailing dotted quad
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) {
    const p = dotted[1].split('.').map(Number);
    if (p.some((n) => n > 255)) return null;
    a = a.slice(0, -dotted[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array(fill).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  const nums = parts.map((h) => parseInt(h, 16));
  return nums.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : nums;
}

/** True when `ip` is not a public unicast address. Non-IP input counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return blocked.check(ip, 'ipv4');
  if (fam === 6) {
    const v4 = embeddedV4(ip);
    if (v4) return isBlockedAddress(v4);
    return blocked.check(ip.split('%')[0], 'ipv6');
  }
  return true;
}

function hostOf(url: URL): string {
  // WHATWG URL keeps IPv6 literals in brackets.
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

function lookupAll(host: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));
}

export interface EgressPolicy {
  /** WEBHOOK_ALLOW_PRIVATE_TARGETS=1: dev/test only (local receivers). */
  allowPrivate: boolean;
}

/** Save-time check: 400 INVALID_REQUEST unless every address the host resolves to is public. */
export async function assertWebhookTarget(raw: string, policy: EgressPolicy): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw AppError.invalid('url must be a valid http(s) URL', { field: 'url' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw AppError.invalid('url must use http or https', { field: 'url' });
  if (url.username || url.password) throw AppError.invalid('url must not contain credentials', { field: 'url' });
  if (policy.allowPrivate) return;
  const host = hostOf(url);
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await lookupAll(host)).map((a) => a.address);
    } catch {
      throw AppError.invalid(`url host "${host}" does not resolve`, { field: 'url' });
    }
  }
  if (addrs.length === 0 || addrs.some(isBlockedAddress)) {
    throw AppError.invalid('url must point to a public internet address (private, loopback, link-local and reserved ranges are not allowed)', {
      field: 'url',
    });
  }
}

export class BlockedTargetError extends Error {
  readonly code = 'EBLOCKEDTARGET';
  constructor(host: string, address: string) {
    super(`webhook target ${host} resolves to a non-public address (${address})`);
  }
}

/** DNS lookup for the actual connection: fails if the answer contains a non-public address. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs) => {
    if (err) return (callback as (e: Error) => void)(err);
    const list = addrs as LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad || list.length === 0) return (callback as (e: Error) => void)(new BlockedTargetError(hostname, bad?.address ?? 'none'));
    if ((options as { all?: boolean }).all) return (callback as (e: null, a: LookupAddress[]) => void)(null, list);
    (callback as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
  });
};

export interface EgressResponse {
  status: number;
}

/**
 * POSTs `body` to `raw` with the egress policy enforced at connect time. No redirects are
 * followed and the response body is discarded (never shown to the caller).
 */
export function postWebhook(raw: string, headers: Record<string, string>, body: string, timeoutMs: number, policy: EgressPolicy): Promise<EgressResponse> {
  const url = new URL(raw);
  const host = hostOf(url);
  if (!policy.allowPrivate && isIP(host) && isBlockedAddress(host)) return Promise.reject(new BlockedTargetError(host, host));
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
        lookup: policy.allowPrivate ? undefined : guardedLookup,
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        // Only the status matters; the body is never read (nor returned to the caller).
        resolve({ status: res.statusCode ?? 0 });
        res.destroy();
      },
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`timeout after ${timeoutMs}ms`), { name: 'TimeoutError' })), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('timeout', () => req.destroy(Object.assign(new Error(`timeout after ${timeoutMs}ms`), { name: 'TimeoutError' })));
    req.on('error', reject);
    req.end(body);
  });
}
