import { asArray, buildQuery, http, request } from "./client";
import type * as T from "./types";

/**
 * One typed function per endpoint in CONTRACTS §10. Grouped by resource;
 * import as `import { api } from "@/lib/api"`.
 */

const e = encodeURIComponent;

export const auth = {
  login: (body: T.LoginRequest) =>
    http.post<T.LoginResponse>("/api/auth/login", body, { auth: false }),
  refresh: (body: T.RefreshRequest) =>
    http.post<T.TokenPair>("/api/auth/refresh", body, { auth: false }),
  logout: (body: T.LogoutRequest) => http.post<T.Ack>("/api/auth/logout", body),
  me: (signal?: AbortSignal) => http.get<T.MeResponse>("/api/auth/me", { signal }),
  /** Returns fresh tokens; every other session is revoked. */
  changePassword: (body: T.ChangePasswordRequest) => http.post<T.TokenPair>("/api/auth/password", body),
  totpSetup: () => http.post<T.TotpSetupResponse>("/api/auth/totp/setup"),
  totpEnable: (body: T.TotpCodeRequest) =>
    http.post<T.TotpEnableResponse>("/api/auth/totp/enable", body),
  totpDisable: (body: T.TotpCodeRequest) => http.post<T.Ack>("/api/auth/totp/disable", body),
  impersonate: (body: T.ImpersonateRequest) =>
    http.post<T.TokenPair>("/api/auth/impersonate", body),
  stopImpersonation: () => http.post<T.TokenPair>("/api/auth/impersonate/stop"),
};

export const orgs = {
  list: (params: T.OrgListParams = {}) =>
    http.get<T.Paginated<T.OrgListItem>>("/api/orgs", { query: params }),
  create: (body: T.CreateOrgRequest) => http.post<T.CreateOrgResponse>("/api/orgs", body),
  get: (id: T.Uuid) => http.get<T.OrgDetail>(`/api/orgs/${e(id)}`),
  update: (id: T.Uuid, body: T.UpdateOrgRequest) => http.patch<T.Org>(`/api/orgs/${e(id)}`, body),
  suspend: (id: T.Uuid, body: T.SuspendOrgRequest) =>
    http.post<T.Org>(`/api/orgs/${e(id)}/suspend`, body),
  activate: (id: T.Uuid) => http.post<T.Org>(`/api/orgs/${e(id)}/activate`),
  updateChannels: (id: T.Uuid, body: T.UpdateChannelsRequest) =>
    http.patch<T.Org>(`/api/orgs/${e(id)}/channels`, body),

  users: (id: T.Uuid, params: T.PageParams = {}) =>
    http.get<T.Paginated<T.User>>(`/api/orgs/${e(id)}/users`, { query: params }),
  createUser: (id: T.Uuid, body: T.CreateUserRequest) =>
    http.post<T.User>(`/api/orgs/${e(id)}/users`, body),
  resetUserPassword: (id: T.Uuid, uid: T.Uuid, body: T.ResetPasswordRequest) =>
    http.post<T.Ack>(`/api/orgs/${e(id)}/users/${e(uid)}/reset-password`, body),
  updateUser: (id: T.Uuid, uid: T.Uuid, body: T.UpdateUserRequest) =>
    http.patch<T.User>(`/api/orgs/${e(id)}/users/${e(uid)}`, body),

  balance: (id: T.Uuid) => http.get<T.OrgBalance>(`/api/orgs/${e(id)}/balance`),
  topup: (id: T.Uuid, body: T.TopupRequest) =>
    http.post<T.BalanceMutationResponse>(`/api/orgs/${e(id)}/balance/topup`, body),
  adjust: (id: T.Uuid, body: T.AdjustRequest) =>
    http.post<T.BalanceMutationResponse>(`/api/orgs/${e(id)}/balance/adjust`, body),
  updateBilling: (id: T.Uuid, body: T.UpdateBillingRequest) =>
    http.patch<T.OrgBalance>(`/api/orgs/${e(id)}/billing`, body),
  transactions: (id: T.Uuid, params: T.PageParams = {}) =>
    http.get<T.Paginated<T.BalanceTransaction>>(`/api/orgs/${e(id)}/transactions`, {
      query: params,
    }),

  routes: async (id: T.Uuid) =>
    asArray(
      await http.get<T.RouteAssignment[] | { items: T.RouteAssignment[] }>(
        `/api/orgs/${e(id)}/routes`,
      ),
    ),
  replaceRoutes: async (id: T.Uuid, body: T.RouteAssignmentInput[]) =>
    asArray(
      await http.put<T.RouteAssignment[] | { items: T.RouteAssignment[] }>(
        `/api/orgs/${e(id)}/routes`,
        body,
      ),
    ),
};

export const connections = {
  list: (params: T.ConnectionListParams = {}) =>
    http.get<T.Paginated<T.Connection>>("/api/connections", { query: params }),
  create: (body: T.CreateConnectionRequest) => http.post<T.Connection>("/api/connections", body),
  get: (id: T.Uuid) => http.get<T.ConnectionDetail>(`/api/connections/${e(id)}`),
  update: (id: T.Uuid, body: T.UpdateConnectionRequest) =>
    http.patch<T.Connection>(`/api/connections/${e(id)}`, body),
  remove: (id: T.Uuid) => http.delete<T.Ack>(`/api/connections/${e(id)}`),
  rates: async (id: T.Uuid) =>
    asArray(
      await http.get<T.ConnectionRate[] | { items: T.ConnectionRate[] }>(
        `/api/connections/${e(id)}/rates`,
      ),
    ),
  replaceRates: async (id: T.Uuid, body: T.ConnectionRateInput[]) =>
    asArray(
      await http.put<T.ConnectionRate[] | { items: T.ConnectionRate[] }>(
        `/api/connections/${e(id)}/rates`,
        body,
      ),
    ),
};

export const routes = {
  /** Admin: full route rows. */
  list: (params: T.RouteListParams = {}) =>
    http.get<T.Paginated<T.Route>>("/api/routes", { query: params }),
  /** Reseller / client: assigned routes (id, name, template_mode). */
  listAssigned: (params: T.RouteListParams = {}) =>
    http.get<T.Paginated<T.AssignedRoute>>("/api/routes", { query: params }),
  create: (body: T.CreateRouteRequest) => http.post<T.Route>("/api/routes", body),
  get: (id: T.Uuid) => http.get<T.RouteDetail>(`/api/routes/${e(id)}`),
  update: (id: T.Uuid, body: T.UpdateRouteRequest) =>
    http.patch<T.Route>(`/api/routes/${e(id)}`, body),
  remove: (id: T.Uuid) => http.delete<T.Ack>(`/api/routes/${e(id)}`),
  replaceConnections: async (id: T.Uuid, body: T.RouteConnectionInput[]) =>
    asArray(
      await http.put<T.RouteConnection[] | { items: T.RouteConnection[] }>(
        `/api/routes/${e(id)}/connections`,
        body,
      ),
    ),
};

export const monitor = {
  connections: () => http.get<T.ConnectionsStatusResponse>("/api/monitor/connections"),
  smppSessions: () => http.get<T.SmppSessionsResponse>("/api/monitor/smpp-sessions"),
};

export const templates = {
  list: (params: T.TemplateListParams = {}) =>
    http.get<T.Paginated<T.RouteTemplate>>("/api/templates", { query: params }),
  create: (body: T.CreateTemplateRequest) => http.post<T.RouteTemplate>("/api/templates", body),
  get: (id: T.Uuid) => http.get<T.RouteTemplate>(`/api/templates/${e(id)}`),
  update: (id: T.Uuid, body: T.UpdateTemplateRequest) =>
    http.patch<T.RouteTemplate>(`/api/templates/${e(id)}`, body),
  remove: (id: T.Uuid) => http.delete<T.Ack>(`/api/templates/${e(id)}`),
  preview: (body: T.TemplatePreviewRequest, signal?: AbortSignal) =>
    http.post<T.TemplatePreviewResponse>("/api/templates/preview", body, { signal }),
};

export const senderIds = {
  list: (params: T.SenderIdListParams = {}) =>
    http.get<T.Paginated<T.SenderId>>("/api/sender-ids", { query: params }),
  create: (body: T.CreateSenderIdRequest, scope: T.ScopedParams = {}) =>
    http.post<T.SenderId>("/api/sender-ids", body, { query: scope }),
  remove: (id: T.Uuid) => http.delete<T.Ack>(`/api/sender-ids/${e(id)}`),
  approve: (id: T.Uuid) => http.post<T.SenderId>(`/api/sender-ids/${e(id)}/approve`),
  reject: (id: T.Uuid) => http.post<T.SenderId>(`/api/sender-ids/${e(id)}/reject`),
};

export const apiKeys = {
  list: (params: T.ApiKeyListParams = {}) =>
    http.get<T.Paginated<T.ApiKey>>("/api/api-keys", { query: params }),
  create: (body: T.CreateApiKeyRequest, scope: T.ScopedParams = {}) =>
    http.post<T.CreateApiKeyResponse>("/api/api-keys", body, { query: scope }),
  revoke: (id: T.Uuid) => http.delete<T.Ack>(`/api/api-keys/${e(id)}`),
};

export const smppAccounts = {
  list: (params: T.PageParams & T.ScopedParams = {}) =>
    http.get<T.Paginated<T.SmppAccount>>("/api/smpp-accounts", { query: params }),
  create: (body: T.CreateSmppAccountRequest, scope: T.ScopedParams = {}) =>
    http.post<T.SmppAccount>("/api/smpp-accounts", body, { query: scope }),
  update: (id: T.Uuid, body: T.UpdateSmppAccountRequest) =>
    http.patch<T.SmppAccount>(`/api/smpp-accounts/${e(id)}`, body),
  remove: (id: T.Uuid) => http.delete<T.Ack>(`/api/smpp-accounts/${e(id)}`),
  setPassword: (id: T.Uuid, body: T.SmppPasswordRequest) =>
    http.post<T.Ack>(`/api/smpp-accounts/${e(id)}/password`, body),
};

export const ipWhitelist = {
  list: (params: T.PageParams & T.ScopedParams = {}) =>
    http.get<T.Paginated<T.IpWhitelistEntry>>("/api/ip-whitelist", { query: params }),
  create: (body: T.CreateIpWhitelistRequest, scope: T.ScopedParams = {}) =>
    http.post<T.IpWhitelistEntry>("/api/ip-whitelist", body, { query: scope }),
  remove: (id: T.Uuid) => http.delete<T.Ack>(`/api/ip-whitelist/${e(id)}`),
};

export const webhooks = {
  list: (params: T.PageParams & T.ScopedParams = {}) =>
    http.get<T.Paginated<T.Webhook>>("/api/webhooks", { query: params }),
  create: (body: T.CreateWebhookRequest, scope: T.ScopedParams = {}) =>
    http.post<T.CreateWebhookResponse>("/api/webhooks", body, { query: scope }),
  update: (id: T.Uuid, body: T.UpdateWebhookRequest) =>
    http.patch<T.UpdateWebhookResponse>(`/api/webhooks/${e(id)}`, body),
  remove: (id: T.Uuid) => http.delete<T.Ack>(`/api/webhooks/${e(id)}`),
  test: (id: T.Uuid) => http.post<T.WebhookTestResponse>(`/api/webhooks/${e(id)}/test`),
  deliveries: (id: T.Uuid, params: T.PageParams = {}) =>
    http.get<T.Paginated<T.WebhookDelivery>>(`/api/webhooks/${e(id)}/deliveries`, {
      query: params,
    }),
};

export const blocklist = {
  numbers: (params: T.BlocklistParams = {}) =>
    http.get<T.Paginated<T.BlockedNumber>>("/api/blocklist/numbers", { query: params }),
  createNumber: (body: T.CreateBlockedNumberRequest, scope: T.ScopedParams = {}) =>
    http.post<T.BlockedNumber>("/api/blocklist/numbers", body, { query: scope }),
  removeNumber: (id: T.Uuid) => http.delete<T.Ack>(`/api/blocklist/numbers/${e(id)}`),
  keywords: (params: T.BlocklistParams = {}) =>
    http.get<T.Paginated<T.BlockedKeyword>>("/api/blocklist/keywords", { query: params }),
  createKeyword: (body: T.CreateBlockedKeywordRequest, scope: T.ScopedParams = {}) =>
    http.post<T.BlockedKeyword>("/api/blocklist/keywords", body, { query: scope }),
  removeKeyword: (id: T.Uuid) => http.delete<T.Ack>(`/api/blocklist/keywords/${e(id)}`),
};

export const notifications = {
  get: (scope: T.ScopedParams = {}) =>
    http.get<T.NotificationSettings>("/api/notifications/settings", { query: scope }),
  update: (body: T.NotificationSettings, scope: T.ScopedParams = {}) =>
    http.put<T.NotificationSettings>("/api/notifications/settings", body, { query: scope }),
};

export const messages = {
  send: (body: T.SendMessageRequest) => http.post<T.SendMessageResponse>("/api/messages/send", body),
  list: (params: T.MessageListParams = {}) =>
    http.get<T.CursorPage<T.MessageLog>>("/api/messages", { query: params }),
  get: (id: T.Uuid) => http.get<T.MessageLog>(`/api/messages/${e(id)}`),
  /** Streams CSV; returns the raw Response so callers can read a Blob. */
  export: (params: T.MessageListParams = {}) =>
    request<Response>("GET", "/api/messages/export", {
      query: params,
      raw: true,
      headers: { Accept: "text/csv" },
    }),
  exportUrl: (params: T.MessageListParams = {}) => `/api/messages/export${buildQuery(params)}`,
};

export const analytics = {
  summary: (params: T.AnalyticsParams = {}) =>
    http.get<T.AnalyticsSummary>("/api/analytics/summary", { query: params }),
  timeseries: (params: T.TimeseriesParams = {}) =>
    http.get<T.AnalyticsTimeseries>("/api/analytics/timeseries", { query: params }),
  breakdown: (params: T.BreakdownParams) =>
    http.get<T.AnalyticsBreakdown>("/api/analytics/breakdown", { query: params }),
  live: () => http.get<T.AnalyticsLive>("/api/analytics/live"),
};

export const tester = {
  send: (body: T.TesterSendRequest) => http.post<T.SubmitResult>("/api/tester/send", body),
  get: (messageId: T.Uuid) => http.get<T.TesterResult>(`/api/tester/${e(messageId)}`),
};

export const campaigns = {
  createJson: (body: T.CreateCampaignJsonRequest) => http.post<T.Campaign>("/api/campaigns", body),
  createUpload: (body: T.CreateCampaignUploadRequest) => {
    const form = new FormData();
    form.set("file", body.file);
    form.set("name", body.name);
    form.set("source_addr", body.source_addr);
    form.set("body", body.body);
    if (body.scheduled_at) form.set("scheduled_at", body.scheduled_at);
    return http.post<T.Campaign>("/api/campaigns", form);
  },
  list: (params: T.CampaignListParams = {}) =>
    http.get<T.Paginated<T.Campaign>>("/api/campaigns", { query: params }),
  get: (id: T.Uuid) => http.get<T.Campaign>(`/api/campaigns/${e(id)}`),
  recipients: (id: T.Uuid, params: T.CampaignRecipientsParams = {}) =>
    http.get<T.Paginated<T.CampaignRecipient>>(`/api/campaigns/${e(id)}/recipients`, { query: params }),
  start: (id: T.Uuid) => http.post<T.Campaign>(`/api/campaigns/${e(id)}/start`),
  pause: (id: T.Uuid) => http.post<T.Campaign>(`/api/campaigns/${e(id)}/pause`),
  cancel: (id: T.Uuid) => http.post<T.Campaign>(`/api/campaigns/${e(id)}/cancel`),
};

export const auditLogs = {
  list: (params: T.AuditLogParams = {}) =>
    http.get<T.Paginated<T.AuditLog>>("/api/audit-logs", { query: params }),
};

export const dashboard = {
  get: () => http.get<T.DashboardResponse>("/api/dashboard"),
};
