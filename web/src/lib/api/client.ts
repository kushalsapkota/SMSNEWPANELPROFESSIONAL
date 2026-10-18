import { isExpiringSoon, tokenStore } from "@/lib/auth/token-store";
import type { ApiErrorBody, ErrorCode, TokenPair } from "./types";

/**
 * Low-level HTTP client for the management API.
 *
 * - Same-origin requests to /api/* (next.config rewrites them to API_URL).
 * - Adds `Authorization: Bearer <access>`.
 * - On 401 (or an access token about to expire) it refreshes ONCE for all
 *   concurrent callers (single-flight) and retries the original request.
 * - When refresh fails the session is cleared and `onSessionExpired`
 *   listeners fire (the AuthProvider redirects to /login).
 * - Non-2xx responses throw `ApiError` carrying the contract's error_code.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | "NETWORK_ERROR" | "UNKNOWN";
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: ApiError["code"],
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Human-readable message for any thrown value (used by toasts / error states). */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message || e.code;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  query?: object;
  body?: unknown;
  signal?: AbortSignal;
  /** default true; false for login/refresh which must not trigger refresh loops */
  auth?: boolean;
  /** return the raw Response (CSV downloads etc.) */
  raw?: boolean;
  headers?: Record<string, string>;
}

const sessionExpiredListeners = new Set<() => void>();

export function onSessionExpired(listener: () => void): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

export function buildQuery(query?: object): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, String(v)));
    else params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

let refreshPromise: Promise<TokenPair | null> | null = null;

async function doRefresh(refresh_token: string): Promise<TokenPair | null> {
  try {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refresh_token }),
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const pair = (await res.json()) as TokenPair;
    if (!pair.access_token || !pair.refresh_token) return null;
    return pair;
  } catch {
    return null;
  }
}

/**
 * Single-flight refresh: every caller that hits a 401 while a refresh is in
 * progress awaits the same promise, so the rotating refresh token is only
 * spent once.
 */
export function refreshTokens(): Promise<TokenPair | null> {
  if (refreshPromise) return refreshPromise;
  const current = tokenStore.get();
  if (!current) return Promise.resolve(null);
  refreshPromise = doRefresh(current.refresh_token)
    .then((pair) => {
      if (pair) {
        tokenStore.set(pair);
      } else {
        // Another tab may have rotated the token already; accept it if it changed.
        const latest = tokenStore.get();
        if (latest && latest.refresh_token !== current.refresh_token) return latest;
        tokenStore.clear();
        sessionExpiredListeners.forEach((l) => l());
      }
      return pair;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    const text = await res.text();
    body = text ? (JSON.parse(text) as Partial<ApiErrorBody>) : null;
  } catch {
    body = null;
  }
  const code = (body?.error_code as ErrorCode | undefined) ?? defaultCode(res.status);
  const message =
    typeof body?.message === "string" && body.message
      ? body.message
      : `${res.status} ${res.statusText || "Request failed"}`;
  return new ApiError(res.status, code, message, body?.details);
}

function defaultCode(status: number): ApiError["code"] {
  switch (status) {
    case 400:
      return "INVALID_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    default:
      return status >= 500 ? "INTERNAL" : "UNKNOWN";
  }
}

async function send(method: string, path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  if (opts.auth !== false) {
    const tokens = tokenStore.get();
    if (tokens) headers.Authorization = `Bearer ${tokens.access_token}`;
  }
  try {
    return await fetch(path + buildQuery(opts.query), {
      method,
      headers,
      body,
      signal: opts.signal,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "NETWORK_ERROR", "Network error: the API is unreachable");
  }
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  if (opts.auth !== false) {
    const tokens = tokenStore.get();
    if (tokens && isExpiringSoon(tokens.access_token)) await refreshTokens();
  }
  let res = await send(method, path, opts);
  if (res.status === 401 && opts.auth !== false && tokenStore.get()) {
    const pair = await refreshTokens();
    if (pair) res = await send(method, path, opts);
  }
  if (!res.ok) throw await parseError(res);
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return null as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const http = {
  get: <T>(path: string, opts?: Omit<RequestOptions, "body">) => request<T>("GET", path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("POST", path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("PUT", path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("PATCH", path, { ...opts, body }),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, opts),
};

/** Set-style endpoints return a bare array; tolerate a paginated envelope too. */
export function asArray<T>(value: T[] | { items: T[] } | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : value.items ?? [];
}
