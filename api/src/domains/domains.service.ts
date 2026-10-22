import { request as httpRequest } from 'node:http';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/errors';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config.module';

export type DomainRole = 'panel' | 'smpp' | 'both';

export interface DomainCert {
  exists: boolean;
  expires: string | null;
}

export interface DomainEntry {
  domain: string;
  role: DomainRole;
  enabled: boolean;
  cert: DomainCert;
  added_at: string | null;
}

export interface DomainsStatus {
  /** false when no agent token is configured (host agent not installed). */
  available: boolean;
  nginx_ok: boolean;
  domains: DomainEntry[];
}

/**
 * Admin-only bridge to the privileged host domain-agent (systemd, owns nginx + certbot) over its
 * Unix socket. The agent only ever writes its own `smsgw-managed-<domain>` vhosts, issues the
 * Let's Encrypt cert, runs `nginx -t` before every reload, and rolls back on failure — so the
 * hand-written panel/SMPP edge can't be broken from the panel.
 */
@Injectable()
export class DomainsService {
  private readonly logger = new Logger(DomainsService.name);
  private readonly socketPath: string;
  private readonly token: string | undefined;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.socketPath = config.DOMAIN_AGENT_SOCKET;
    this.token = config.DOMAIN_AGENT_TOKEN;
  }

  get configured(): boolean {
    return !!this.token;
  }

  async status(): Promise<DomainsStatus> {
    if (!this.configured) {
      return { available: false, nginx_ok: false, domains: [] };
    }
    const s = await this.call('GET', '/status');
    return { available: true, ...(s as object) } as DomainsStatus;
  }

  async add(body: { domain: string; role: DomainRole }): Promise<{ ok: true; domain: string; role: DomainRole }> {
    return this.call('POST', '/add', body) as Promise<{ ok: true; domain: string; role: DomainRole }>;
  }

  async remove(domain: string): Promise<{ ok: true; domain: string }> {
    return this.call('POST', '/remove', { domain }) as Promise<{ ok: true; domain: string }>;
  }

  private call(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.configured) throw new AppError('INTERNAL', 'Domain agent is not configured', undefined, 503);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          path,
          method,
          // certbot issuance can take a while; give the agent generous headroom.
          timeout: 200_000,
          headers: {
            'X-Domain-Token': this.token as string,
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: unknown;
            try {
              json = text ? JSON.parse(text) : {};
            } catch {
              return reject(new AppError('INTERNAL', 'Domain agent returned a non-JSON response', undefined, 502));
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) return resolve(json);
            const msg =
              (json as { error?: string; message?: string }).error ??
              (json as { message?: string }).message ??
              `agent HTTP ${status}`;
            return reject(
              new AppError(status === 400 ? 'INVALID_REQUEST' : 'INTERNAL', `Domains: ${msg}`, undefined, status === 400 ? 400 : 502),
            );
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => {
        this.logger.warn(`domain agent unreachable: ${e.message}`);
        reject(new AppError('INTERNAL', 'Domain agent is unreachable', undefined, 503));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}
