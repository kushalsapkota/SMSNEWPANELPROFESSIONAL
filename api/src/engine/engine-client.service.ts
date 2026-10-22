import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { AppError, isErrorCode } from '../common/errors';
import type {
  EngineBalanceResponse,
  EngineBatchResult,
  EngineConnectionStatus,
  EngineCreditResponse,
  EngineAdapter,
  EngineBindEvent,
  EngineHealthResponse,
  EngineProviderBalanceResponse,
  EngineProviderDlrEnvelope,
  EngineTestSendResponse,
  EngineSmppSession,
  EngineSubmitOk,
  EngineSubmitRequest,
  EngineTemplatePreviewRequest,
  EngineTemplatePreviewResponse,
} from './engine.types';

/** Network failure / timeout / 5xx: the engine could not be reached or failed internally. */
export class EngineUnavailableError extends AppError {
  /** The engine's HTTP status when it answered (non-contract 4xx / 5xx); undefined on network errors. */
  readonly upstreamStatus?: number;

  constructor(message: string, upstreamStatus?: number) {
    super('INTERNAL', `Engine unavailable: ${message}`, undefined, 502);
    this.upstreamStatus = upstreamStatus;
  }
}

/**
 * The only way the api talks to the engine (CONTRACTS §5). Engine 4xx bodies with a
 * contract error_code are rethrown as AppError with the same code and HTTP status.
 */
@Injectable()
export class EngineClient {
  private readonly logger = new Logger(EngineClient.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.baseUrl = config.ENGINE_URL;
    this.token = config.INTERNAL_TOKEN;
    this.timeoutMs = config.ENGINE_TIMEOUT_MS;
  }

  submit(body: EngineSubmitRequest): Promise<EngineSubmitOk> {
    return this.request('POST', '/internal/v1/submit', body);
  }

  async submitBatch(items: EngineSubmitRequest[]): Promise<EngineBatchResult[]> {
    const r = await this.request<{ results: EngineBatchResult[] }>('POST', '/internal/v1/submit/batch', { items }, 30_000);
    return r.results;
  }

  templatePreview(body: EngineTemplatePreviewRequest): Promise<EngineTemplatePreviewResponse> {
    return this.request('POST', '/internal/v1/template/preview', body);
  }

  async connectionsStatus(): Promise<EngineConnectionStatus[]> {
    const r = await this.request<{ connections: EngineConnectionStatus[] }>('GET', '/internal/v1/connections/status');
    return r.connections;
  }

  async smppSessions(): Promise<EngineSmppSession[]> {
    const r = await this.request<{ sessions: EngineSmppSession[] }>('GET', '/internal/v1/smpp/sessions');
    return r.sessions;
  }

  async smppEvents(limit = 500): Promise<EngineBindEvent[]> {
    const r = await this.request<{ events: EngineBindEvent[] }>('GET', `/internal/v1/smpp/events?limit=${encodeURIComponent(String(limit))}`);
    return r.events;
  }

  async kickSmppSessions(orgId: string): Promise<number> {
    const r = await this.request<{ kicked: number }>('POST', '/internal/v1/smpp/sessions/kick', { org_id: orgId });
    return r.kicked;
  }

  /** Best-effort kick used after suspend / SMPP disable / password rotation; never throws. */
  async kickQuietly(orgId: string): Promise<number | null> {
    try {
      return await this.kickSmppSessions(orgId);
    } catch (e) {
      this.logger.warn(`SMPP kick for org ${orgId} failed: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Synchronous engine config reload (CONTRACTS-CHANGES integration #2). cfg:invalidate is
   * debounced on the engine side; org state changes call this after commit so they are
   * enforced (SMPP binds, submits) by the time the management response is sent.
   */
  async reloadConfig(): Promise<number> {
    const r = await this.request<{ version: number }>('POST', '/internal/v1/config/reload');
    return r.version;
  }

  /** Best-effort reload; the pubsub invalidation still applies the change if this fails. */
  async reloadConfigQuietly(): Promise<number | null> {
    try {
      return await this.reloadConfig();
    } catch (e) {
      this.logger.warn(`engine config reload failed: ${(e as Error).message}`);
      return null;
    }
  }

  creditBalance(orgId: string, deltaMicros: number, idempotencyKey: string): Promise<EngineCreditResponse> {
    return this.request('POST', '/internal/v1/balance/credit', {
      org_id: orgId,
      delta_micros: deltaMicros,
      idempotency_key: idempotencyKey,
    });
  }

  getBalance(orgId: string): Promise<EngineBalanceResponse> {
    return this.request('GET', `/internal/v1/balance/${encodeURIComponent(orgId)}`);
  }

  /** HTTP adapter catalogue (engine is the single source of truth). Cached by AdapterCatalogue. */
  async adapters(): Promise<EngineAdapter[]> {
    const r = await this.request<{ adapters: EngineAdapter[] }>('GET', '/internal/v1/adapters');
    if (!r || !Array.isArray(r.adapters)) throw new EngineUnavailableError('malformed adapter catalogue');
    return r.adapters;
  }

  /** Sends ONE real message through the connection outside billing/CDR (secrets masked in the echo). */
  testConnection(id: string, body: { to: string; text: string }): Promise<EngineTestSendResponse> {
    // A provider can take up to the engine's 10s outbound timeout (+ retries): allow more than the default.
    return this.request('POST', `/internal/v1/connections/${encodeURIComponent(id)}/test`, body, Math.max(this.timeoutMs, 30_000));
  }

  providerBalance(id: string): Promise<EngineProviderBalanceResponse> {
    return this.request('GET', `/internal/v1/connections/${encodeURIComponent(id)}/balance`, undefined, Math.max(this.timeoutMs, 15_000));
  }

  /** Forwards a provider DLR callback verbatim. Engine 404 (unknown token) surfaces as AppError NOT_FOUND. */
  providerDlr(dlrToken: string, envelope: EngineProviderDlrEnvelope): Promise<{ accepted: number }> {
    return this.request('POST', `/internal/v1/provider-dlr/${encodeURIComponent(dlrToken)}`, envelope);
  }

  health(): Promise<EngineHealthResponse> {
    return this.request('GET', '/internal/v1/health', undefined, 2000);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          'X-Internal-Token': this.token,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      throw new EngineUnavailableError(err.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : err.message);
    }
    const text = await res.text();
    let json: unknown = undefined;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new EngineUnavailableError(`non-JSON response (HTTP ${res.status}) from ${path}`, res.status);
      }
    }
    if (res.ok) return json as T;
    const errBody = json as { error_code?: unknown; message?: unknown } | undefined;
    if (res.status < 500 && errBody && isErrorCode(errBody.error_code)) {
      throw new AppError(
        errBody.error_code,
        typeof errBody.message === 'string' ? errBody.message : errBody.error_code,
        undefined,
        res.status,
      );
    }
    throw new EngineUnavailableError(`HTTP ${res.status} from ${path}`, res.status);
  }
}

@Global()
@Module({ providers: [EngineClient], exports: [EngineClient] })
export class EngineModule {}
