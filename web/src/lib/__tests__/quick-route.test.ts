import { describe, expect, it } from "vitest";
import {
  QUICK_ROUTE_DEFAULTS,
  connectionEndpointSchema,
  newConnectionRow,
  priorityLabel,
  quickRouteSchema,
  serverFieldErrors,
  toEndpointPatch,
  toQuickRouteRequest,
  type QuickRouteValues,
} from "@/lib/quick-route";
import { isHostOrIp } from "@/lib/validation";

const smpp = (over: Partial<ReturnType<typeof newConnectionRow>> = {}) => ({
  ...newConnectionRow(),
  host: "smsc.example.net",
  system_id: "acme",
  password: "secret",
  ...over,
});
const values = (over: Partial<QuickRouteValues> = {}): QuickRouteValues => ({
  ...QUICK_ROUTE_DEFAULTS,
  name: "IN OTP",
  connections: [smpp()],
  ...over,
});
const paths = (v: QuickRouteValues) => {
  const r = quickRouteSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("isHostOrIp", () => {
  it.each(["smsc.example.net", "localhost", "10.0.0.5", "::1", "[2001:db8::1]", "a-b.c"])("accepts %s", (h) => expect(isHostOrIp(h)).toBe(true));
  it.each(["", "bad host", "999.1.1.1", "-x.com", "smsc_.net", "http://x", "1.2.3"])("rejects %s", (h) => expect(isHostOrIp(h)).toBe(false));
});

describe("quickRouteSchema", () => {
  it("accepts a minimal SMPP route with defaults (port 2775, TRX, 50 TPS)", () => {
    expect(paths(values())).toEqual([]);
    const row = newConnectionRow();
    expect([row.port, row.bind_type, row.max_tps, row.use_tls, row.request_dlr]).toEqual([2775, "TRX", 50, false, true]);
  });
  it("validates SMPP fields per row", () => {
    expect(paths(values({ connections: [smpp({ password: "123456789" })] }))).toEqual(["connections.0.password: Max 8 characters (SMPP 3.4)"]);
    expect(paths(values({ connections: [smpp({ host: "bad host", port: 70000, system_id: "x".repeat(16), max_tps: null })] }))).toEqual([
      "connections.0.host: Enter a host name (smsc.example.net) or an IP address",
      "connections.0.port: Port must be 1-65535",
      "connections.0.system_id: Max 15 characters (SMPP 3.4)",
      "connections.0.max_tps: Required",
    ]);
    expect(paths(values({ connections: [smpp({ password: "" })] }))).toEqual(["connections.0.password: Required"]);
  });
  it("existing rows need a connection and no duplicates; HTTP is not allowed yet", () => {
    const ex = (id: string) => ({ ...newConnectionRow("EXISTING"), existing_connection_id: id });
    expect(paths(values({ connections: [ex("")] }))).toEqual(["connections.0.existing_connection_id: Pick a connection"]);
    expect(paths(values({ connections: [ex("a"), ex("a")] }))).toEqual(["connections.1.existing_connection_id: Already added above"]);
    expect(paths(values({ connections: [newConnectionRow("HTTP")] }))).toEqual(["connections.0.kind: HTTP API connections are coming soon"]);
    expect(paths(values({ connections: [] }))).toEqual(["connections: Add at least one connection"]);
    expect(paths(values({ connections: [smpp(), smpp()] }))).toEqual(["connections.1.host: Same host, port and username as another row"]);
  });
  it("template mode needs a body with {otp}", () => {
    expect(paths(values({ template_mode: true, template_body: "" }))).toEqual(["template_body: Required in template mode"]);
    expect(paths(values({ template_mode: true, template_body: "Your code" }))).toEqual(["template_body: Must contain {otp}"]);
    expect(paths(values({ template_mode: true, template_fallback: "SEND_DEFAULT_TEMPLATE" }))).toEqual([
      "default_body: Required when fallback is “Send default template”",
    ]);
    expect(paths(values({ template_mode: false, template_body: "no otp" }))).toEqual([]);
  });
  it("rejects bad forced senders", () => {
    expect(paths(values({ force_sender_id: "BAD!SENDER" }))).toEqual(["force_sender_id: Alphanumeric ≤ 11 chars or numeric ≤ 15 digits"]);
  });
});

describe("toQuickRouteRequest", () => {
  it("numbers priorities by row order and sends only contract fields", () => {
    const body = toQuickRouteRequest(
      values({
        description: "  ",
        connections: [smpp({ cost_micros: 2500, window_size: 20 }), { ...newConnectionRow("EXISTING"), existing_connection_id: "c-2" }],
      }),
    );
    expect(body).toEqual({
      name: "IN OTP",
      description: null,
      enabled: true,
      template_mode: false,
      template_fallback: "SEND_RAW",
      force_sender_id: null,
      connections: [
        {
          type: "SMPP",
          host: "smsc.example.net",
          port: 2775,
          system_id: "acme",
          password: "secret",
          bind_type: "TRX",
          use_tls: false,
          max_tps: 50,
          request_dlr: true,
          multipart_mode: "UDH",
          priority: 1,
          sessions: 1,
          window_size: 20,
          cost_micros: 2500,
        },
        { existing_connection_id: "c-2", priority: 2 },
      ],
    });
  });
  it("includes the template only in template mode", () => {
    const body = toQuickRouteRequest(values({ template_mode: true, template_body: "Code {otp}", default_body: "" }));
    expect(body).toMatchObject({ template_mode: true, template_body: "Code {otp}", default_body: null });
    expect(toQuickRouteRequest(values())).not.toHaveProperty("template_body");
  });
  it("labels priorities", () => {
    expect([0, 1, 2].map(priorityLabel)).toEqual(["Primary", "Backup", "Backup 2"]);
  });
});

describe("serverFieldErrors", () => {
  it("maps api issues and conflict fields to form paths", () => {
    expect(
      serverFieldErrors({ issues: [{ path: "connections.0.password", message: "SMPP 3.4 passwords are at most 8 characters" }, { path: "connections", message: "x" }] }, "Request validation failed"),
    ).toEqual([{ path: "connections.0.password", message: "SMPP 3.4 passwords are at most 8 characters" }]);
    expect(serverFieldErrors({ field: "name", constraint: "routes_name_key" }, "A route named “X” already exists")).toEqual([
      { path: "name", message: "A route named “X” already exists" },
    ]);
    expect(serverFieldErrors(undefined, "x")).toEqual([]);
  });
});

describe("connection endpoint edit", () => {
  const current = { host: "10.0.0.5", port: 2775, system_id: "acme" };
  it("validates", () => {
    expect(connectionEndpointSchema.safeParse({ ...current, password: "123456789" }).success).toBe(false);
    expect(connectionEndpointSchema.safeParse({ ...current, host: "x y", password: "" }).success).toBe(false);
    expect(connectionEndpointSchema.safeParse({ ...current, password: "" }).success).toBe(true);
  });
  it("patches only changed fields; blank password keeps the current one", () => {
    expect(toEndpointPatch({ ...current, password: "" }, current)).toEqual({});
    expect(toEndpointPatch({ ...current, port: 2776, password: "n3w" }, current)).toEqual({ port: 2776, password: "n3w" });
  });
});
