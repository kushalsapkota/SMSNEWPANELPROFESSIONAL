import { describe, expect, it } from "vitest";
import type { Adapter } from "@/lib/api/types";
import { connectionStateView, describeHttpError } from "@/lib/carrier-status";
import {
  buildCredentials,
  buildSettings,
  callbackUrl,
  groupAdaptersByCountry,
  httpValuesFromConnection,
  initialHttpValues,
  isHttpUrlTemplate,
  messageStatusLabel,
  settingInput,
  toHttpCreateRequest,
  toHttpUpdateRequest,
  validateHttpConnectionForm,
  validateHttpValues,
  type HttpFormValues,
} from "@/lib/http-adapters";
import { QUICK_ROUTE_DEFAULTS, makeQuickRouteSchema, newConnectionRow, serverFieldErrors, toQuickRouteRequest, type QuickRouteValues } from "@/lib/quick-route";

const A = (over: Partial<Adapter> & Pick<Adapter, "id">): Adapter => ({
  name: over.id,
  country: "NP",
  confidence: "VERIFIED",
  credentials: [],
  settings: [],
  dlr_mode: "none",
  supports_balance: false,
  destination_countries: ["NP"],
  ...over,
});

const aakash = A({
  id: "aakash_v3",
  name: "Aakash SMS (v3)",
  credentials: [{ key: "auth_token", label: "Auth token", secret: true, required: true }],
  settings: [
    { key: "base_url", label: "API base URL", type: "url", default: "https://sms.aakashsms.com", required: false },
    { key: "dlr_poll_interval_s", label: "Poll interval", type: "number", default: 60, required: false },
    { key: "verify_tls", label: "Verify TLS", type: "bool", default: true, required: false },
  ],
});
const mn = A({
  id: "messengernepal",
  name: "MessengerNepal",
  dlr_mode: "callback",
  credentials: [
    { key: "token", label: "API Key", secret: true, required: true },
    { key: "webhook_secret", label: "Webhook secret", secret: true, required: false },
  ],
  settings: [{ key: "sender", label: "Sender", type: "string", required: false }],
});
const nest = A({ id: "nestsms", name: "Nest SMS", confidence: "LIKELY", settings: [{ key: "base_url", label: "Base", type: "url", default: null, required: true }] });
const generic = A({
  id: "generic_http",
  name: "Generic HTTP API",
  country: null,
  destination_countries: null,
  credentials: [{ key: "token", label: "Token", secret: true, required: false }],
  settings: [
    { key: "method", label: "Method", type: "select", default: "POST", options: ["GET", { value: "POST", label: "Post" }], required: true },
    { key: "url", label: "URL", type: "url", default: null, required: true },
    { key: "params_template", label: "Params", type: "string", default: '{"to":"{to}"}', required: true },
  ],
});
const ADAPTERS = [generic, mn, nest, aakash, A({ id: "in_x", name: "India X", country: "IN" })];

const vals = (adapter: Adapter, over: Partial<HttpFormValues> = {}): HttpFormValues => ({ ...initialHttpValues(adapter), ...over });

describe("catalogue helpers", () => {
  it("groups adapters by country (alphabetical), country-less last, names sorted", () => {
    const g = groupAdaptersByCountry(ADAPTERS);
    expect(g.map((x) => x.label)).toEqual(["India", "Nepal", "Other providers (any country)"]);
    expect(g[1].adapters.map((a) => a.id)).toEqual(["aakash_v3", "messengernepal", "nestsms"]);
    expect(g[2].adapters.map((a) => a.id)).toEqual(["generic_http"]);
  });

  it("initial values: blank credentials, defaults prefilled for select/bool/templates only", () => {
    expect(initialHttpValues(aakash)).toEqual({
      adapter: "aakash_v3",
      credentials: { auth_token: "" },
      settings: { base_url: "", dlr_poll_interval_s: "", verify_tls: true },
    });
    expect(initialHttpValues(generic).settings).toEqual({ method: "POST", url: "", params_template: '{"to":"{to}"}' });
    expect(settingInput(generic.settings[2])).toBe("textarea");
    expect(httpValuesFromConnection(aakash, "aakash_v3", { dlr_poll_interval_s: 30, verify_tls: false }).settings).toEqual({
      base_url: "",
      dlr_poll_interval_s: "30",
      verify_tls: false,
    });
  });

  it("url templates", () => {
    expect(isHttpUrlTemplate("https://api.x.com/send?to={to}&key={token}")).toBe(true);
    expect(isHttpUrlTemplate("ftp://x")).toBe(false);
    expect(isHttpUrlTemplate("{base_url}/x")).toBe(false);
  });
});

describe("validateHttpValues (dynamic form validation from the catalogue)", () => {
  it("needs a known provider", () => {
    expect(validateHttpValues(ADAPTERS, vals(aakash, { adapter: "" }))).toEqual([{ path: "adapter", message: "Pick a provider" }]);
    expect(validateHttpValues([], vals(aakash))).toEqual([{ path: "adapter", message: "Provider list is still loading" }]);
    expect(validateHttpValues(ADAPTERS, vals(aakash, { adapter: "gone" }))).toEqual([{ path: "adapter", message: "Unknown provider" }]);
  });

  it("required credentials on create; stored ones count on edit unless cleared", () => {
    expect(validateHttpValues(ADAPTERS, vals(aakash))).toEqual([{ path: "credentials.auth_token", message: "Required" }]);
    expect(validateHttpValues(ADAPTERS, vals(aakash), { credentialsSet: ["auth_token"] })).toEqual([]);
    expect(validateHttpValues(ADAPTERS, vals(aakash), { credentialsSet: ["auth_token"], cleared: ["auth_token"] })).toHaveLength(1);
    expect(validateHttpValues(ADAPTERS, vals(aakash, { credentials: { auth_token: "t" } }))).toEqual([]);
  });

  it("typed settings: number, url, select, JSON template, required without default", () => {
    const bad = vals(aakash, { credentials: { auth_token: "t" }, settings: { base_url: "sms.aakashsms.com", dlr_poll_interval_s: "often", verify_tls: true } });
    expect(validateHttpValues(ADAPTERS, bad)).toEqual([
      { path: "settings.base_url", message: "Must start with http:// or https://" },
      { path: "settings.dlr_poll_interval_s", message: "Must be a number" },
    ]);
    expect(validateHttpValues(ADAPTERS, vals(nest))).toEqual([{ path: "settings.base_url", message: "Required" }]);
    const g = vals(generic, { settings: { method: "PUT", url: "https://x.example/{to}", params_template: "{bad json" } });
    expect(validateHttpValues(ADAPTERS, g)).toEqual([
      { path: "settings.method", message: "Pick one of the options" },
      { path: "settings.params_template", message: "Must be valid JSON (check quotes and commas)" },
    ]);
    expect(validateHttpValues(ADAPTERS, vals(generic, { settings: { method: "GET", url: "", params_template: "{}" } }))).toEqual([
      { path: "settings.url", message: "Required" },
    ]);
  });

  it("connection form adds name / TPS checks", () => {
    const v = { name: " ", max_tps: 0, enabled: true, http: vals(aakash, { credentials: { auth_token: "t" } }) };
    expect(validateHttpConnectionForm(ADAPTERS, v).map((i) => i.path)).toEqual(["name", "max_tps"]);
  });
});

describe("request building", () => {
  it("create: entered credentials, typed non-blank settings", () => {
    const v = vals(aakash, { credentials: { auth_token: "tok" }, settings: { base_url: "", dlr_poll_interval_s: "30", verify_tls: false } });
    expect(buildCredentials(aakash, v)).toEqual({ auth_token: "tok" });
    expect(buildSettings(aakash, v)).toEqual({ dlr_poll_interval_s: 30, verify_tls: false });
    expect(toHttpCreateRequest(aakash, { name: " Aakash ", max_tps: null, enabled: true, http: v })).toEqual({
      kind: "HTTP",
      name: "Aakash",
      adapter: "aakash_v3",
      credentials: { auth_token: "tok" },
      settings: { dlr_poll_interval_s: 30, verify_tls: false },
      enabled: true,
    });
  });

  it("edit: only new credentials (+ \"\" for cleared), settings diff with null for blanked", () => {
    const original = { name: "MN", max_tps: 10, enabled: true, adapter: "messengernepal", settings: { sender: "ACME" } };
    const unchanged = { name: "MN", max_tps: 10, enabled: true, http: httpValuesFromConnection(mn, "messengernepal", original.settings) };
    expect(toHttpUpdateRequest(mn, unchanged, original)).toEqual({});
    const changed = { ...unchanged, max_tps: 20, http: { ...unchanged.http, credentials: { token: "new", webhook_secret: "" }, settings: { sender: "" } } };
    expect(toHttpUpdateRequest(mn, changed, original, ["webhook_secret"])).toEqual({
      max_tps: 20,
      credentials: { token: "new", webhook_secret: "" },
      settings: { sender: null },
    });
  });

  it("callback URL falls back to origin + path; NODLR label", () => {
    expect(callbackUrl({ dlr_callback_url: "https://a/v1/provider-dlr/t", dlr_callback_path: "/v1/provider-dlr/t" })).toBe("https://a/v1/provider-dlr/t");
    expect(callbackUrl({ dlr_callback_url: null, dlr_callback_path: "/v1/provider-dlr/t" }, "https://panel.example/")).toBe("https://panel.example/v1/provider-dlr/t");
    expect(callbackUrl({ dlr_callback_url: null, dlr_callback_path: null })).toBeNull();
    expect(messageStatusLabel({ status: "SUBMITTED", dlr_stat: "NODLR" })).toBe("Sent (provider gives no delivery report)");
    expect(messageStatusLabel({ status: "DELIVERED", dlr_stat: "DELIVRD" })).toBeUndefined();
  });
});

describe("quick route with HTTP rows", () => {
  const httpRow = (over: Partial<HttpFormValues> = {}) => ({ ...newConnectionRow("HTTP"), max_tps: 25, http: vals(aakash, over) });
  const values = (connections: QuickRouteValues["connections"]): QuickRouteValues => ({ ...QUICK_ROUTE_DEFAULTS, name: "NP OTP", connections });
  const paths = (v: QuickRouteValues) => {
    const r = makeQuickRouteSchema(ADAPTERS).safeParse(v);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };

  it("validates HTTP rows against the catalogue", () => {
    expect(paths(values([httpRow()]))).toEqual(["connections.0.http.credentials.auth_token: Required"]);
    expect(paths(values([httpRow({ credentials: { auth_token: "t" } })]))).toEqual([]);
  });

  it("builds mixed SMPP + HTTP requests in row order", () => {
    const smpp = { ...newConnectionRow(), host: "smsc.example.net", system_id: "acme", password: "pw" };
    const body = toQuickRouteRequest(values([smpp, { ...httpRow({ credentials: { auth_token: "t" } }), cost_micros: 900 }]), ADAPTERS);
    expect(body.connections[1]).toEqual({ type: "HTTP", adapter: "aakash_v3", credentials: { auth_token: "t" }, max_tps: 25, priority: 2, cost_micros: 900 });
    expect(body.connections[0]).toMatchObject({ type: "SMPP", priority: 1 });
  });

  it("maps api HTTP field errors under the row's http block", () => {
    expect(
      serverFieldErrors(
        {
          issues: [
            { path: "connections.1.credentials.auth_token", message: "Auth token is required" },
            { path: "connections.1.adapter", message: "unknown adapter" },
            { path: "connections.0.password", message: "x" },
          ],
        },
        "bad",
      ),
    ).toEqual([
      { path: "connections.1.http.credentials.auth_token", message: "Auth token is required" },
      { path: "connections.1.http.adapter", message: "unknown adapter" },
      { path: "connections.0.password", message: "x" },
    ]);
  });
});

describe("HTTP status mapping", () => {
  it("READY / ERROR badges", () => {
    expect(connectionStateView("READY")).toEqual({ label: "Ready", tone: "success" });
    expect(connectionStateView("ERROR")).toEqual({ label: "Error", tone: "destructive" });
  });
  it.each([
    [null, null],
    ["HTTP 401: invalid token", "The provider rejected the token or login. Check the credentials"],
    ["HTTP 200 error=true: The provided Auth Token is not valid.", "The provider rejected the token or login. Check the credentials"],
    ["HTTP 403 response_code=1001 Invalid IP Address", "The provider refused our IP address. Ask the provider to whitelist the gateway's IP"],
    ["error=true: Not enough balance.", "Not enough credit at the provider. Top up the provider account"],
    ["HTTP 429: RATE_LIMIT_EXCEEDED", "The provider is rate limiting us. Lower the TPS; it retries automatically"],
    ['Post "https://sms.aakashsms.com/sms/v3/send": context deadline exceeded', "The provider did not answer in time. It retries automatically"],
    ["dial tcp: lookup api.bad.example: no such host", "The provider's host name was not found (DNS). Check the API base URL"],
    ["HTTP 503: upstream", "The provider had an internal error (HTTP 503). It retries automatically"],
    ["something odd", "something odd"],
  ])("describes %s", (raw, words) => {
    expect(describeHttpError(raw)).toBe(words);
  });
});
