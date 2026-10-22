import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config.module';
import { RedisService } from '../redis/redis.module';

export interface GeoLocation {
  country: string | null;
  country_code: string | null;
  city: string | null;
  isp: string | null;
}

/**
 * Resolves a bind IP to a coarse location (country/city/ISP) for the live SMPP sessions view.
 * Results are cached in Redis (IPs are stable), private/reserved addresses are never looked up,
 * and every failure is swallowed so the monitor still renders when the provider is down or
 * GEOIP_ENABLED is off. The IP sent out is a public address of a client already connected to the
 * gateway; disable GEOIP_ENABLED (or point GEOIP_ENDPOINT at a self-hosted service) to keep it in.
 */
@Injectable()
export class GeoIpService {
  private readonly logger = new Logger(GeoIpService.name);
  private readonly enabled: boolean;
  private readonly endpoint: string;
  private readonly ttl: number;

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) cfg: AppConfig,
  ) {
    this.enabled = cfg.GEOIP_ENABLED;
    this.endpoint = cfg.GEOIP_ENDPOINT;
    this.ttl = cfg.GEOIP_CACHE_TTL_S;
  }

  /**
   * Looks up a batch of `ip:port` (or bare IP) strings, returning a map keyed by the ORIGINAL
   * input string → location (or null when unknown/private/disabled).
   */
  async locate(remoteAddrs: string[]): Promise<Map<string, GeoLocation | null>> {
    const out = new Map<string, GeoLocation | null>();
    if (remoteAddrs.length === 0) return out;

    // original addr -> bare public IP (undefined when private/invalid/absent)
    const ipFor = new Map<string, string | undefined>();
    for (const addr of remoteAddrs) if (!ipFor.has(addr)) ipFor.set(addr, publicIp(addr));
    const uniqueIps = [...new Set([...ipFor.values()].filter((ip): ip is string => !!ip))];

    if (!this.enabled || uniqueIps.length === 0) {
      for (const addr of ipFor.keys()) out.set(addr, null);
      return out;
    }

    const byIp = new Map<string, GeoLocation | null>();
    let cached: (string | null)[] = [];
    try {
      cached = await this.redis.client.mget(uniqueIps.map((ip) => `geoip:${ip}`));
    } catch {
      cached = uniqueIps.map(() => null);
    }
    const misses: string[] = [];
    uniqueIps.forEach((ip, i) => {
      const hit = cached[i];
      if (hit != null) {
        try {
          byIp.set(ip, JSON.parse(hit) as GeoLocation);
        } catch {
          byIp.set(ip, null);
        }
      } else {
        misses.push(ip);
      }
    });

    await Promise.all(
      misses.map(async (ip) => {
        const loc = await this.fetch(ip);
        byIp.set(ip, loc);
        // Cache negatives too (shorter) so a bad/unroutable IP isn't re-queried every refresh.
        try {
          await this.redis.client.set(`geoip:${ip}`, JSON.stringify(loc), 'EX', loc ? this.ttl : Math.min(this.ttl, 3600));
        } catch {
          /* cache best-effort */
        }
      }),
    );

    for (const [addr, ip] of ipFor) out.set(addr, ip ? (byIp.get(ip) ?? null) : null);
    return out;
  }

  private async fetch(ip: string): Promise<GeoLocation | null> {
    const url = this.endpoint.replace('{ip}', encodeURIComponent(ip));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      const j = (await res.json()) as Record<string, unknown>;
      if (typeof j.status === 'string' && j.status !== 'success') return null; // ip-api.com failure
      const str = (...keys: string[]): string | null => {
        for (const k of keys) {
          const v = j[k];
          if (typeof v === 'string' && v.trim() !== '') return v.trim();
        }
        return null;
      };
      const loc: GeoLocation = {
        country: str('country'),
        country_code: str('countryCode', 'country_code', 'country'),
        city: str('city', 'region'),
        isp: str('isp', 'org'),
      };
      return loc.country || loc.city || loc.isp ? loc : null;
    } catch (e) {
      this.logger.debug(`geoip lookup failed for ${ip}: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Strips the port from an `ip:port`/`[ipv6]:port` string and returns the IP only when it's public. */
export function publicIp(addr: string | undefined | null): string | undefined {
  if (!addr) return undefined;
  let host = addr.trim();
  const v6 = host.match(/^\[(.+)\]:\d+$/);
  if (v6) {
    host = v6[1];
  } else if (host.includes('.') && host.lastIndexOf(':') > host.indexOf('.')) {
    host = host.slice(0, host.lastIndexOf(':')); // ipv4:port
  }
  if (!host || isPrivateIp(host)) return undefined;
  return host;
}

function isPrivateIp(ip: string): boolean {
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::' || low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true;
  const octets = ip.split('.');
  if (octets.length === 4) {
    const [a, b] = octets.map((n) => Number(n));
    if (![a, b].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return true; // malformed → don't query
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  return false;
}
