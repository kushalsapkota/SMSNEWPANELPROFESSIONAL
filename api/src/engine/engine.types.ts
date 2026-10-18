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
  state: 'BOUND' | 'CONNECTING' | 'DOWN' | 'DISABLED';
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
