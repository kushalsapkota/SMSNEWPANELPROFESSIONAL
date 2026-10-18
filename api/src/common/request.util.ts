import type { Request } from 'express';
import { isIP } from 'node:net';

function normalizeIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  let v = ip.trim();
  if (v.startsWith('::ffff:') && isIP(v.slice(7)) === 4) v = v.slice(7);
  return isIP(v) ? v : null;
}

/** Client IP: first X-Forwarded-For hop when TRUST_PROXY=1, else the socket peer. */
export function clientIp(req: Request, trustProxy: boolean): string | null {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0];
    const ip = normalizeIp(first);
    if (ip) return ip;
  }
  return normalizeIp(req.socket?.remoteAddress);
}

export function userAgent(req: Request): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 512) : null;
}
