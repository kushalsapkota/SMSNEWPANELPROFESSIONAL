import { request as httpRequest } from 'node:http';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/errors';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config.module';

export interface FirewallRule {
  action: 'allow' | 'deny';
  proto: 'tcp' | 'udp' | 'any';
  port: number | null;
  source: string | null;
}

export interface FirewallState {
  enabled: boolean;
  default_policy: 'allow' | 'deny';
  rules: FirewallRule[];
}

export interface FirewallStatus extends FirewallState {
  /** false when no agent token is configured (container not deployed). */
  available: boolean;
  protected_tcp_ports: number[];
  pending_revert: boolean;
  revert_in_seconds: number;
  table_active: boolean;
}

/**
 * Admin-only bridge to the privileged firewall-agent (host netns + CAP_NET_ADMIN) over its Unix
 * socket. The agent owns the `inet smsgw` nftables table, always keeps SSH/panel/SMPP reachable,
 * and auto-reverts any applied ruleset unless committed — so a bad rule can't lock the box out.
 */
@Injectable()
export class FirewallService {
  private readonly logger = new Logger(FirewallService.name);
  private readonly socketPath: string;
  private readonly token: string | undefined;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.socketPath = config.FW_AGENT_SOCKET;
    this.token = config.FW_AGENT_TOKEN;
  }

  get configured(): boolean {
    return !!this.token;
  }

  async status(): Promise<FirewallStatus> {
    if (!this.configured) {
      return {
        available: false,
        enabled: false,
        default_policy: 'deny',
        rules: [],
        protected_tcp_ports: [],
        pending_revert: false,
        revert_in_seconds: 0,
        table_active: false,
      };
    }
    const s = await this.call('GET', '/status');
    return { available: true, ...(s as object) } as FirewallStatus;
  }

  async apply(state: FirewallState): Promise<FirewallStatus> {
    const s = await this.call('POST', '/apply', state);
    return { available: true, ...(s as object) } as FirewallStatus;
  }

  async commit(): Promise<FirewallStatus> {
    const s = await this.call('POST', '/commit');
    return { available: true, ...(s as object) } as FirewallStatus;
  }

  async revert(): Promise<FirewallStatus> {
    const s = await this.call('POST', '/revert');
    return { available: true, ...(s as object) } as FirewallStatus;
  }

  private call(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.configured) throw new AppError('INTERNAL', 'Firewall agent is not configured', undefined, 503);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          path,
          method,
          timeout: 20_000,
          headers: {
            'X-Fw-Token': this.token as string,
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
              return reject(new AppError('INTERNAL', 'Firewall agent returned a non-JSON response', undefined, 502));
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) return resolve(json);
            const msg = (json as { error?: string; message?: string }).error ?? (json as { message?: string }).message ?? `agent HTTP ${status}`;
            return reject(new AppError(status === 400 ? 'INVALID_REQUEST' : 'INTERNAL', `Firewall: ${msg}`, undefined, status === 400 ? 400 : 502));
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => {
        this.logger.warn(`firewall agent unreachable: ${e.message}`);
        reject(new AppError('INTERNAL', 'Firewall agent is unreachable', undefined, 503));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}
