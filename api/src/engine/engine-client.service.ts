import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { AppError, isErrorCode } from '../common/errors';
import type {
  EngineBalanceResponse,
  EngineBatchResult,
  EngineConnectionStatus,
  EngineCreditResponse,
  EngineHealthResponse,
  EngineSmppSession,
  EngineSubmitOk,
  EngineSubmitRequest,
  EngineTemplatePreviewRequest,
  EngineTemplatePreviewResponse,
} from './engine.types';

/** Network failure / timeout / 5xx: the engine could not be reached or failed internally. */
export class EngineUnavailableError extends AppError {
  constructor(message: string) {
    super('INTERNAL', `Engine unavailable: ${message}`, undefined, 502);
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
        throw new EngineUnavailableError(`non-JSON response (HTTP ${res.status}) from ${path}`);
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
    throw new EngineUnavailableError(`HTTP ${res.status} from ${path}`);
  }
}

@Global()
@Module({ providers: [EngineClient], exports: [EngineClient] })
export class EngineModule {}
