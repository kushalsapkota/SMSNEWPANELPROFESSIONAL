/**
 * Types for every request / response of the management REST API (CONTRACTS §10)
 * and the public API shapes the panel displays (§11).
 *
 * Field names are snake_case exactly as the api serializes them and match the
 * column names in db/migrations/*.sql. Money is always integer micros
 * (`*_micros`), timestamps are ISO-8601 strings, ids are UUID strings except
 * the bigint identity tables (balance_transactions, audit_logs,
 * webhook_deliveries) which are numbers.
 */

export type Uuid = string;
export type IsoDateTime = string;

/* ------------------------------------------------------------------ enums */

export type OrgRole = "SUPER_ADMIN" | "RESELLER" | "CLIENT";
export type OrgStatus = "ACTIVE" | "SUSPENDED" | "CLOSED";
export type BillingMode = "PREPAID" | "POSTPAID";
export type BindType = "TX" | "RX" | "TRX";
export type TemplateFallback = "REJECT" | "SEND_RAW" | "SEND_DEFAULT_TEMPLATE";
export type TemplateAction = "TEMPLATED" | "SEND_RAW" | "REJECT" | "SEND_DEFAULT_TEMPLATE";
export type IpScope = "API" | "SMPP" | "PANEL" | "ALL";
export type MsgChannel = "HTTP" | "SMPP" | "WEB";
export type MsgEncoding = "GSM7" | "UCS2";
export type MsgStatus =
  | "ACCEPTED"
  | "QUEUED"
  | "SUBMITTED"
  | "DELIVERED"
  | "UNDELIVERED"
  | "FAILED"
  | "EXPIRED"
  | "REJECTED"
  | "UNKNOWN";
export type LedgerType = "TOPUP" | "DEDUCT" | "ADJUSTMENT" | "REFUND" | "USAGE_SETTLEMENT";
export type SenderStatus = "PENDING" | "APPROVED" | "REJECTED";
export type CampaignStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";
export type MultipartMode = "UDH" | "SAR" | "PAYLOAD";
export type ConnectionState = "BOUND" | "CONNECTING" | "DOWN" | "DISABLED";
export type SessionState = "BOUND_TRX" | "CONNECTING" | "DOWN";

/** CONTRACTS §4 */
export type ErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "IP_NOT_ALLOWED"
  | "ACCOUNT_SUSPENDED"
  | "SENDING_DISABLED"
  | "CHANNEL_DISABLED"
  | "INSUFFICIENT_FUNDS"
  | "RATE_LIMITED"
  | "DAILY_LIMIT"
  | "MONTHLY_LIMIT"
  | "ROUTE_NOT_FOUND"
  | "SENDER_NOT_ALLOWED"
  | "OTP_NOT_FOUND"
  | "DESTINATION_BLOCKED"
  | "CONTENT_BLOCKED"
  | "INVALID_DESTINATION"
  | "MESSAGE_TOO_LONG"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL";

/* ----------------------------------------------------------- envelopes */

export interface ApiErrorBody {
  error_code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface CursorPage<T> {
  items: T[];
  next_cursor: string | null;
}

export type SortOrder = "asc" | "desc";

/** Common list query. `sort`/`order` are optional (see CONTRACTS-CHANGES). */
export interface PageParams {
  page?: number;
  page_size?: number;
  sort?: string;
  order?: SortOrder;
}

/** `?org_id=` for scoped endpoints (default = acting org). */
export interface ScopedParams {
  org_id?: Uuid;
}

/* ---------------------------------------------------------------- orgs */

export interface Org {
  id: Uuid;
  role: OrgRole;
  parent_id: Uuid | null;
  name: string;
  status: OrgStatus;
  suspended_reason: string | null;
  sending_enabled: boolean;
  api_enabled: boolean;
  smpp_enabled: boolean;
  web_enabled: boolean;
  max_tps: number;
  daily_limit: number | null;
  monthly_limit: number | null;
  brand_name: string | null;
  whitelabel_domain: string | null;
  timezone: string;
  settings?: Record<string, unknown>;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export type OrgBalanceSummary = Pick<OrgBalance, "balance_micros" | "credit_limit_micros" | "billing_mode" | "currency">;

/** Row of GET /api/orgs (org + joined balance + number of direct children). */
export interface OrgListItem extends Org {
  balance: OrgBalanceSummary | null;
  child_count: number;
}

/** app.org_effective_state (parent state folded in). */
export interface OrgEffectiveState {
  is_active: boolean;
  can_send: boolean;
  can_api: boolean;
  can_smpp: boolean;
  effective_max_tps: number;
}

export interface OrgCounts {
  users: number;
  api_keys: number;
  smpp_accounts: number;
  webhooks: number;
  sender_ids: number;
  /** RESELLER only */
  clients?: number;
  /** SUPER_ADMIN only */
  resellers?: number;
}

/** GET /api/orgs/:id → org + effective state + balance + counts */
export interface OrgDetail extends Org {
  /** True values (parent folded in); null if the view row is missing. */
  effective_state: OrgEffectiveState | null;
  /** null for SUPER_ADMIN (never billed) */
  balance: OrgBalance | null;
  counts: OrgCounts;
}

/** POST /api/orgs response. */
export interface CreateOrgResponse extends Org {
  owner: User;
  balance: OrgBalance;
}

export interface OrgListParams extends PageParams {
  role?: "RESELLER" | "CLIENT";
  q?: string;
  status?: OrgStatus;
  parent_id?: Uuid;
}

export interface CreateOrgRequest {
  name: string;
  email: string;
  password: string;
  full_name?: string;
  brand_name?: string;
  max_tps?: number;
  daily_limit?: number;
  monthly_limit?: number;
  billing_mode?: BillingMode;
  credit_limit_micros?: number;
  currency?: string;
  timezone?: string;
}

export interface UpdateOrgRequest {
  name?: string;
  brand_name?: string | null;
  max_tps?: number;
  daily_limit?: number | null;
  monthly_limit?: number | null;
  timezone?: string;
  whitelabel_domain?: string | null;
}

export interface SuspendOrgRequest {
  reason: string;
}

export interface UpdateChannelsRequest {
  sending_enabled?: boolean;
  api_enabled?: boolean;
  smpp_enabled?: boolean;
  web_enabled?: boolean;
}

/* --------------------------------------------------------------- users */

export interface User {
  id: Uuid;
  org_id: Uuid;
  email: string;
  full_name: string | null;
  is_active: boolean;
  totp_enabled: boolean;
  last_login_at: IsoDateTime | null;
  last_login_ip?: string | null;
  locked_until?: IsoDateTime | null;
  password_changed_at?: IsoDateTime;
  created_at: IsoDateTime;
}

export interface CreateUserRequest {
  email: string;
  password: string;
  full_name?: string;
}

export interface ResetPasswordRequest {
  new_password: string;
}

export interface UpdateUserRequest {
  is_active?: boolean;
  full_name?: string | null;
}

/* ------------------------------------------------------------- balance */

export interface OrgBalance {
  balance_micros: number;
  credit_limit_micros: number;
  billing_mode: BillingMode;
  currency: string;
  low_balance_alert_micros: number | null;
  org_id?: Uuid;
  /** "engine" = live Redis value, "database" = last synced value */
  source?: "engine" | "database";
  synced_at?: IsoDateTime | null;
}

export interface TopupRequest {
  /** > 0 */
  amount_micros: number;
  note?: string;
  reference?: string;
  /** replay-safe: the same key returns the same ledger row */
  idempotency_key?: string;
}

export interface AdjustRequest {
  /** signed, != 0 */
  amount_micros: number;
  note: string;
  reference?: string;
  idempotency_key?: string;
}

export interface UpdateBillingRequest {
  billing_mode?: BillingMode;
  credit_limit_micros?: number;
  low_balance_alert_micros?: number | null;
}

export interface BalanceTransaction {
  id: number;
  org_id: Uuid;
  type: LedgerType;
  amount_micros: number;
  balance_after_micros: number | null;
  idempotency_key?: string | null;
  reference: string | null;
  note: string | null;
  created_by_user_id: Uuid | null;
  created_by_email?: string | null;
  applied_at: IsoDateTime | null;
  created_at: IsoDateTime;
}

/** Result of topup/adjust. */
export interface BalanceMutationResponse {
  transaction: BalanceTransaction;
  status: "OK" | "DUPLICATE" | "NOT_LOADED";
  /** true when the idempotency_key matched an earlier request */
  replay: boolean;
}

/* --------------------------------------------------- route assignments */

export interface RouteAssignment {
  id: Uuid;
  route_id: Uuid;
  route_name: string;
  prefix: string;
  rate_micros: number;
  priority: number;
  enabled: boolean;
  /**
   * What the parent pays for the same route/prefix:
   * CLIENT target → its reseller's rate; RESELLER target → upstream route cost.
   * null when unknown.
   */
  parent_rate_micros: number | null;
}

export interface RouteAssignmentInput {
  route_id: Uuid;
  prefix: string;
  rate_micros: number;
  priority: number;
  enabled: boolean;
}

/* --------------------------------------------------------------- auth */

export interface LoginRequest {
  email: string;
  password: string;
  totp_code?: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type?: "Bearer";
  /** access token lifetime in seconds */
  expires_in?: number;
}

export interface LoginSuccess extends TokenPair {
  user: User;
  org: Org;
}

export interface LoginTotpRequired {
  requires_totp: true;
}

export type LoginResponse = LoginSuccess | LoginTotpRequired;

export interface RefreshRequest {
  refresh_token: string;
}

export interface LogoutRequest {
  refresh_token: string;
}

export interface MeResponse {
  user: User;
  org: Org;
  impersonating: boolean;
  original_org?: Org | null;
  /** Effective whitelabel brand (own brand_name, else reseller's). Optional. */
  brand_name?: string | null;
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

export interface TotpSetupResponse {
  secret: string;
  otpauth_url: string;
}

export interface TotpCodeRequest {
  code: string;
}

export interface TotpEnableResponse {
  recovery_codes: string[];
}

export interface ImpersonateRequest {
  org_id: Uuid;
}

/** Decoded access-token claims (CONTRACTS §10). */
export interface JwtClaims {
  sub: Uuid;
  org: Uuid;
  role: OrgRole;
  imp?: Uuid;
  oid?: Uuid;
  exp: number;
  iat?: number;
}

/* --------------------------------------------------------- connections */

export interface Connection {
  id: Uuid;
  name: string;
  host: string;
  port: number;
  use_tls: boolean;
  system_id: string;
  system_type: string;
  bind_type: BindType;
  sessions: number;
  max_tps: number;
  window_size: number;
  enquire_link_interval_s: number;
  reconnect_min_s: number;
  reconnect_max_s: number;
  submit_timeout_ms: number;
  request_dlr: boolean;
  multipart_mode: MultipartMode;
  default_data_coding: number;
  enabled: boolean;
  notes: string | null;
  /** password_enc is never returned */
  has_password?: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/** GET /api/connections/:id adds the routes using it. */
export interface ConnectionDetail extends Connection {
  routes?: Array<{ route_id: Uuid; route_name: string; priority: number; weight: number; enabled: boolean }>;
}

/** POST body; `password` is write-only (plaintext ≤ 8 chars). */
export interface CreateConnectionRequest {
  name: string;
  host: string;
  port: number;
  use_tls?: boolean;
  system_id: string;
  password: string;
  system_type?: string;
  bind_type?: BindType;
  sessions?: number;
  max_tps: number;
  window_size?: number;
  enquire_link_interval_s?: number;
  reconnect_min_s?: number;
  reconnect_max_s?: number;
  submit_timeout_ms?: number;
  request_dlr?: boolean;
  multipart_mode?: MultipartMode;
  default_data_coding?: number;
  enabled?: boolean;
  notes?: string | null;
}

/** PATCH body; omit `password` to keep the current one. */
export type UpdateConnectionRequest = Partial<CreateConnectionRequest>;

export interface ConnectionRate {
  id?: Uuid;
  prefix: string;
  cost_micros: number;
  effective_from?: IsoDateTime;
}

export interface ConnectionRateInput {
  prefix: string;
  cost_micros: number;
}

export interface ConnectionListParams extends PageParams {
  q?: string;
  enabled?: boolean;
}

/* -------------------------------------------------------------- routes */

export interface Route {
  id: Uuid;
  name: string;
  description: string | null;
  enabled: boolean;
  template_mode: boolean;
  template_fallback: TemplateFallback;
  force_sender_id: string | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  connection_count?: number;
  enabled_connection_count?: number;
  assigned_org_count?: number;
}

export interface RouteConnection {
  connection_id: Uuid;
  connection_name?: string;
  connection_enabled?: boolean;
  /** GET /api/routes/:id adds the upstream endpoint (never the password). */
  host?: string;
  port?: number;
  use_tls?: boolean;
  system_id?: string;
  priority: number;
  weight: number;
  enabled: boolean;
}

export interface RouteDetail extends Route {
  connections: RouteConnection[];
}

/** GET /api/routes for RESELLER / CLIENT: assigned routes only. */
export interface AssignedRoute {
  id: Uuid;
  name: string;
  template_mode: boolean;
}

export interface CreateRouteRequest {
  name: string;
  description?: string | null;
  enabled?: boolean;
  template_mode?: boolean;
  template_fallback?: TemplateFallback;
  force_sender_id?: string | null;
}

export type UpdateRouteRequest = Partial<CreateRouteRequest>;

export interface RouteConnectionInput {
  connection_id: Uuid;
  priority: number;
  weight: number;
  enabled: boolean;
}

/** POST /api/routes/quick: one connection row — an existing connection or a new SMPP one. */
export interface QuickExistingConnectionInput {
  existing_connection_id: Uuid;
  priority?: number;
  weight?: number;
}

export interface QuickSmppConnectionInput {
  type: "SMPP";
  name?: string;
  host: string;
  port: number;
  system_id: string;
  password: string;
  system_type?: string;
  bind_type?: BindType;
  use_tls?: boolean;
  max_tps?: number;
  sessions?: number;
  window_size?: number;
  enquire_link_interval_s?: number;
  multipart_mode?: MultipartMode;
  request_dlr?: boolean;
  priority?: number;
  weight?: number;
  /** Default rate (prefix '') for this connection. */
  cost_micros?: number;
}

export type QuickConnectionInput = QuickExistingConnectionInput | QuickSmppConnectionInput;

export interface QuickRouteRequest {
  name: string;
  description?: string | null;
  enabled?: boolean;
  template_mode?: boolean;
  template_fallback?: TemplateFallback;
  force_sender_id?: string | null;
  /** Required when template_mode; must contain {otp}. Creates the route-wide template. */
  template_body?: string;
  default_body?: string | null;
  connections: QuickConnectionInput[];
}

export interface QuickRouteResponse extends Route {
  template: RouteTemplate | null;
  connections: Array<RouteConnection & { created: boolean; connection: Connection }>;
}

/** UNKNOWN = engine unreachable or the connection is not loaded by the engine yet. */
export type RouteConnectionState = ConnectionState | "UNKNOWN";

export interface RouteConnectionStatus {
  connection_id: Uuid;
  connection_name: string;
  connection_enabled: boolean;
  host: string;
  port: number;
  use_tls: boolean;
  system_id: string;
  bind_type: BindType;
  priority: number;
  weight: number;
  enabled: boolean;
  state: RouteConnectionState;
  sessions: ConnectionSessionStatus[];
  sessions_bound: number;
  sessions_total: number;
  bound_since: IsoDateTime | null;
  last_error: string | null;
  tps_limit: number | null;
  tps_current: number | null;
  inflight: number | null;
  queue_depth: number | null;
}

/** GET /api/routes/:id/status */
export interface RouteStatusResponse {
  route_id: Uuid;
  route_enabled: boolean;
  engine_reachable: boolean;
  engine_error: string | null;
  checked_at: IsoDateTime;
  connections: RouteConnectionStatus[];
}

export interface RouteListParams extends PageParams {
  q?: string;
  enabled?: boolean;
}

/* ----------------------------------------------------------- templates */

export interface RouteTemplate {
  id: Uuid;
  route_id: Uuid;
  route_name?: string;
  org_id: Uuid | null;
  org_name?: string | null;
  name: string;
  extract_patterns: string[];
  otp_min_len: number;
  otp_max_len: number;
  template_body: string;
  default_body: string | null;
  fallback_action: TemplateFallback | null;
  brand: string | null;
  is_active: boolean;
  /** client read-only view: this is the effective template for the route */
  effective?: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface CreateTemplateRequest {
  route_id: Uuid;
  /** null / omitted = route-wide (admin); set = per-client override (reseller). */
  org_id?: Uuid | null;
  name: string;
  extract_patterns?: string[];
  otp_min_len?: number;
  otp_max_len?: number;
  template_body: string;
  default_body?: string | null;
  fallback_action?: TemplateFallback | null;
  brand?: string | null;
  is_active?: boolean;
}

export type UpdateTemplateRequest = Partial<Omit<CreateTemplateRequest, "route_id" | "org_id">>;

export interface TemplateListParams extends PageParams {
  route_id?: Uuid;
  org_id?: Uuid;
}

export interface InlineTemplate {
  extract_patterns: string[];
  otp_min_len: number;
  otp_max_len: number;
  template_body: string;
  default_body: string | null;
  fallback_action: TemplateFallback | null;
  brand: string | null;
}

export interface TemplatePreviewRequest {
  text: string;
  route_id?: Uuid;
  org_id?: Uuid;
  template?: InlineTemplate;
}

export interface TemplatePreviewResponse {
  otp: string | null;
  matched_pattern: string | null;
  action: TemplateAction;
  output: string | null;
  encoding: MsgEncoding;
  parts: number;
  template_id: Uuid | null;
}

/* -------------------------------------------------------- credentials */

export interface SenderId {
  id: Uuid;
  org_id: Uuid;
  org_name?: string;
  route_id: Uuid | null;
  route_name?: string | null;
  sender: string;
  status: SenderStatus;
  reviewed_by: Uuid | null;
  reviewed_at: IsoDateTime | null;
  created_at: IsoDateTime;
}

export interface SenderIdListParams extends PageParams, ScopedParams {
  status?: SenderStatus;
  /** List sender IDs of the acting org's child orgs (approval queue). */
  include_children?: boolean;
  q?: string;
}

export interface CreateSenderIdRequest {
  sender: string;
  route_id?: Uuid | null;
}

export interface ApiKey {
  id: Uuid;
  org_id: Uuid;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: IsoDateTime | null;
  expires_at: IsoDateTime | null;
  revoked_at: IsoDateTime | null;
  created_at: IsoDateTime;
}

export type ApiKeyScope = "sms:send" | "sms:read" | "balance:read";

export interface ApiKeyListParams extends PageParams, ScopedParams {
  include_revoked?: boolean;
}

export interface CreateApiKeyRequest {
  name: string;
  scopes?: string[];
  expires_at?: IsoDateTime | null;
}

/** POST /api/api-keys — `key` is returned exactly once. */
export interface CreateApiKeyResponse extends ApiKey {
  key: string;
}

export interface SmppAccount {
  id: Uuid;
  org_id: Uuid;
  system_id: string;
  allowed_bind_types: BindType[];
  max_binds: number;
  max_tps: number | null;
  enabled: boolean;
  last_bind_at: IsoDateTime | null;
  last_bind_ip: string | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface CreateSmppAccountRequest {
  system_id: string;
  /** ≤ 8 chars (SMPP 3.4) */
  password: string;
  max_binds?: number;
  max_tps?: number | null;
  allowed_bind_types?: BindType[];
}

export interface UpdateSmppAccountRequest {
  max_binds?: number;
  max_tps?: number | null;
  allowed_bind_types?: BindType[];
  enabled?: boolean;
}

export interface SmppPasswordRequest {
  password: string;
}

export interface IpWhitelistEntry {
  id: Uuid;
  org_id: Uuid;
  cidr: string;
  scope: IpScope;
  note: string | null;
  created_by_user_id?: Uuid | null;
  created_at: IsoDateTime;
}

export interface CreateIpWhitelistRequest {
  cidr: string;
  scope: IpScope;
  note?: string;
}

export type WebhookEvent = "dlr" | (string & {});

export interface Webhook {
  id: Uuid;
  org_id: Uuid;
  url: string;
  events: WebhookEvent[];
  max_retries: number;
  enabled: boolean;
  failure_count: number;
  last_failure_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface CreateWebhookRequest {
  url: string;
  events?: WebhookEvent[];
  max_retries?: number;
}

/** POST /api/webhooks — signing `secret` is returned exactly once. */
export interface CreateWebhookResponse extends Webhook {
  secret: string;
}

export interface UpdateWebhookRequest {
  url?: string;
  events?: WebhookEvent[];
  max_retries?: number;
  enabled?: boolean;
  /** issue a new signing secret (returned once in `secret`) */
  rotate_secret?: boolean;
}

export interface UpdateWebhookResponse extends Webhook {
  secret?: string;
}

export interface WebhookTestResponse {
  ok: boolean;
  status_code: number | null;
  error: string | null;
  duration_ms: number | null;
  response_body?: string | null;
  delivery_id?: number | null;
  payload?: Record<string, unknown>;
}

export interface WebhookDelivery {
  id: number;
  webhook_id: Uuid;
  org_id: Uuid;
  message_id: Uuid | null;
  attempt: number;
  status_code: number | null;
  error: string | null;
  duration_ms: number | null;
  created_at: IsoDateTime;
}

/* ----------------------------------------------------------- blocklist */

export interface BlockedNumber {
  id: Uuid;
  /** null = global (admin) */
  org_id: Uuid | null;
  org_name?: string | null;
  prefix: string;
  note: string | null;
  created_at: IsoDateTime;
}

export interface BlockedKeyword {
  id: Uuid;
  org_id: Uuid | null;
  org_name?: string | null;
  /** RE2, case-insensitive */
  pattern: string;
  note: string | null;
  created_at: IsoDateTime;
}

export interface CreateBlockedNumberRequest {
  prefix: string;
  note?: string;
}

export interface CreateBlockedKeywordRequest {
  pattern: string;
  note?: string;
}

export interface BlocklistParams extends PageParams, ScopedParams {
  q?: string;
}

/* ------------------------------------------------------- notifications */

export interface NotificationSettings {
  org_id?: Uuid;
  updated_at?: IsoDateTime | null;
  email_enabled: boolean;
  email_to: string[];
  telegram_enabled: boolean;
  telegram_chat_id: string | null;
  low_balance: boolean;
  route_down: boolean;
}

/* ---------------------------------------------------- messages/reports */

export interface SendMessageRequest {
  to: string | string[];
  from: string;
  text: string;
  route_id?: Uuid;
}

export interface SendResultOk {
  to: string;
  message_id: Uuid;
  status: MsgStatus;
  parts: number;
  cost_micros: number;
}

export interface SendResultError {
  to: string;
  error_code: ErrorCode;
  message: string;
}

export type SendResult = SendResultOk | SendResultError;

export interface SendMessageResponse {
  messages: SendResult[];
}

export interface MessageLog {
  id: Uuid;
  created_at: IsoDateTime;
  org_id: Uuid;
  org_name?: string;
  reseller_id: Uuid | null;
  route_id: Uuid | null;
  route_name?: string | null;
  connection_id: Uuid | null;
  connection_name?: string | null;
  template_id: Uuid | null;
  campaign_id: Uuid | null;
  channel: MsgChannel;
  client_msg_ref: string | null;
  source_addr: string | null;
  destination_addr: string;
  country_iso: string | null;
  mccmnc: string | null;
  orig_text: string;
  sent_text: string | null;
  otp_extracted: boolean | null;
  encoding: MsgEncoding;
  parts: number;
  status: MsgStatus;
  smsc_msg_ids: string[];
  error_code: string | null;
  dlr_stat: string | null;
  dlr_err: string | null;
  client_rate_micros: number | null;
  client_cost_micros: number | null;
  reseller_cost_micros: number | null;
  route_cost_micros: number | null;
  refunded: boolean;
  submitted_at: IsoDateTime | null;
  dlr_received_at: IsoDateTime | null;
}

export interface MessageListParams extends ScopedParams {
  from_date?: string;
  to_date?: string;
  /** one status or a comma-separated list ("FAILED,REJECTED") */
  status?: MsgStatus | string;
  campaign_id?: Uuid;
  destination?: string;
  source?: string;
  route_id?: Uuid;
  channel?: MsgChannel;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface AnalyticsParams extends ScopedParams {
  from?: string;
  to?: string;
  route_id?: Uuid;
}

export interface AnalyticsSummary {
  messages: number;
  parts: number;
  delivered: number;
  failed: number;
  pending: number;
  delivery_rate: number;
  revenue_micros: number;
  cost_micros: number;
  profit_micros: number;
  /** CLIENT only: what it was charged (= cost_micros) */
  spend_micros?: number;
}

export interface TimeseriesParams extends AnalyticsParams {
  granularity?: "hour" | "day";
  /** IANA zone for day buckets (default: the org's timezone) */
  tz?: string;
}

export interface TimeseriesPoint {
  /** bucket start instant */
  t: IsoDateTime;
  /** calendar day of the bucket (YYYY-MM-DD) in the response timezone */
  date?: string;
  messages: number;
  delivered: number;
  failed: number;
  revenue_micros: number;
  cost_micros?: number;
  /** CLIENT only */
  spend_micros?: number;
}

export interface AnalyticsTimeseries {
  granularity?: "hour" | "day";
  timezone?: string;
  points: TimeseriesPoint[];
}

export interface BreakdownParams extends AnalyticsParams {
  by: "route" | "country" | "org" | "status";
}

export interface BreakdownRow {
  key: string;
  label: string;
  messages: number;
  delivered: number;
  failed: number;
  delivery_rate: number;
  revenue_micros: number;
  cost_micros: number;
  /** share of all messages (status breakdown), 0..1 */
  share?: number;
  profit_micros?: number;
  /** CLIENT only */
  spend_micros?: number;
}

export interface AnalyticsBreakdown {
  rows: BreakdownRow[];
}

export interface AnalyticsLive {
  /** null when the engine metrics endpoint is unreachable */
  tps_in: number | null;
  inflight?: number;
  connections_enabled?: number;
  tps_out: number;
  queue_depth: number;
  connections_up: number;
  connections_total: number;
}

/* -------------------------------------------------------------- tester */

export interface TesterSendRequest {
  route_id: Uuid;
  destination: string;
  text: string;
  source: string;
}

/** Engine submit 200 body (CONTRACTS §5). */
export interface SubmitResult {
  message_id: Uuid;
  status: MsgStatus;
  parts: number;
  encoding: MsgEncoding;
  cost_micros: number;
  route_id: Uuid;
  sent_text: string;
}

export interface TesterTimings {
  accepted_at: IsoDateTime | null;
  submitted_at: IsoDateTime | null;
  dlr_received_at: IsoDateTime | null;
  submit_latency_ms: number | null;
  dlr_latency_ms: number | null;
  total_latency_ms?: number | null;
}

export interface TesterResult {
  message: MessageLog;
  timings: TesterTimings;
}

/* ----------------------------------------------------------- campaigns */

export interface Campaign {
  id: Uuid;
  org_id: Uuid;
  name: string;
  source_addr: string;
  body: string;
  status: CampaignStatus;
  scheduled_at: IsoDateTime | null;
  started_at: IsoDateTime | null;
  finished_at: IsoDateTime | null;
  total: number;
  submitted: number;
  failed: number;
  created_by_user_id: Uuid | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  /** recipients not yet submitted or failed */
  pending?: number;
  /** POST response only: import report */
  import?: {
    columns: string[];
    invalid_rows: number;
    duplicate_rows: number;
    errors: Array<{ row: number; phone: string; reason: string }>;
  };
}

/** GET /api/campaigns/:id/recipients row */
export interface CampaignRecipient {
  seq: number;
  destination: string;
  vars: Record<string, string>;
  message_id: Uuid | null;
  error_code: string | null;
}

export interface CampaignRecipientsParams extends PageParams {
  state?: "pending" | "submitted" | "failed";
}

export interface CampaignRecipientInput {
  phone: string;
  [variable: string]: string;
}

export interface CreateCampaignJsonRequest {
  name: string;
  source_addr: string;
  body: string;
  recipients: CampaignRecipientInput[];
  scheduled_at?: IsoDateTime | null;
}

/** Multipart variant: fields + CSV file (header must include "phone"). */
export interface CreateCampaignUploadRequest {
  file: File;
  name: string;
  source_addr: string;
  body: string;
  scheduled_at?: IsoDateTime | null;
}

export interface CampaignListParams extends PageParams, ScopedParams {
  status?: CampaignStatus;
}

/* -------------------------------------------------------------- audit */

export interface AuditLog {
  id: number;
  created_at: IsoDateTime;
  actor_user_id: Uuid | null;
  actor_email?: string | null;
  actor_org_id: Uuid | null;
  actor_org_name?: string | null;
  impersonator_user_id: Uuid | null;
  impersonator_email?: string | null;
  target_org_id: Uuid | null;
  target_org_name?: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
}

export interface AuditLogParams extends PageParams, ScopedParams {
  /** exact action, or a prefix ending in "*" (e.g. "client.*") */
  action?: string;
  entity_type?: string;
  /** ISO-8601 with offset */
  from?: string;
  to?: string;
}

/* ----------------------------------------------------------- dashboard */

export interface DashboardDay {
  date: string;
  messages: number;
  delivered: number;
  failed: number;
  revenue_micros?: number;
  cost_micros?: number;
  /** CLIENT only (instead of revenue/cost) */
  spend_micros?: number;
}

export interface DashboardResponse {
  /** null for SUPER_ADMIN (never billed) */
  balance: OrgBalance | null;
  today: { messages: number; delivered: number; failed: number };
  last7d: DashboardDay[];
  timezone?: string;
  counts: {
    resellers?: number;
    clients?: number;
    routes?: number;
    /** null when the engine is unreachable */
    connections_up?: number | null;
    connections_total?: number | null;
    api_keys?: number;
    campaigns_active?: number;
  };
}

/* ------------------------------------------------------------- monitor */

export interface ConnectionSessionStatus {
  index: number;
  state: SessionState;
  bound_since: IsoDateTime | null;
  last_error: string | null;
}

export interface ConnectionStatus {
  connection_id: Uuid;
  name: string;
  enabled: boolean;
  state: ConnectionState;
  sessions: ConnectionSessionStatus[];
  tps_limit: number;
  tps_current: number;
  inflight: number;
  queue_depth: number;
  submitted_total: number;
  failed_total: number;
}

export interface ConnectionsStatusResponse {
  connections: ConnectionStatus[];
}

export interface SmppSession {
  session_id: string;
  org_id: Uuid;
  org_name?: string;
  system_id: string;
  bind_type: BindType;
  remote_addr: string;
  bound_since: IsoDateTime;
  tps_current: number;
  submitted_total: number;
}

export interface SmppSessionsResponse {
  sessions: SmppSession[];
}

/* ------------------------------------------------------- public (§11) */

export interface PublicMessageStatus {
  message_id: Uuid;
  to: string;
  from: string;
  status: MsgStatus;
  dlr_stat: string | null;
  parts: number;
  cost_micros: number;
  created_at: IsoDateTime;
  submitted_at: IsoDateTime | null;
  done_at: IsoDateTime | null;
  client_ref: string | null;
}

export interface PublicBalance {
  balance_micros: number;
  currency: string;
}

/** Generic `{ok:true}`-ish acknowledgement; the panel ignores the body. */
export type Ack = Record<string, unknown> | null;
