// @vitest-environment jsdom
/**
 * jsdom smoke tests for HTTP API connections: the Carrier status HTTP row (Ready/Error in plain
 * words, balance, callback URL), the "Send test SMS" dialog, the New route HTTP row (adapter
 * dropdown → catalogue-driven fields → request) and the write-only credential edit form.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Adapter } from "@/lib/api/types";

const router = { replace: vi.fn(), push: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/test", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/auth/session", () => ({
  useSession: () => ({ role: "SUPER_ADMIN", org: { id: "o1", role: "SUPER_ADMIN" }, user: { id: "u1" }, impersonating: false }),
  useAuth: () => ({ status: "authenticated" }),
}));

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

export const ADAPTERS: Adapter[] = [
  {
    id: "aakash_v3", name: "Aakash SMS (v3)", country: "NP", docs_url: "https://aakashsms.com/documentation/", confidence: "VERIFIED",
    credentials: [{ key: "auth_token", label: "Auth token", secret: true, required: true }],
    settings: [{ key: "base_url", label: "API base URL", type: "url", default: "https://sms.aakashsms.com", required: false }],
    dlr_mode: "poll", supports_balance: true, destination_countries: ["NP"], notes: "Returns HTTP 200 on errors.",
  },
  {
    id: "messengernepal", name: "MessengerNepal", country: "NP", docs_url: null, confidence: "VERIFIED",
    credentials: [
      { key: "token", label: "API Key", secret: true, required: true },
      { key: "webhook_secret", label: "Webhook secret", secret: true, required: false },
    ],
    settings: [{ key: "sender", label: "Sender ID", type: "string", required: false }],
    dlr_mode: "callback", supports_balance: false, destination_countries: ["NP"], notes: null,
  },
  {
    id: "nestsms", name: "Nest SMS", country: "NP", docs_url: null, confidence: "LIKELY",
    credentials: [{ key: "token", label: "API Key", secret: true, required: true }],
    settings: [{ key: "base_url", label: "API base URL", type: "url", default: null, required: true }],
    dlr_mode: "poll", supports_balance: true, destination_countries: ["NP"], notes: "Ask the provider for the host.",
  },
  {
    id: "generic_http", name: "Generic HTTP API", country: null, docs_url: null, confidence: "VERIFIED",
    credentials: [{ key: "token", label: "Token", secret: true, required: false }],
    settings: [
      { key: "method", label: "HTTP method", type: "select", default: "POST", options: ["GET", "POST"], required: true },
      { key: "url", label: "URL template", type: "url", default: null, required: true },
      { key: "body_type", label: "Body type", type: "select", default: "form", options: ["query", "form", "json"], required: true },
      { key: "params_template", label: "Parameters template", type: "string", default: '{"to":"{to}","text":"{text}"}', required: true },
    ],
    dlr_mode: "none", supports_balance: false, destination_countries: null, notes: null,
  },
];

const httpConn = {
  id: "h1", name: "Aakash main", kind: "HTTP", adapter: "aakash_v3", host: null, port: null, use_tls: false, system_id: null, system_type: "",
  bind_type: "TRX", sessions: 1, max_tps: 10, window_size: 10, enquire_link_interval_s: 30, reconnect_min_s: 1, reconnect_max_s: 60,
  submit_timeout_ms: 10000, request_dlr: true, multipart_mode: "UDH", default_data_coding: 0, enabled: true, notes: null, has_password: false,
  credentials_set: ["auth_token"], settings: { base_url: "https://sms.aakashsms.com" }, dlr_callback_path: "/v1/provider-dlr/tok", dlr_callback_url: null,
  created_at: iso(0), updated_at: iso(0), routes: [],
};

const statusRow = (over: Record<string, unknown>) => ({
  connection_name: "x", connection_enabled: true, host: null, port: null, use_tls: false, system_id: null, bind_type: "TRX", priority: 1, weight: 100,
  enabled: true, sessions: [], sessions_bound: 0, sessions_total: 0, bound_since: null, last_error: null, tps_limit: 10, tps_current: 0, inflight: 0,
  queue_depth: 0, kind: "HTTP", ...over,
});

function fixture(method: string, path: string): unknown {
  if (path === "/api/connections/adapters") return { adapters: ADAPTERS };
  if (path === "/api/routes/r1/status")
    return {
      route_id: "r1", route_enabled: true, engine_reachable: true, engine_error: null, checked_at: iso(0),
      connections: [
        statusRow({ connection_id: "h1", connection_name: "Aakash main", adapter: "aakash_v3", state: "READY", last_success_at: iso(120_000) }),
        statusRow({
          connection_id: "h2", connection_name: "MN backup", adapter: "messengernepal", priority: 2, state: "ERROR",
          last_error: "HTTP 401: invalid API key", last_error_at: iso(30_000), last_success_at: null,
          dlr_callback_path: "/v1/provider-dlr/SECRETTOKENxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", dlr_callback_url: "https://sms.example.com/v1/provider-dlr/SECRETTOKENxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        }),
      ],
    };
  if (path === "/api/connections/h1/balance") return { supported: true, balance: "1234", raw: "{}", error: null };
  if (path === "/api/connections/h1/test" && method === "POST")
    return {
      ok: true, provider_message_id: "prov-9", http_status: 200, duration_ms: 87,
      request: { method: "POST", url: "https://sms.aakashsms.com/sms/v3/send", body: "auth_token=****&to=9800000000&text=hello" },
      response_body: '{"error":false}', error: null,
    };
  if (path === "/api/connections/h2/test" && method === "POST")
    return { ok: false, provider_message_id: null, http_status: 401, duration_ms: 20, request: null, response_body: "{}", error: "HTTP 401: invalid API key" };
  if (path === "/api/connections/h1" && method === "PATCH") return httpConn;
  if (path === "/api/connections/h1") return httpConn;
  if (path === "/api/connections") return { items: [], total: 0, page: 1, page_size: 200 };
  if (path === "/api/routes/quick" && method === "POST") return { id: "rq9", name: "NP OTP", connections: [] };
  throw new Error(`no fixture for ${method} ${path}`);
}

const calls: Array<{ method: string; path: string; body?: unknown }> = [];

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://localhost");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      calls.push({ method, path: url.pathname, body });
      try {
        return new Response(JSON.stringify(fixture(method, url.pathname)), { status: 200, headers: { "Content-Type": "application/json" } });
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

/** Opens a Radix select by keyboard and picks the option (jsdom has no pointer layout). */
async function pick(trigger: HTMLElement, option: RegExp | string) {
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const opt = await screen.findByRole("option", { name: option });
  fireEvent.keyDown(opt, { key: "Enter" });
  fireEvent.click(opt);
}

describe("HTTP connections UI", () => {
  it("carrier status: HTTP rows show Ready / Error in plain words, last success, balance and the callback URL", async () => {
    const { CarrierStatusCard } = await import("@/components/routes/carrier-status-card");
    wrap(<CarrierStatusCard routeId="r1" />);
    const rows = await screen.findAllByTestId("http-carrier-row");
    expect(rows).toHaveLength(2);
    const [ok, bad] = rows;
    expect(within(ok).getByText("Ready")).toBeTruthy();
    expect(within(ok).getByText(/Last successful send/)).toBeTruthy();
    await waitFor(() => expect(within(ok).getByTestId("provider-balance").textContent).toContain("1234"));
    expect(await within(ok).findByText("Aakash SMS (v3)")).toBeTruthy();
    expect(within(ok).queryByTestId("dlr-callback-url")).toBeNull();

    expect(within(bad).getByText("Error")).toBeTruthy();
    expect(within(bad).getByText(/The provider rejected the token or login/)).toBeTruthy();
    expect(within(bad).getByText("HTTP 401: invalid API key")).toBeTruthy();
    expect(within(bad).getByText("No messages sent yet")).toBeTruthy();
    expect(within(bad).queryByTestId("provider-balance")).toBeNull();
    const cb = await within(bad).findByTestId("dlr-callback-url");
    expect(cb.textContent).toContain("https://sms.example.com/v1/provider-dlr/SECRETTOKEN");
    expect(within(cb).getByRole("button", { name: "Copy" })).toBeTruthy();

    // refresh the balance on demand
    const before = calls.filter((c) => c.path === "/api/connections/h1/balance").length;
    fireEvent.click(within(ok).getByRole("button", { name: "Refresh provider balance" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/connections/h1/balance").length).toBe(before + 1));
  });

  it("send test SMS dialog validates, posts {to, text} and shows the masked request + response", async () => {
    const { CarrierStatusCard } = await import("@/components/routes/carrier-status-card");
    wrap(<CarrierStatusCard routeId="r1" />);
    const [ok] = await screen.findAllByTestId("http-carrier-row");
    fireEvent.click(within(ok).getByRole("button", { name: /Send test SMS/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "abc" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Send test/ }));
    expect(await within(dialog).findByText(/Digits only/)).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith("/test"))).toBe(false);

    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "98 0000 0000" } });
    fireEvent.change(within(dialog).getByLabelText("Message"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /Send test/ }));
    });
    const result = await within(dialog).findByTestId("test-send-result");
    expect(calls.find((c) => c.path === "/api/connections/h1/test")?.body).toEqual({ to: "9800000000", text: "hello" });
    expect(within(result).getByText("Accepted by the provider")).toBeTruthy();
    expect(result.textContent).toContain("auth_token=****");
    expect(result.textContent).toContain('{"error":false}');
    expect(result.textContent).toContain("prov-9");
  });

  it("send test SMS failure shows the error in plain words", async () => {
    const { CarrierStatusCard } = await import("@/components/routes/carrier-status-card");
    wrap(<CarrierStatusCard routeId="r1" />);
    const [, bad] = await screen.findAllByTestId("http-carrier-row");
    fireEvent.click(within(bad).getByRole("button", { name: /Send test SMS/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "9800000000" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /Send test/ }));
    });
    const result = await within(dialog).findByTestId("test-send-result");
    expect(within(result).getByText("Failed")).toBeTruthy();
    expect(result.textContent).toContain("The provider rejected the token or login");
  });

  it("new route: HTTP API row → provider dropdown (grouped, best-effort badge) → catalogue fields → request", async () => {
    const { NewRouteForm } = await import("@/components/routes/new-route-form");
    wrap(<NewRouteForm />);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "NP OTP" } });
    await pick(screen.getByRole("combobox", { name: "Connection type" }), /HTTP API/);
    const row = await screen.findByTestId("http-row");
    const provider = await within(row).findByRole("combobox", { name: "Provider" });
    await waitFor(() => expect(provider.textContent).toContain("Pick a provider"));

    // submit without a provider → error from the catalogue-aware schema
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create route" }));
    });
    // the trigger placeholder + the field error
    await waitFor(() => expect(within(row).getAllByText("Pick a provider").length).toBe(2));

    fireEvent.keyDown(provider, { key: "ArrowDown" });
    expect(await screen.findByText("Nepal")).toBeTruthy();
    expect(screen.getByText("Other providers (any country)")).toBeTruthy();
    expect(screen.getAllByText("Best effort").length).toBeGreaterThan(0);
    const opt = screen.getByRole("option", { name: /Aakash SMS/ });
    fireEvent.keyDown(opt, { key: "Enter" });
    fireEvent.click(opt);

    const token = (await within(row).findByLabelText(/Auth token/)) as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(within(row).getByTestId("adapter-info").textContent).toContain("Returns HTTP 200 on errors.");
    expect(within(row).getByRole("link", { name: /Provider API docs/ }).getAttribute("href")).toBe("https://aakashsms.com/documentation/");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create route" }));
    });
    expect(await within(row).findByText("Required")).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/routes/quick")).toBe(false);

    fireEvent.change(token, { target: { value: "tok-123" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create route" }));
    });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/routes/quick")).toBe(true));
    const body = calls.find((c) => c.path === "/api/routes/quick")?.body as { connections: unknown[] };
    expect(body.connections).toEqual([{ type: "HTTP", adapter: "aakash_v3", credentials: { auth_token: "tok-123" }, max_tps: 50, priority: 1 }]);
  });

  it("generic_http shows the template editor with an example that fills the settings", async () => {
    const { NewRouteForm } = await import("@/components/routes/new-route-form");
    wrap(<NewRouteForm />);
    await pick(await screen.findByRole("combobox", { name: "Connection type" }), /HTTP API/);
    const row = await screen.findByTestId("http-row");
    const provider = await within(row).findByRole("combobox", { name: "Provider" });
    await waitFor(() => expect(provider.textContent).toContain("Pick a provider"));
    await pick(provider, /Generic HTTP API/);
    const help = await within(row).findByTestId("generic-http-help");
    expect(help.textContent).toContain("{to_local}");
    fireEvent.click(within(help).getByRole("button", { name: "Use this example" }));
    await waitFor(() => expect((within(row).getByLabelText(/URL template/) as HTMLInputElement).value).toBe("https://api.example-sms.com/v1/send"));
    expect((within(row).getByLabelText(/Parameters template/) as HTMLTextAreaElement).value).toContain('"to": "{to_local}"');
  });

  it("connection detail edits an HTTP connection with write-only credentials", async () => {
    const { ConnectionDetail } = await import("@/components/connections/connection-detail");
    wrap(<ConnectionDetail id="h1" />);
    const form = await screen.findByRole("form", { name: "HTTP API connection" });
    expect(await within(form).findByText("Saved. Leave blank to keep it.")).toBeTruthy();
    expect(within(form).getByText("Set")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Aakash primary" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    });
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Aakash primary" });

    calls.length = 0;
    fireEvent.change(within(form).getByLabelText(/Auth token/), { target: { value: "new-token" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    });
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")?.body as Record<string, unknown>;
    expect(patch.credentials).toEqual({ auth_token: "new-token" });
    expect(patch).not.toHaveProperty("settings");
  });
});
