import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';

interface Sample {
  at: number;
  total: number;
}

/** Sums every sample of a Prometheus counter family in text exposition format. */
export function sumCounter(text: string, name: string): number | null {
  let total = 0;
  let seen = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name) || line.startsWith('#')) continue;
    const rest = line.slice(name.length);
    if (rest[0] !== '{' && rest[0] !== ' ') continue; // a different metric sharing the prefix
    const value = Number(rest.slice(rest.lastIndexOf('}') + 1).trim().split(/\s+/)[0]);
    if (Number.isFinite(value)) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

/**
 * Incoming submit rate (tps_in) from the engine's Prometheus endpoint (CONTRACTS §1, :9100):
 * the rate of `smsgw_submit_total` between two scrapes. The previous sample is kept, so
 * dashboard polling gets the rate over its own polling interval; a cold (or >60s old)
 * sample takes a second scrape one second later. Returns null when metrics are unreachable.
 */
@Injectable()
export class EngineMetricsService {
  private readonly logger = new Logger(EngineMetricsService.name);
  private readonly url: string;
  private last: Sample | null = null;
  private lastRate: number | null = null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    if (config.ENGINE_METRICS_URL) this.url = config.ENGINE_METRICS_URL;
    else {
      const u = new URL(config.ENGINE_URL);
      this.url = `${u.protocol}//${u.hostname}:9100/metrics`;
    }
  }

  async submitRate(): Promise<number | null> {
    let cur = await this.scrape();
    if (!cur) return null;
    let prev = this.last;
    if (!prev || cur.at - prev.at > 60_000) {
      prev = cur;
      await new Promise((r) => setTimeout(r, 1000));
      cur = await this.scrape();
      if (!cur) return null;
    }
    const dt = (cur.at - prev.at) / 1000;
    if (dt < 0.5) return this.lastRate ?? 0;
    this.last = cur;
    // A counter reset (engine restart) shows up as a negative delta.
    this.lastRate = cur.total >= prev.total ? (cur.total - prev.total) / dt : 0;
    return this.lastRate;
  }

  private async scrape(): Promise<Sample | null> {
    try {
      const res = await fetch(this.url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      const total = sumCounter(await res.text(), 'smsgw_submit_total');
      return total === null ? null : { at: Date.now(), total };
    } catch (e) {
      this.logger.debug?.(`engine metrics unavailable: ${(e as Error).message}`);
      return null;
    }
  }
}
