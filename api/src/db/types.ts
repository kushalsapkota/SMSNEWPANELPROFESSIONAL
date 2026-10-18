/**
 * Hand-written Kysely table types. MUST mirror db/migrations/ (001-006) exactly
 * (column names, nullability, defaults). Update this file whenever a migration
 * changes a table.
 *
 * Runtime representation (see db.module.ts for the pg type parsers):
 *   uuid / text / citext / varchar / inet / cidr  -> string
 *   bigint (int8)                                 -> number (micros fit in 2^53)
 *   timestamptz                                   -> Date
 *   bytea                                         -> Buffer
 *   jsonb                                         -> unknown JSON value
 *   text[]                                        -> string[]
 *   enum[] (bind_type[])                          -> select it with ::text[] (pg can't parse custom enum arrays)
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export type Int8 = ColumnType<number, number | bigint | string, number | bigint | string>;
export type GeneratedInt8 = ColumnType<number, never, never>; // GENERATED ALWAYS AS IDENTITY
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type Json = ColumnType<unknown, string | Record<string, unknown> | unknown[], string | Record<string, unknown> | unknown[]>;
export type DefaultJson = ColumnType<
  unknown,
  string | Record<string, unknown> | unknown[] | undefined,
  string | Record<string, unknown> | unknown[]
>;

// ---------------------------------------------------------------------------
// Enums (001_init.sql, 004_features.sql)
// ---------------------------------------------------------------------------

export const ORG_ROLES = ['SUPER_ADMIN', 'RESELLER', 'CLIENT'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export const ORG_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];
export const BILLING_MODES = ['PREPAID', 'POSTPAID'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
export const BIND_TYPES = ['TX', 'RX', 'TRX'] as const;
export type BindType = (typeof BIND_TYPES)[number];
export const TEMPLATE_FALLBACKS = ['REJECT', 'SEND_RAW', 'SEND_DEFAULT_TEMPLATE'] as const;
export type TemplateFallback = (typeof TEMPLATE_FALLBACKS)[number];
export const IP_SCOPES = ['API', 'SMPP', 'PANEL', 'ALL'] as const;
export type IpScope = (typeof IP_SCOPES)[number];
export const MSG_CHANNELS = ['HTTP', 'SMPP', 'WEB'] as const;
export type MsgChannel = (typeof MSG_CHANNELS)[number];
export const MSG_ENCODINGS = ['GSM7', 'UCS2'] as const;
export type MsgEncoding = (typeof MSG_ENCODINGS)[number];
export const MSG_STATUSES = [
  'ACCEPTED',
  'QUEUED',
  'SUBMITTED',
  'DELIVERED',
  'UNDELIVERED',
  'FAILED',
  'EXPIRED',
  'REJECTED',
  'UNKNOWN',
] as const;
export type MsgStatus = (typeof MSG_STATUSES)[number];
export const LEDGER_TYPES = ['TOPUP', 'DEDUCT', 'ADJUSTMENT', 'REFUND', 'USAGE_SETTLEMENT'] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];
export const SENDER_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type SenderStatus = (typeof SENDER_STATUSES)[number];
export const CAMPAIGN_STATUSES = ['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const MULTIPART_MODES = ['UDH', 'SAR', 'PAYLOAD'] as const;
export type MultipartMode = (typeof MULTIPART_MODES)[number];

// ---------------------------------------------------------------------------
// 001_init.sql
// ---------------------------------------------------------------------------

export interface OrganizationsTable {
  id: ColumnType<string, string | undefined, never>;
  role: ColumnType<OrgRole, OrgRole, never>; // immutable (trigger)
  parent_id: string | null;
  name: string;
  status: ColumnType<OrgStatus, OrgStatus | undefined, OrgStatus>;
  suspended_reason: string | null;
  sending_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  api_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  smpp_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  web_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  max_tps: ColumnType<number, number | undefined, number>;
  daily_limit: number | null;
  monthly_limit: number | null;
  brand_name: string | null;
  whitelabel_domain: string | null;
  timezone: ColumnType<string, string | undefined, string>;
  settings: DefaultJson;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

/** View app.org_effective_state (security_invoker). */
export interface OrgEffectiveStateView {
  id: string;
  role: OrgRole;
  parent_id: string | null;
  is_active: boolean;
  can_send: boolean;
  can_api: boolean;
  can_smpp: boolean;
  effective_max_tps: number;
}

export interface UsersTable {
  id: Generated<string>;
  org_id: string;
  email: string;
  password_hash: string;
  full_name: string | null;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  totp_secret_enc: Buffer | null;
  totp_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  totp_recovery_hashes: ColumnType<string[], string[] | undefined, string[]>;
  failed_login_count: ColumnType<number, number | undefined, number>;
  locked_until: Timestamp | null;
  last_login_at: Timestamp | null;
  last_login_ip: string | null;
  password_changed_at: DefaultTimestamp;
  /** 006: last accepted TOTP step (unix seconds / 30); a code is accepted only once. */
  totp_last_step: number | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  family_id: string;
  token_hash: Buffer;
  replaced_by: string | null;
  impersonated_org_id: string | null;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  revoked_reason: string | null;
  created_ip: string | null;
  user_agent: string | null;
  created_at: DefaultTimestamp;
}

export interface AccountsBalanceTable {
  org_id: string;
  billing_mode: ColumnType<BillingMode, BillingMode | undefined, BillingMode>;
  balance_micros: ColumnType<number, number | bigint | string | undefined, number | bigint | string>;
  credit_limit_micros: ColumnType<number, number | bigint | string | undefined, number | bigint | string>;
  currency: ColumnType<string, string | undefined, string>;
  low_balance_alert_micros: Int8 | null;
  synced_at: Timestamp | null;
  updated_at: DefaultTimestamp;
}

export interface BalanceTransactionsTable {
  id: GeneratedInt8;
  org_id: string;
  type: LedgerType;
  amount_micros: Int8;
  balance_after_micros: Int8 | null;
  idempotency_key: string | null;
  reference: string | null;
  note: string | null;
  created_by_user_id: string | null;
  applied_at: Timestamp | null;
  created_at: DefaultTimestamp;
}

export interface UpstreamConnectionsTable {
  id: Generated<string>;
  name: string;
  host: string;
  port: number;
  use_tls: ColumnType<boolean, boolean | undefined, boolean>;
  system_id: string;
  password_enc: string;
  system_type: ColumnType<string, string | undefined, string>;
  bind_type: ColumnType<BindType, BindType | undefined, BindType>;
  sessions: ColumnType<number, number | undefined, number>;
  max_tps: number;
  window_size: ColumnType<number, number | undefined, number>;
  enquire_link_interval_s: ColumnType<number, number | undefined, number>;
  reconnect_min_s: ColumnType<number, number | undefined, number>;
  reconnect_max_s: ColumnType<number, number | undefined, number>;
  submit_timeout_ms: ColumnType<number, number | undefined, number>;
  request_dlr: ColumnType<boolean, boolean | undefined, boolean>;
  multipart_mode: ColumnType<MultipartMode, MultipartMode | undefined, MultipartMode>;
  default_data_coding: ColumnType<number, number | undefined, number>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  notes: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface UpstreamRatesTable {
  id: Generated<string>;
  connection_id: string;
  prefix: ColumnType<string, string | undefined, string>;
  cost_micros: Int8;
  effective_from: DefaultTimestamp;
}

export interface RoutesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  template_mode: ColumnType<boolean, boolean | undefined, boolean>;
  template_fallback: ColumnType<TemplateFallback, TemplateFallback | undefined, TemplateFallback>;
  force_sender_id: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface RouteConnectionsTable {
  route_id: string;
  connection_id: string;
  priority: ColumnType<number, number | undefined, number>;
  weight: ColumnType<number, number | undefined, number>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface RouteTemplatesTable {
  id: Generated<string>;
  route_id: string;
  org_id: string | null;
  name: string;
  extract_patterns: ColumnType<string[], string[] | undefined, string[]>;
  otp_min_len: ColumnType<number, number | undefined, number>;
  otp_max_len: ColumnType<number, number | undefined, number>;
  template_body: string;
  default_body: string | null;
  fallback_action: TemplateFallback | null;
  brand: string | null;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface OrgRouteAssignmentsTable {
  id: Generated<string>;
  org_id: string;
  route_id: string;
  prefix: ColumnType<string, string | undefined, string>;
  rate_micros: Int8;
  priority: ColumnType<number, number | undefined, number>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface SenderIdsTable {
  id: Generated<string>;
  org_id: string;
  route_id: string | null;
  sender: string;
  status: ColumnType<SenderStatus, SenderStatus | undefined, SenderStatus>;
  reviewed_by: string | null;
  reviewed_at: Timestamp | null;
  created_at: DefaultTimestamp;
}

export interface ApiKeysTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  key_prefix: string;
  key_hash: Buffer;
  scopes: ColumnType<string[], string[] | undefined, string[]>;
  last_used_at: Timestamp | null;
  expires_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_by_user_id: string | null;
  created_at: DefaultTimestamp;
}

export interface SmppAccountsTable {
  id: Generated<string>;
  org_id: string;
  system_id: string;
  password_hash: string;
  /** bind_type[]: select with sql`allowed_bind_types::text[]` — pg returns enum arrays as raw literals. */
  allowed_bind_types: ColumnType<BindType[], BindType[] | undefined, BindType[]>;
  max_binds: ColumnType<number, number | undefined, number>;
  max_tps: number | null;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  last_bind_at: Timestamp | null;
  last_bind_ip: string | null;
  /** 006: set when the parent created/updated it; the org itself may then only tighten it. */
  locked_by_parent: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface IpWhitelistsTable {
  id: Generated<string>;
  org_id: string;
  cidr: string;
  scope: ColumnType<IpScope, IpScope | undefined, IpScope>;
  note: string | null;
  created_by_user_id: string | null;
  /** 006: real org of the creator (parent rows can't be removed by the org itself). */
  created_by_org_id: string | null;
  created_at: DefaultTimestamp;
}

export interface WebhooksTable {
  id: Generated<string>;
  org_id: string;
  url: string;
  secret_enc: string;
  events: ColumnType<string[], string[] | undefined, string[]>;
  max_retries: ColumnType<number, number | undefined, number>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  failure_count: ColumnType<number, number | undefined, number>;
  last_failure_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface AuditLogsTable {
  id: GeneratedInt8;
  created_at: DefaultTimestamp;
  actor_user_id: string | null;
  actor_org_id: string | null;
  impersonator_user_id: string | null;
  target_org_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before: Json | null;
  after: Json | null;
  ip: string | null;
  user_agent: string | null;
}

// ---------------------------------------------------------------------------
// 002_message_logs.sql
// ---------------------------------------------------------------------------

export interface MessageLogsTable {
  id: Generated<string>;
  created_at: DefaultTimestamp;
  org_id: string;
  reseller_id: string | null;
  route_id: string | null;
  connection_id: string | null;
  template_id: string | null;
  campaign_id: string | null;
  channel: MsgChannel;
  client_msg_ref: string | null;
  source_addr: string | null;
  source_ton: number | null;
  source_npi: number | null;
  destination_addr: string;
  dest_ton: number | null;
  dest_npi: number | null;
  country_iso: string | null;
  mccmnc: string | null;
  orig_text: string;
  sent_text: string | null;
  otp_extracted: boolean | null;
  encoding: ColumnType<MsgEncoding, MsgEncoding | undefined, MsgEncoding>;
  parts: ColumnType<number, number | undefined, number>;
  status: ColumnType<MsgStatus, MsgStatus | undefined, MsgStatus>;
  smsc_msg_ids: ColumnType<string[], string[] | undefined, string[]>;
  error_code: string | null;
  dlr_stat: string | null;
  dlr_err: string | null;
  client_rate_micros: Int8 | null;
  client_cost_micros: Int8 | null;
  reseller_cost_micros: Int8 | null;
  route_cost_micros: Int8 | null;
  refunded: ColumnType<boolean, boolean | undefined, boolean>;
  submitted_at: Timestamp | null;
  dlr_received_at: Timestamp | null;
}

export interface MessageStatsHourlyTable {
  bucket: Timestamp;
  org_id: string;
  reseller_id: string | null;
  route_id: string;
  country_iso: ColumnType<string, string | undefined, string>;
  messages: ColumnType<number, number | bigint | string | undefined, number | bigint | string>;
  parts: ColumnType<number, number | bigint | string | undefined, number | bigint | string>;
  submitted: ColumnType<number, number | bigint | string | undefined, number | bigint | string>;
  delivered: ColumnType<number, number | bigint | string | undefined, number | bigint | string>;
  undelivered: ColumnType<number, number | bigint | string | undefined, number | bigint | string>;
  failed: ColumnType<number, number | bigint | string | undefined, number | bigint | string>;
  rejected: ColumnType<number, number | bigint | string | undefined, number | bigint | string>;
  expired: ColumnType<number, number | bigint | string | undefined, number | bigint | string>;
  client_cost_micros: ColumnType<number, number | bigint | string | undefined, number | bigint | string>;
  reseller_cost_micros: ColumnType<number, number | bigint | string | undefined, number | bigint | string>;
  route_cost_micros: ColumnType<number, number | bigint | string | undefined, number | bigint | string>;
}

// ---------------------------------------------------------------------------
// 004_features.sql
// ---------------------------------------------------------------------------

export interface BlockedNumbersTable {
  id: Generated<string>;
  org_id: string | null;
  prefix: string;
  note: string | null;
  /** 006: real org of the creator. */
  created_by_org_id: string | null;
  created_at: DefaultTimestamp;
}

export interface BlockedKeywordsTable {
  id: Generated<string>;
  org_id: string | null;
  pattern: string;
  note: string | null;
  /** 006: real org of the creator. */
  created_by_org_id: string | null;
  created_at: DefaultTimestamp;
}

export interface CampaignsTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  source_addr: string;
  body: string;
  status: ColumnType<CampaignStatus, CampaignStatus | undefined, CampaignStatus>;
  scheduled_at: Timestamp | null;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  total: ColumnType<number, number | undefined, number>;
  submitted: ColumnType<number, number | undefined, number>;
  failed: ColumnType<number, number | undefined, number>;
  created_by_user_id: string | null;
  /** 006: when the previous chunk finished (pacing). */
  last_chunk_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface CampaignRecipientsTable {
  campaign_id: string;
  seq: number;
  destination: string;
  vars: DefaultJson;
  message_id: string | null;
  error_code: string | null;
  /** 006: id sent with a submit whose outcome is unknown; reused by the retry (idempotent debit). */
  attempt_message_id: string | null;
}

export interface NotificationSettingsTable {
  org_id: string;
  email_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  email_to: ColumnType<string[], string[] | undefined, string[]>;
  telegram_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  telegram_chat_id: string | null;
  low_balance: ColumnType<boolean, boolean | undefined, boolean>;
  route_down: ColumnType<boolean, boolean | undefined, boolean>;
  updated_at: DefaultTimestamp;
}

export interface WebhookDeliveriesTable {
  id: GeneratedInt8;
  webhook_id: string;
  org_id: string;
  message_id: string | null;
  attempt: number;
  status_code: number | null;
  error: string | null;
  duration_ms: number | null;
  created_at: DefaultTimestamp;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export interface DB {
  organizations: OrganizationsTable;
  'app.org_effective_state': OrgEffectiveStateView;
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  accounts_balance: AccountsBalanceTable;
  balance_transactions: BalanceTransactionsTable;
  upstream_connections: UpstreamConnectionsTable;
  upstream_rates: UpstreamRatesTable;
  routes: RoutesTable;
  route_connections: RouteConnectionsTable;
  route_templates: RouteTemplatesTable;
  org_route_assignments: OrgRouteAssignmentsTable;
  sender_ids: SenderIdsTable;
  api_keys: ApiKeysTable;
  smpp_accounts: SmppAccountsTable;
  ip_whitelists: IpWhitelistsTable;
  webhooks: WebhooksTable;
  audit_logs: AuditLogsTable;
  message_logs: MessageLogsTable;
  message_stats_hourly: MessageStatsHourlyTable;
  blocked_numbers: BlockedNumbersTable;
  blocked_keywords: BlockedKeywordsTable;
  campaigns: CampaignsTable;
  campaign_recipients: CampaignRecipientsTable;
  notification_settings: NotificationSettingsTable;
  webhook_deliveries: WebhookDeliveriesTable;
}

export type Organization = Selectable<OrganizationsTable>;
export type NewOrganization = Insertable<OrganizationsTable>;
export type OrganizationUpdate = Updateable<OrganizationsTable>;
export type User = Selectable<UsersTable>;
export type RefreshToken = Selectable<RefreshTokensTable>;
export type AccountBalance = Selectable<AccountsBalanceTable>;
export type BalanceTransaction = Selectable<BalanceTransactionsTable>;
export type UpstreamConnection = Selectable<UpstreamConnectionsTable>;
export type Route = Selectable<RoutesTable>;
export type RouteTemplate = Selectable<RouteTemplatesTable>;
export type OrgRouteAssignment = Selectable<OrgRouteAssignmentsTable>;
export type SenderId = Selectable<SenderIdsTable>;
export type ApiKey = Selectable<ApiKeysTable>;
export type SmppAccount = Selectable<SmppAccountsTable>;
export type IpWhitelist = Selectable<IpWhitelistsTable>;
export type Webhook = Selectable<WebhooksTable>;
export type AuditLog = Selectable<AuditLogsTable>;
export type MessageLog = Selectable<MessageLogsTable>;
