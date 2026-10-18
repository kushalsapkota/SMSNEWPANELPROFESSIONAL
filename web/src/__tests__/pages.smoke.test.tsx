// @vitest-environment jsdom
/**
 * Render smoke tests for every part-2 page against contract-shaped fixtures
 * (CONTRACTS §10). They catch runtime crashes, wrong field access and broken
 * wiring that tsc can't see; layout is not asserted.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { OrgRole } from "@/lib/api/types";

/* ------------------------------------------------------------- mocks */

let search = new URLSearchParams();
const router = {
  replace: vi.fn((url: string) => {
    search = new URLSearchParams(url.split("?")[1] ?? "");
  }),
  push: vi.fn(),
  back: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/test",
  useSearchParams: () => search,
}));

// jsdom has no layout: give charts a real size so marks, labels and dots render.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children) ? cloneElement(children as React.ReactElement<{ width: number; height: number }>, { width: 640, height: 260 }) : null,
  };
});

let role: OrgRole = "CLIENT";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
vi.mock("@/lib/auth/session", () => ({
  useSession: () => ({
    user: { id: "u1", org_id: ORG_ID, email: "a@b.c", full_name: "Ann", is_active: true, totp_enabled: false, last_login_at: null, created_at: "2026-01-01T00:00:00Z" },
    org: { id: ORG_ID, role, name: "Acme", parent_id: null, status: "ACTIVE", brand_name: null },
    role,
    impersonating: false,
  }),
  useAuth: () => ({ status: "authenticated" }),
}));

const NOW = new Date();
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

const message = {
  id: "11111111-1111-4111-8111-111111111111",
  created_at: iso(60_000),
  org_id: ORG_ID,
  org_name: "Acme",
  reseller_id: null,
  route_id: "r1",
  route_name: "Premium IN",
  connection_id: null,
  template_id: "t1",
  campaign_id: null,
  channel: "HTTP",
  client_msg_ref: "ref-1",
  source_addr: "ACME",
  destination_addr: "919876543210",
  country_iso: "IN",
  mccmnc: null,
  orig_text: "Your code is 849201",
  sent_text: "Acme: 849201 is your code",
  otp_extracted: true,
  encoding: "GSM7",
  parts: 1,
  status: "DELIVERED",
  smsc_msg_ids: ["abc123"],
  error_code: null,
  dlr_stat: "DELIVRD",
  dlr_err: "000",
  client_rate_micros: 5000,
  client_cost_micros: 5000,
  reseller_cost_micros: 3000,
  route_cost_micros: 1000,
  refunded: false,
  submitted_at: iso(59_000),
  dlr_received_at: iso(55_000),
};

const campaign = {
  id: "22222222-2222-4222-8222-222222222222",
  org_id: ORG_ID,
  name: "October promo",
  source_addr: "ACME",
  body: "Hi {name}, sale!",
  status: "RUNNING",
  scheduled_at: null,
  started_at: iso(120_000),
  finished_at: null,
  total: 100,
  submitted: 40,
  failed: 2,
  created_by_user_id: null,
  created_at: iso(200_000),
  updated_at: iso(1000),
};

const day = (n: number) => {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const breakdownRow = (key: string, label: string, messages: number) => ({
  key,
  label,
  messages,
  delivered: Math.round(messages * 0.9),
  failed: Math.round(messages * 0.05),
  delivery_rate: 0.9,
  revenue_micros: messages * 5000,
  cost_micros: messages * 3000,
});

const routeConn = (id: string, name: string, priority: number) => ({
  connection_id: id, connection_name: name, connection_enabled: true, host: "10.0.0.5", port: 2775 + priority - 1, use_tls: false,
  system_id: "acme", bind_type: "TRX", priority, weight: 100, enabled: true, sessions: [], tps_limit: 50, tps_current: 0, inflight: 0, queue_depth: 0,
});

function fixture(method: string, path: string, query: URLSearchParams): unknown {
  const page = (items: unknown[]) => ({ items, total: items.length, page: 1, page_size: 50 });
  if (path === "/api/dashboard")
    return {
      balance: { balance_micros: 12_500_000, credit_limit_micros: 0, billing_mode: "PREPAID", currency: "USD", low_balance_alert_micros: null },
      today: { messages: 10, delivered: 8, failed: 1 },
      last7d: [0, 1, 2, 3, 4, 5, 6].map((n) => ({
        date: day(n),
        messages: 10 + n,
        delivered: 8 + n,
        failed: 1,
        ...(role === "CLIENT" ? { spend_micros: 50_000 } : { revenue_micros: 50_000, cost_micros: 30_000 }),
      })),
      counts: { clients: 3, routes: 2 },
    };
  if (path === "/api/analytics/summary")
    return { messages: 1200, parts: 1300, delivered: 1100, failed: 50, pending: 50, delivery_rate: 0.916, revenue_micros: 6_000_000, cost_micros: 3_600_000, profit_micros: 2_400_000 };
  if (path === "/api/analytics/timeseries")
    return {
      points: [0, 1, 2].map((n) => ({ t: query.get("granularity") === "hour" ? iso(n * 3_600_000) : day(n), messages: 100, delivered: 90, failed: 5, revenue_micros: 500_000 })),
    };
  if (path === "/api/analytics/breakdown") {
    const by = query.get("by");
    if (by === "status") return { rows: [breakdownRow("DELIVERED", "Delivered", 900), breakdownRow("FAILED", "Failed", 40)] };
    return { rows: Array.from({ length: 12 }, (_, i) => breakdownRow(`k${i}`, `${by} ${i}`, 100 - i)) };
  }
  if (path === "/api/analytics/live") return { tps_in: 12.5, tps_out: 11, queue_depth: 40, connections_up: 1, connections_total: 2 };
  if (/^\/api\/orgs\/[^/]+\/balance$/.test(path))
    return { balance_micros: 12_500_000, credit_limit_micros: 0, billing_mode: "PREPAID", currency: "USD", low_balance_alert_micros: null };
  if (/^\/api\/orgs\/[^/]+\/routes$/.test(path))
    return { items: [{ id: "a1", route_id: "r1", route_name: "Premium IN", prefix: "91", rate_micros: 5000, priority: 10, enabled: true, parent_rate_micros: null }] };
  if (path === "/api/orgs") return page([{ id: "c1", name: "Child Co", role: "CLIENT" }]);
  if (path === "/api/routes/quick" && method === "POST") return { id: "rq1", name: "Quick IN", connections: [] };
  if (path === "/api/routes/rq1/status")
    return {
      route_id: "rq1",
      route_enabled: true,
      engine_reachable: true,
      engine_error: null,
      checked_at: iso(0),
      connections: [
        { ...routeConn("k1", "Quick IN SMPP 1", 1), state: "BOUND", sessions_bound: 1, sessions_total: 1, bound_since: iso(120_000), last_error: null },
        { ...routeConn("k2", "Quick IN SMPP 2", 2), state: "DOWN", sessions_bound: 0, sessions_total: 1, bound_since: null, last_error: "smpp client: bind rejected: ESME_RINVPASWD" },
      ],
    };
  if (path === "/api/routes/rq1")
    return {
      id: "rq1", name: "Quick IN", description: null, enabled: true, template_mode: false, template_fallback: "SEND_RAW", force_sender_id: null,
      created_at: iso(0), updated_at: iso(0),
      connections: [
        { connection_id: "k1", connection_name: "Quick IN SMPP 1", connection_enabled: true, host: "10.0.0.5", port: 2775, use_tls: false, system_id: "acme", priority: 1, weight: 100, enabled: true },
      ],
    };
  if (path === "/api/connections") return page([]);
  if (path === "/api/routes") return page([{ id: "r1", name: "Premium IN", template_mode: true, enabled: true }]);
  if (path === "/api/sender-ids")
    return page([{ id: "s1", org_id: ORG_ID, route_id: null, sender: "ACME", status: "APPROVED", reviewed_by: null, reviewed_at: null, created_at: iso(0) }]);
  if (path === "/api/messages") return { items: [message], next_cursor: "c2" };
  if (path.startsWith("/api/messages/")) return message;
  if (path === "/api/campaigns" && method === "POST") return { ...campaign, status: "DRAFT" };
  if (/^\/api\/campaigns\/[^/]+\/start$/.test(path)) return { ...campaign, status: "RUNNING" };
  if (/^\/api\/campaigns\/[^/]+\/recipients$/.test(path))
    return page([{ seq: 7, destination: "14155550100", vars: { name: "Bob" }, message_id: null, error_code: "ROUTE_NOT_FOUND" }]);
  if (path === "/api/campaigns") return page([campaign]);
  if (path.startsWith("/api/campaigns/")) return campaign;
  if (path === "/api/monitor/connections")
    return {
      connections: [
        {
          connection_id: "x1",
          name: "Upstream A",
          enabled: true,
          state: "BOUND",
          sessions: [
            { index: 0, state: "BOUND_TRX", bound_since: iso(3_600_000), last_error: null },
            { index: 1, state: "CONNECTING", bound_since: null, last_error: "connection refused" },
          ],
          tps_limit: 100,
          tps_current: 12.5,
          inflight: 3,
          queue_depth: 40,
          submitted_total: 12345,
          failed_total: 2,
        },
      ],
    };
  if (path === "/api/monitor/smpp-sessions")
    return {
      sessions: [
        { session_id: "ss1", org_id: "c1", org_name: "Child Co", system_id: "child1", bind_type: "TRX", remote_addr: "203.0.113.5:40000", bound_since: iso(60_000), tps_current: 3.2, submitted_total: 99 },
      ],
    };
  if (path === "/api/templates/preview")
    return { otp: "849201", matched_pattern: "\\d{6}", action: "TEMPLATED", output: "Acme: 849201", encoding: "GSM7", parts: 1, template_id: "t1" };
  if (path === "/api/tester/send")
    return { message_id: message.id, status: "ACCEPTED", parts: 1, encoding: "GSM7", cost_micros: 0, route_id: "r1", sent_text: "Acme: 849201" };
  if (path.startsWith("/api/tester/"))
    return { message, timings: { accepted_at: message.created_at, submitted_at: message.submitted_at, dlr_received_at: message.dlr_received_at, submit_latency_ms: 1000, dlr_latency_ms: 4000 } };
  if (path === "/api/messages/send" && method === "POST")
    return { messages: [{ to: "919876543210", message_id: message.id, status: "ACCEPTED", parts: 1, cost_micros: 5000 }] };
  if (["/api/api-keys", "/api/smpp-accounts", "/api/ip-whitelist", "/api/webhooks"].includes(path)) return page([]);
  throw new Error(`unmocked ${method} ${path}`);
}

const calls: Array<{ method: string; path: string; query: URLSearchParams; body?: unknown }> = [];

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", RO);
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((q: string) => ({ matches: false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })),
  );
});

beforeEach(() => {
  search = new URLSearchParams();
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://localhost");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      calls.push({ method, path: url.pathname, query: url.searchParams, body });
      try {
        const data = fixture(method, url.pathname, url.searchParams);
        return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error_code: "NOT_FOUND", message: String(e) }), { status: 404 });
      }
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

function unmocked() {
  return calls.filter((c) => !c.path.startsWith("/api/")).map((c) => c.path);
}

/* -------------------------------------------------------------- tests */

describe("part 2 pages render with contract data", () => {
  it("dashboard shows cards and chart cards for a client", async () => {
    role = "CLIENT";
    const { DashboardView } = await import("@/app/(app)/dashboard/dashboard-view");
    wrap(<DashboardView />);
    expect(await screen.findByText("Messages, last 7 days")).toBeTruthy();
    expect(await screen.findByText("Spend, last 7 days")).toBeTruthy();
    expect(await screen.findByText("Top routes")).toBeTruthy();
    expect(screen.queryByText("Top clients")).toBeNull();
    await waitFor(() => expect(document.querySelectorAll(".recharts-bar-rectangle").length).toBeGreaterThan(0));
    await waitFor(() => expect(document.querySelectorAll(".recharts-line-curve").length).toBeGreaterThan(0));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/analytics/breakdown" && c.query.get("by") === "country")).toBe(true));
    expect(unmocked()).toEqual([]);
  });

  it("dashboard for a reseller adds top clients and profit labels", async () => {
    role = "RESELLER";
    const { DashboardView } = await import("@/app/(app)/dashboard/dashboard-view");
    wrap(<DashboardView />);
    expect(await screen.findByText("Top clients")).toBeTruthy();
    expect(await screen.findByText("Wholesale cost")).toBeTruthy();
    expect((await screen.findAllByText("Profit")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Revenue, cost and profit, last 7 days")).toBeTruthy();
  });

  it("analytics renders tiles, breakdown tabs and table view", async () => {
    role = "SUPER_ADMIN";
    const { AnalyticsPage } = await import("@/components/analytics/analytics-page");
    wrap(<AnalyticsPage />);
    expect(await screen.findByText("Upstream cost")).toBeTruthy();
    expect(await screen.findByText("Messages over time")).toBeTruthy();
    const tableButtons = await screen.findAllByLabelText("Table view");
    fireEvent.click(tableButtons[0]);
    expect(await screen.findAllByText("Delivery rate")).toBeTruthy();
    const ts = calls.find((c) => c.path === "/api/analytics/timeseries");
    expect(ts?.query.get("granularity")).toBe("day");
    expect(ts?.query.get("from")).toMatch(/Z$/);
  });

  it("send page counts recipients, parts and posts the send", async () => {
    role = "CLIENT";
    const { SendSmsPage } = await import("@/components/send/send-sms-page");
    wrap(<SendSmsPage />);
    const recipients = await screen.findByPlaceholderText(/98765 43210/);
    fireEvent.change(recipients, { target: { value: "+91 98765 43210\n919876543210\nbad" } });
    await screen.findByText(/1 unique number/);
    expect(screen.getByText(/1 duplicates removed/)).toBeTruthy();
    const text = screen.getByLabelText("Message");
    fireEvent.change(text, { target: { value: "a".repeat(161) } });
    expect(await screen.findByText("2 parts")).toBeTruthy();
    fireEvent.change(text, { target: { value: "Привет" } });
    expect(await screen.findByText("UCS-2 (Unicode)")).toBeTruthy();
    // sender defaults to the approved one
    await waitFor(() => expect(screen.getAllByText("ACME").length).toBeGreaterThan(0));
    // estimated cost from the 91 prefix rate
    await waitFor(() => expect(screen.getByText("$0.005")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Send to 1 recipient/ }));
    expect(await screen.findByText("Results")).toBeTruthy();
    const send = calls.find((c) => c.path === "/api/messages/send");
    expect(send?.body).toEqual({ to: "919876543210", from: "ACME", text: "Привет" });
  });

  it("campaign list, wizard and detail render", async () => {
    role = "CLIENT";
    const { CampaignsList } = await import("@/components/campaigns/campaigns-list");
    const { CampaignWizard } = await import("@/components/campaigns/campaign-wizard");
    const { CampaignDetail } = await import("@/components/campaigns/campaign-detail");
    const a = wrap(<CampaignsList />);
    expect(await screen.findByText("October promo")).toBeTruthy();
    expect(screen.getByText(/40 sent · 2 failed \/ 100/)).toBeTruthy();
    a.unmount();
    const b = wrap(<CampaignWizard />);
    expect(await screen.findByText("Upload CSV")).toBeTruthy();
    b.unmount();
    wrap(<CampaignDetail id={campaign.id} />);
    expect(await screen.findByText("42 of 100 processed", { exact: false })).toBeTruthy();
    expect(await screen.findByText("ROUTE_NOT_FOUND")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.path === "/api/messages" && c.query.get("campaign_id") === campaign.id)).toBe(true));
  });

  it("campaign wizard: CSV upload, placeholder insert, create + start with a phone header", async () => {
    role = "CLIENT";
    const { CampaignWizard } = await import("@/components/campaigns/campaign-wizard");
    wrap(<CampaignWizard />);
    const input = (await screen.findByLabelText("CSV file")) as HTMLInputElement;
    const file = new File(["Mobile,name\n+91 98765 43210,Ann\n14155550100,Bob\nnope,X\n"], "list.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(document.body.textContent).toContain("1 invalid (nope) will be skipped"));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.change(await screen.findByLabelText("Campaign name"), { target: { value: "Promo" } });
    const body = screen.getByLabelText("Message");
    fireEvent.change(body, { target: { value: "Hi , sale" } });
    (body as HTMLTextAreaElement).setSelectionRange(3, 3);
    fireEvent.click(screen.getByRole("button", { name: "{name}" }));
    expect((body as HTMLTextAreaElement).value).toBe("Hi {name}, sale");
    expect(await screen.findByText("Hi Ann, sale")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("ACME").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Create & send/ }));
    });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/campaigns/${campaign.id}`));
    const post = calls.find((c) => c.path === "/api/campaigns" && c.method === "POST");
    const form = post?.body as FormData;
    expect(form.get("name")).toBe("Promo");
    expect(form.get("source_addr")).toBe("ACME");
    expect(form.get("body")).toBe("Hi {name}, sale");
    const { readFileText } = await import("@/lib/download");
    const uploaded = await readFileText(form.get("file") as File);
    expect(uploaded.split("\r\n")[0]).toBe("phone,name");
    expect(calls.some((c) => c.path === `/api/campaigns/${campaign.id}/start`)).toBe(true);
  });

  it("messages page lists, opens the drawer and exports", async () => {
    role = "RESELLER";
    const { MessagesPage } = await import("@/components/messages/messages-page");
    wrap(<MessagesPage />);
    const row = await screen.findByText("Your code is 849201");
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
    fireEvent.click(row);
    expect(await screen.findByText("Acme: 849201 is your code")).toBeTruthy();
    expect(screen.getByText("Your cost")).toBeTruthy();
    const list = calls.find((c) => c.path === "/api/messages");
    expect(list?.query.get("limit")).toBe("100");
    expect(list?.query.get("from_date")).toBeTruthy();
  });

  it("monitor renders the upstream grid for admin and sessions for reseller", async () => {
    role = "SUPER_ADMIN";
    const { MonitorPage } = await import("@/components/monitor/monitor-page");
    const a = wrap(<MonitorPage />);
    expect(await screen.findByText("Upstream A")).toBeTruthy();
    expect(await screen.findByText("child1")).toBeTruthy();
    expect(screen.getByText("1 / 2")).toBeTruthy();
    a.unmount();
    role = "RESELLER";
    calls.length = 0;
    wrap(<MonitorPage />);
    expect(await screen.findByText("child1")).toBeTruthy();
    expect(screen.queryByText("Upstream A")).toBeNull();
    expect(calls.some((c) => c.path === "/api/monitor/connections")).toBe(false);
  });

  it("tester shows the template preview and a live timeline", async () => {
    role = "RESELLER";
    const { TesterPage } = await import("@/components/tester/tester-page");
    wrap(<TesterPage />);
    expect(await screen.findByText("Template preview")).toBeTruthy();
    expect(await screen.findByText("Acme: 849201")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "+91 98765 43210" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send test/ }));
    });
    expect(await screen.findByText("Live result")).toBeTruthy();
    expect(await screen.findByText("4.00 s")).toBeTruthy();
    const sent = calls.find((c) => c.path === "/api/tester/send");
    expect(sent?.body).toMatchObject({ route_id: "r1", destination: "919876543210" });
  });

  it("developer page has credentials and docs tabs", async () => {
    role = "CLIENT";
    search = new URLSearchParams("tab=docs");
    const { DeveloperPage } = await import("@/components/developer/developer-page");
    wrap(<DeveloperPage />);
    expect(await screen.findByText("Delivery report webhooks")).toBeTruthy();
    expect(screen.getAllByText(/\/v1\/sms\/send/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "PHP" }));
    expect(screen.getByText(/hash_hmac/)).toBeTruthy();
  });

  it("new route: inline SMPP connection posts /api/routes/quick and opens the route", async () => {
    role = "SUPER_ADMIN";
    const { NewRouteForm } = await import("@/components/routes/new-route-form");
    wrap(<NewRouteForm />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Quick IN" } });
    fireEvent.change(screen.getByLabelText("Host / IP"), { target: { value: "10.0.0.5" } });
    fireEvent.change(screen.getByLabelText("Username (system_id)"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "123456789" } });
    fireEvent.click(screen.getByRole("button", { name: "Create route" }));
    expect(await screen.findByText("Max 8 characters (SMPP 3.4)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Create route" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/routes/rq1"));
    const sent = calls.find((c) => c.path === "/api/routes/quick");
    expect(sent?.body).toMatchObject({
      name: "Quick IN",
      connections: [{ type: "SMPP", host: "10.0.0.5", port: 2775, system_id: "acme", password: "s3cret", bind_type: "TRX", max_tps: 50, priority: 1 }],
    });
    expect(unmocked()).toEqual([]);
  });

  it("route detail shows live carrier status in plain words", async () => {
    role = "SUPER_ADMIN";
    const { RouteDetailView } = await import("@/components/routes/route-detail");
    wrap(<RouteDetailView id="rq1" />);
    expect(await screen.findByText("Carrier status")).toBeTruthy();
    expect(await screen.findByText(/Bound since/)).toBeTruthy();
    expect(await screen.findByText("Wrong username or password")).toBeTruthy();
    expect(screen.getByText("smpp client: bind rejected: ESME_RINVPASWD")).toBeTruthy();
  });
});
