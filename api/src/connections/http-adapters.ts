import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { AppError } from '../common/errors';
import { EngineClient } from '../engine/engine-client.service';
import type { AdapterSettingField, EngineAdapter } from '../engine/engine.types';

/**
 * HTTP upstream connections (docs/providers/HTTP-CONNECTIONS-CONTRACT.md): the adapter
 * catalogue (engine is the single source of truth, cached here) and the pure validation of
 * credentials / settings against it. Kept free of Nest/DB state so it is unit-testable.
 */

export interface FieldIssue {
  path: string;
  message: string;
  code: 'custom';
}

export const MAX_CREDENTIAL_LENGTH = 4096;
export const MAX_SETTING_STRING_LENGTH = 16_384;
export const DLR_CALLBACK_PATH = '/v1/provider-dlr/';
/** url-safe base64 alphabet; the api generates 43 chars (32 random bytes). */
export const DLR_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/** 32 random bytes, base64url (43 chars, no padding). */
export function generateDlrToken(): string {
  return randomBytes(32).toString('base64url');
}

/** credential / setting maps: values are checked against the adapter catalogue (mergeCredentials / mergeSettings). */
export const credentialMap = z.record(z.string().min(1).max(100), z.unknown()).refine((m) => Object.keys(m).length <= 50, 'at most 50 keys');
export const settingMap = credentialMap;
export const adapterId = z.string().trim().min(1, 'adapter is required').max(64);

const issue = (path: string, message: string): FieldIssue => ({ path, message, code: 'custom' });

export interface MergeResult<T> {
  merged: Record<string, T>;
  issues: FieldIssue[];
}

/**
 * Credentials are write-only strings. `input` keys: value = set, '' = clear, absent = unchanged
 * (PATCH merge; on create `existing` is {}). Unknown keys are rejected; required keys must be
 * non-empty after the merge.
 */
export function mergeCredentials(
  adapter: EngineAdapter,
  input: Record<string, unknown> | undefined,
  existing: Record<string, string>,
  pathPrefix = 'credentials',
): MergeResult<string> {
  const issues: FieldIssue[] = [];
  const known = new Map(adapter.credentials.map((f) => [f.key, f]));
  // Keys a previous adapter had but this one does not are dropped (adapter switch).
  const merged: Record<string, string> = Object.fromEntries(Object.entries(existing).filter(([k]) => known.has(k)));
  for (const [k, v] of Object.entries(input ?? {})) {
    if (!known.has(k)) {
      issues.push(issue(`${pathPrefix}.${k}`, `unknown credential “${k}” for ${adapter.name}`));
      continue;
    }
    if (v === null || v === '') {
      delete merged[k];
      continue;
    }
    if (typeof v !== 'string') {
      issues.push(issue(`${pathPrefix}.${k}`, 'must be a string'));
      continue;
    }
    if (v.length > MAX_CREDENTIAL_LENGTH) {
      issues.push(issue(`${pathPrefix}.${k}`, `must be at most ${MAX_CREDENTIAL_LENGTH} characters`));
      continue;
    }
    merged[k] = v;
  }
  for (const f of adapter.credentials) {
    if (issues.some((i) => i.path === `${pathPrefix}.${f.key}`)) continue;
    if (f.required && !merged[f.key]) issues.push(issue(`${pathPrefix}.${f.key}`, `${f.label || f.key} is required`));
  }
  return { merged, issues };
}

function selectValues(f: AdapterSettingField): string[] {
  return (f.options ?? []).map((o) => (typeof o === 'string' ? o : String(o.value)));
}

/** http(s) URL check that tolerates `{placeholder}` segments (generic_http url templates). */
export function isHttpUrlTemplate(v: string): boolean {
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    const u = new URL(v.replace(/\{[A-Za-z0-9_:./ -]*\}/g, 'x'));
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Validates one setting value against its catalogue type; returns an error message or null. */
export function settingError(f: AdapterSettingField, v: unknown): string | null {
  const urlLike = f.type === 'url' || f.key === 'url' || f.key.endsWith('_url');
  switch (f.type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : 'must be a number';
    case 'bool':
      return typeof v === 'boolean' ? null : 'must be true or false';
    case 'select': {
      const vals = selectValues(f);
      return typeof v === 'string' && vals.includes(v) ? null : `must be one of: ${vals.join(', ')}`;
    }
    case 'json': {
      if (typeof v === 'object' && v !== null) return null;
      if (typeof v !== 'string') return 'must be a JSON object';
      try {
        JSON.parse(v);
        return null;
      } catch {
        return 'must be valid JSON';
      }
    }
    default: {
      // url | string | (unknown future types: accept scalars as strings)
      if (typeof v !== 'string') {
        if (f.type !== 'url' && f.type !== 'string' && (typeof v === 'number' || typeof v === 'boolean')) return null;
        return 'must be a string';
      }
      if (v.length > MAX_SETTING_STRING_LENGTH) return `must be at most ${MAX_SETTING_STRING_LENGTH} characters`;
      if (urlLike && v !== '' && !isHttpUrlTemplate(v)) return 'must be an http:// or https:// URL';
      return null;
    }
  }
}

/**
 * Settings are non-secret. `input` keys: value = set, null = reset to the adapter default,
 * absent = unchanged (PATCH merge). Unknown keys are rejected. A required setting must end up
 * with a value or have a catalogue default. Empty strings on optional string/url settings reset
 * to the default (same as null).
 */
export function mergeSettings(
  adapter: EngineAdapter,
  input: Record<string, unknown> | undefined,
  existing: Record<string, unknown>,
  pathPrefix = 'settings',
): MergeResult<unknown> {
  const issues: FieldIssue[] = [];
  const known = new Map(adapter.settings.map((f) => [f.key, f]));
  const merged: Record<string, unknown> = Object.fromEntries(Object.entries(existing).filter(([k]) => known.has(k)));
  for (const [k, v] of Object.entries(input ?? {})) {
    const f = known.get(k);
    if (!f) {
      issues.push(issue(`${pathPrefix}.${k}`, `unknown setting “${k}” for ${adapter.name}`));
      continue;
    }
    if (v === null || v === undefined || (v === '' && f.type !== 'select')) {
      delete merged[k];
      continue;
    }
    const err = settingError(f, v);
    if (err) {
      issues.push(issue(`${pathPrefix}.${k}`, `${f.label || k} ${err}`));
      continue;
    }
    merged[k] = v;
  }
  for (const f of adapter.settings) {
    if (issues.some((i) => i.path === `${pathPrefix}.${f.key}`)) continue;
    const hasDefault = f.default !== undefined && f.default !== null && f.default !== '';
    if (f.required && !hasDefault && (merged[f.key] === undefined || merged[f.key] === '')) {
      issues.push(issue(`${pathPrefix}.${f.key}`, `${f.label || f.key} is required`));
    }
  }
  return { merged, issues };
}

export function throwIfIssues(issues: FieldIssue[], message = 'Request validation failed'): void {
  if (issues.length) throw AppError.invalid(message, { issues });
}

/**
 * Engine adapter catalogue, cached ADAPTER_CATALOGUE_TTL_MS (60s). Concurrent misses share one
 * engine call. A failed refresh never serves an error from cache; callers decide how to fail.
 */
@Injectable()
export class AdapterCatalogue {
  private readonly logger = new Logger(AdapterCatalogue.name);
  private cache: { at: number; adapters: EngineAdapter[] } | null = null;
  private inflight: Promise<EngineAdapter[]> | null = null;
  private readonly ttlMs: number;

  constructor(
    private readonly engine: EngineClient,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ttlMs = config.ADAPTER_CATALOGUE_TTL_MS;
  }

  /** Throws EngineUnavailableError (502) if the engine can't be reached and nothing fresh is cached. */
  async list(): Promise<EngineAdapter[]> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.adapters;
    if (!this.inflight) {
      this.inflight = this.engine
        .adapters()
        .then((adapters) => {
          this.cache = { at: Date.now(), adapters };
          return adapters;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  /** Cached catalogue without any network call (null when never loaded or expired). */
  peek(): EngineAdapter[] | null {
    return this.cache && Date.now() - this.cache.at < this.ttlMs ? this.cache.adapters : null;
  }

  /**
   * The adapter for validating a write. Engine unreachable → 502 with a clear message (we never
   * accept HTTP connection writes we could not validate); unknown id → 400 on `path`.
   */
  async require(id: string, path = 'adapter'): Promise<EngineAdapter> {
    let adapters: EngineAdapter[];
    try {
      adapters = await this.list();
    } catch (e) {
      this.logger.warn(`adapter catalogue unavailable: ${(e as Error).message}`);
      throw new AppError(
        'INTERNAL',
        'Cannot validate the HTTP connection: the engine adapter catalogue is unavailable. Check that the engine is running and try again.',
        { reason: 'ENGINE_UNAVAILABLE' },
        502,
      );
    }
    const a = adapters.find((x) => x.id === id);
    if (!a) throw AppError.invalid(`Unknown adapter “${id}”`, { issues: [issue(path, `unknown adapter “${id}”`)] });
    return a;
  }

  /** Test hook: forget the cache. */
  clear(): void {
    this.cache = null;
  }
}
