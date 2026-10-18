/** CONTRACTS §5 request/response shapes. */
export interface EngineSubmitRequest {
  org_id: string;
  channel: 'HTTP' | 'WEB';
  source: string;
  destination: string;
  text: string;
  client_ref?: string;
  campaign_id?: string;
  route_id?: string;
  test?: boolean;
  /**
   * Message id chosen by the api (UUIDv7) so a retry of a submit whose outcome is unknown
   * (timeout / 5xx) is idempotent: the engine debits per message id (debit.lua DUPLICATE) and
   * answers a repeat with the original acceptance instead of sending again
   * (CONTRACTS-CHANGES "api fixes"). Engines that predate it ignore the field.
   */
  message_id?: string;
}

export interface EngineSubmitOk {
  message_id: string;
  status: string;
  parts: number;
  encoding: 'GSM7' | 'UCS2';
  cost_micros: number;
  route_id: string;
  sent_text: string;
}

export interface EngineErrorBody {
  error_code: string;
  message: string;
}

export type EngineBatchResult = EngineSubmitOk | EngineErrorBody;

export interface EngineTemplateInline {
  extract_patterns: string[];
  otp_min_len: number;
  otp_max_len: number;
  template_body: string;
  default_body: string | null;
  fallback_action: string | null;
  brand: string | null;
}

export interface EngineTemplatePreviewRequest {
  text: string;
  route_id?: string;
  org_id?: string;
  template?: EngineTemplateInline;
}

export interface EngineTemplatePreviewResponse {
  otp: string | null;
  matched_pattern: string | null;
  action: 'TEMPLATED' | 'SEND_RAW' | 'REJECT' | 'SEND_DEFAULT_TEMPLATE';
  output: string | null;
  encoding: 'GSM7' | 'UCS2';
  parts: number;
  template_id: string | null;
}

export interface EngineConnectionStatus {
  connection_id: string;
  name: string;
  enabled: boolean;
  /** HTTP connections (007): READY | ERROR | DISABLED. */
  state: 'BOUND' | 'CONNECTING' | 'DOWN' | 'DISABLED' | 'READY' | 'ERROR';
  /** Absent on engines that predate HTTP connections (= SMPP). */
  kind?: 'SMPP' | 'HTTP';
  adapter?: string | null;
  /** HTTP connections: last failed call. */
  last_error?: string | null;
  last_error_at?: string | null;
  last_success_at?: string | null;
  sessions: { index: number; state: string; bound_since: string | null; last_error: string | null }[];
  tps_limit: number;
  tps_current: number;
  inflight: number;
  queue_depth: number;
  submitted_total: number;
  failed_total: number;
}

export interface EngineSmppSession {
  session_id: string;
  org_id: string;
  system_id: string;
  bind_type: string;
  remote_addr: string;
  bound_since: string;
  tps_current: number;
  submitted_total: number;
}

export interface EngineCreditResponse {
  status: 'OK' | 'DUPLICATE' | 'NOT_LOADED';
  balance_micros: number | null;
}

export interface EngineBalanceResponse {
  balance_micros: number;
  credit_limit_micros: number;
  loaded: boolean;
}

export interface EngineHealthResponse {
  ok: boolean;
  db: boolean;
  redis: boolean;
}

// ---------------------------------------------------------------------------
// HTTP upstream connections (docs/providers/HTTP-CONNECTIONS-CONTRACT.md)
// ---------------------------------------------------------------------------

export type AdapterSettingType = 'url' | 'string' | 'number' | 'bool' | 'select' | (string & {});

export interface AdapterCredentialField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string | null;
  help?: string | null;
}

export interface AdapterSelectOption {
  value: string;
  label?: string;
}

export interface AdapterSettingField {
  key: string;
  label: string;
  type: AdapterSettingType;
  default?: unknown;
  /** For `select`: plain values or {value, label}. */
  options?: (string | AdapterSelectOption)[] | null;
  required: boolean;
  help?: string | null;
  placeholder?: string | null;
}

export interface EngineAdapter {
  id: string;
  name: string;
  country: string | null;
  website?: string | null;
  docs_url?: string | null;
  confidence: 'VERIFIED' | 'LIKELY' | (string & {});
  credentials: AdapterCredentialField[];
  settings: AdapterSettingField[];
  dlr_mode: 'none' | 'poll' | 'callback';
  supports_balance: boolean;
  /** null = any destination. */
  destination_countries: string[] | null;
  notes?: string | null;
}

export interface EngineTestSendResponse {
  ok: boolean;
  provider_message_id: string | null;
  http_status: number | null;
  request: { method: string; url: string; body: unknown } | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number | null;
}

export interface EngineProviderBalanceResponse {
  supported: boolean;
  balance: string | null;
  raw: string | null;
  error: string | null;
}

/** Verbatim provider callback, forwarded to POST /internal/v1/provider-dlr/:dlr_token. */
export interface EngineProviderDlrEnvelope {
  method: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body_base64: string;
}

/** A connection that can carry traffic: SMPP BOUND, or HTTP READY (last call ok / no calls yet). */
export function isConnectionUp(s: Pick<EngineConnectionStatus, 'state'>): boolean {
  return s.state === 'BOUND' || s.state === 'READY';
}
