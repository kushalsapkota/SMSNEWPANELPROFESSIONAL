/**
 * TanStack Query keys. Every key starts with a resource root so a mutation can
 * invalidate a whole resource with `qk.<resource>.all` (prefix match).
 *
 *   useQuery({ queryKey: qk.orgs.detail(id), queryFn: () => api.orgs.get(id) })
 *   invalidate: [qk.orgs.all]
 */
export const qk = {
  me: ["auth", "me"] as const,
  orgs: {
    all: ["orgs"] as const,
    list: (params: object) => ["orgs", "list", params] as const,
    detail: (id: string) => ["orgs", "detail", id] as const,
    users: (id: string, params?: object) => ["orgs", "users", id, params ?? {}] as const,
    balance: (id: string) => ["orgs", "balance", id] as const,
    transactions: (id: string, params?: object) =>
      ["orgs", "transactions", id, params ?? {}] as const,
    routes: (id: string) => ["orgs", "routes", id] as const,
  },
  connections: {
    all: ["connections"] as const,
    list: (params: object) => ["connections", "list", params] as const,
    detail: (id: string) => ["connections", "detail", id] as const,
    rates: (id: string) => ["connections", "rates", id] as const,
  },
  routes: {
    all: ["routes"] as const,
    list: (params: object) => ["routes", "list", params] as const,
    assigned: (params: object) => ["routes", "assigned", params] as const,
    detail: (id: string) => ["routes", "detail", id] as const,
  },
  templates: {
    all: ["templates"] as const,
    list: (params: object) => ["templates", "list", params] as const,
    detail: (id: string) => ["templates", "detail", id] as const,
    preview: (body: object) => ["templates", "preview", body] as const,
  },
  senderIds: {
    all: ["sender-ids"] as const,
    list: (params: object) => ["sender-ids", "list", params] as const,
  },
  apiKeys: {
    all: ["api-keys"] as const,
    list: (params: object) => ["api-keys", "list", params] as const,
  },
  smppAccounts: {
    all: ["smpp-accounts"] as const,
    list: (params: object) => ["smpp-accounts", "list", params] as const,
  },
  ipWhitelist: {
    all: ["ip-whitelist"] as const,
    list: (params: object) => ["ip-whitelist", "list", params] as const,
  },
  webhooks: {
    all: ["webhooks"] as const,
    list: (params: object) => ["webhooks", "list", params] as const,
    deliveries: (id: string, params: object) => ["webhooks", "deliveries", id, params] as const,
  },
  blocklist: {
    all: ["blocklist"] as const,
    numbers: (params: object) => ["blocklist", "numbers", params] as const,
    keywords: (params: object) => ["blocklist", "keywords", params] as const,
  },
  notifications: {
    all: ["notifications"] as const,
    settings: (orgId?: string) => ["notifications", "settings", orgId ?? "self"] as const,
  },
  messages: {
    all: ["messages"] as const,
    list: (params: object) => ["messages", "list", params] as const,
    detail: (id: string) => ["messages", "detail", id] as const,
  },
  analytics: {
    all: ["analytics"] as const,
    summary: (params: object) => ["analytics", "summary", params] as const,
    timeseries: (params: object) => ["analytics", "timeseries", params] as const,
    breakdown: (params: object) => ["analytics", "breakdown", params] as const,
    live: ["analytics", "live"] as const,
  },
  monitor: {
    all: ["monitor"] as const,
    connections: ["monitor", "connections"] as const,
    smppSessions: ["monitor", "smpp-sessions"] as const,
  },
  tester: {
    all: ["tester"] as const,
    result: (id: string) => ["tester", id] as const,
  },
  campaigns: {
    all: ["campaigns"] as const,
    list: (params: object) => ["campaigns", "list", params] as const,
    detail: (id: string) => ["campaigns", "detail", id] as const,
    recipients: (id: string, params: object) => ["campaigns", "recipients", id, params] as const,
  },
  auditLogs: {
    all: ["audit-logs"] as const,
    list: (params: object) => ["audit-logs", "list", params] as const,
  },
  dashboard: ["dashboard"] as const,
};
