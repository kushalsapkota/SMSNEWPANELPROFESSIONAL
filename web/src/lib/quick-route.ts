import { z } from "zod";
import type { Adapter, QuickConnectionInput, QuickRouteRequest } from "./api/types";
import { buildCredentials, buildSettings, initialHttpValues, validateHttpValues } from "./http-adapters";
import { isValidSender } from "./phone";
import { hostSchema } from "./validation";

/** "New route" form (POST /api/routes/quick). Row order = priority (1 = primary, 2 = backup, …). */

export type ConnectionKind = "SMPP" | "EXISTING" | "HTTP";

const optInt = (min: number, max: number) =>
  z.number({ invalid_type_error: "Whole number" }).int("Whole number").min(min, `≥ ${min}`).max(max, `≤ ${max}`).nullable();

const httpBlockSchema = z.object({
  adapter: z.string(),
  credentials: z.record(z.string()),
  settings: z.record(z.union([z.string(), z.boolean()])),
});

/** Row schema; HTTP rows are validated against the adapter catalogue (`adapters`). */
export const makeConnectionRowSchema = (adapters: Adapter[]) => z
  .object({
    kind: z.enum(["SMPP", "EXISTING", "HTTP"]),
    /** HTTP API row: provider adapter + credentials/settings rendered from the catalogue. */
    http: httpBlockSchema,
    existing_connection_id: z.string(),
    host: z.string(),
    port: z.number({ invalid_type_error: "Required" }).nullable(),
    system_id: z.string(),
    password: z.string(),
    bind_type: z.enum(["TX", "RX", "TRX"]),
    max_tps: z.number({ invalid_type_error: "Required" }).nullable(),
    use_tls: z.boolean(),
    // advanced
    system_type: z.string().max(12, "Max 12 characters"),
    sessions: optInt(1, 64),
    window_size: optInt(1, 1000),
    enquire_link_interval_s: optInt(1, 3600),
    multipart_mode: z.enum(["UDH", "SAR", "PAYLOAD"]),
    request_dlr: z.boolean(),
    cost_micros: z.number().int().nonnegative("Must be ≥ 0").nullable(),
  })
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: path.split("."), message });
    if (r.kind === "HTTP") {
      for (const i of validateHttpValues(adapters, r.http)) issue(`http.${i.path}`, i.message);
      if (r.max_tps !== null && (!Number.isInteger(r.max_tps) || r.max_tps < 1)) issue("max_tps", "≥ 1");
      return;
    }
    if (r.kind === "EXISTING") {
      if (!r.existing_connection_id) issue("existing_connection_id", "Pick a connection");
      return;
    }
    const host = hostSchema.safeParse(r.host);
    if (!host.success) issue("host", host.error.issues[0].message);
    if (r.port === null) issue("port", "Required");
    else if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) issue("port", "Port must be 1-65535");
    if (!r.system_id.trim()) issue("system_id", "Required");
    else if (r.system_id.length > 15) issue("system_id", "Max 15 characters (SMPP 3.4)");
    if (!r.password) issue("password", "Required");
    else if (r.password.length > 8) issue("password", "Max 8 characters (SMPP 3.4)");
    if (r.max_tps === null) issue("max_tps", "Required");
    else if (!Number.isInteger(r.max_tps) || r.max_tps < 1) issue("max_tps", "≥ 1");
  });

export const connectionRowSchema = makeConnectionRowSchema([]);

export type ConnectionRow = z.infer<typeof connectionRowSchema>;

export const makeQuickRouteSchema = (adapters: Adapter[]) => z
  .object({
    name: z.string().trim().min(1, "Required").max(100),
    description: z.string().trim().max(2000),
    enabled: z.boolean(),
    template_mode: z.boolean(),
    template_fallback: z.enum(["REJECT", "SEND_RAW", "SEND_DEFAULT_TEMPLATE"]),
    template_body: z.string().max(1600),
    default_body: z.string().max(1600),
    force_sender_id: z
      .string()
      .trim()
      .max(16)
      .refine((v) => v === "" || isValidSender(v), "Alphanumeric ≤ 11 chars or numeric ≤ 15 digits"),
    connections: z.array(makeConnectionRowSchema(adapters)).min(1, "Add at least one connection").max(10, "At most 10 connections"),
  })
  .superRefine((v, ctx) => {
    if (v.template_mode) {
      if (!v.template_body.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["template_body"], message: "Required in template mode" });
      else if (!v.template_body.includes("{otp}")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["template_body"], message: "Must contain {otp}" });
      if (v.template_fallback === "SEND_DEFAULT_TEMPLATE" && !v.default_body.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["default_body"], message: "Required when fallback is “Send default template”" });
      }
    }
    const seen = new Map<string, number>();
    v.connections.forEach((r, i) => {
      if (r.kind !== "EXISTING" || !r.existing_connection_id) return;
      if (seen.has(r.existing_connection_id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["connections", i, "existing_connection_id"], message: "Already added above" });
      }
      seen.set(r.existing_connection_id, i);
    });
    const endpoints = new Set<string>();
    v.connections.forEach((r, i) => {
      if (r.kind !== "SMPP") return;
      const key = `${r.host.trim().toLowerCase()}|${r.port}|${r.system_id}`;
      if (endpoints.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["connections", i, "host"], message: "Same host, port and username as another row" });
      }
      endpoints.add(key);
    });
  });

/** Without a catalogue (HTTP rows then report “Provider list is still loading”). */
export const quickRouteSchema = makeQuickRouteSchema([]);

export type QuickRouteValues = z.infer<typeof quickRouteSchema>;

export function newConnectionRow(kind: ConnectionKind = "SMPP"): ConnectionRow {
  return {
    kind,
    http: initialHttpValues(undefined),
    existing_connection_id: "",
    host: "",
    port: 2775,
    system_id: "",
    password: "",
    bind_type: "TRX",
    max_tps: 50,
    use_tls: false,
    system_type: "",
    sessions: 1,
    window_size: null,
    enquire_link_interval_s: null,
    multipart_mode: "UDH",
    request_dlr: true,
    cost_micros: null,
  };
}

export const QUICK_ROUTE_DEFAULTS: QuickRouteValues = {
  name: "",
  description: "",
  enabled: true,
  template_mode: false,
  template_fallback: "SEND_RAW",
  template_body: "Your {brand} verification code is {otp}",
  default_body: "",
  force_sender_id: "",
  connections: [newConnectionRow()],
};

/** Row label shown next to the priority number. */
export function priorityLabel(index: number): string {
  return index === 0 ? "Primary" : index === 1 ? "Backup" : `Backup ${index}`;
}

/** Form values → request body. Priority = row order; only contract fields are sent (the api is .strict()). */
export function toQuickRouteRequest(v: QuickRouteValues, adapters: Adapter[] = []): QuickRouteRequest {
  const connections: QuickConnectionInput[] = v.connections.map((r, i) => {
    const priority = i + 1;
    if (r.kind === "EXISTING") return { existing_connection_id: r.existing_connection_id, priority };
    if (r.kind === "HTTP") {
      const adapter = adapters.find((a) => a.id === r.http.adapter);
      if (!adapter) throw new Error(`unknown adapter ${r.http.adapter}`);
      const settings = buildSettings(adapter, r.http);
      return {
        type: "HTTP",
        adapter: adapter.id,
        credentials: buildCredentials(adapter, r.http),
        ...(Object.keys(settings).length ? { settings } : {}),
        ...(r.max_tps !== null ? { max_tps: r.max_tps } : {}),
        priority,
        ...(r.cost_micros !== null ? { cost_micros: r.cost_micros } : {}),
      };
    }
    return {
      type: "SMPP",
      host: r.host.trim(),
      port: r.port as number,
      system_id: r.system_id.trim(),
      password: r.password,
      bind_type: r.bind_type,
      use_tls: r.use_tls,
      max_tps: r.max_tps as number,
      request_dlr: r.request_dlr,
      multipart_mode: r.multipart_mode,
      priority,
      ...(r.system_type ? { system_type: r.system_type } : {}),
      ...(r.sessions !== null ? { sessions: r.sessions } : {}),
      ...(r.window_size !== null ? { window_size: r.window_size } : {}),
      ...(r.enquire_link_interval_s !== null ? { enquire_link_interval_s: r.enquire_link_interval_s } : {}),
      ...(r.cost_micros !== null ? { cost_micros: r.cost_micros } : {}),
    };
  });
  return {
    name: v.name.trim(),
    description: v.description.trim() || null,
    enabled: v.enabled,
    template_mode: v.template_mode,
    template_fallback: v.template_fallback,
    force_sender_id: v.force_sender_id.trim() || null,
    ...(v.template_mode ? { template_body: v.template_body, default_body: v.default_body.trim() || null } : {}),
    connections,
  };
}

const FORM_FIELDS = new Set([
  "name",
  "description",
  "force_sender_id",
  "template_body",
  "default_body",
  "template_fallback",
  "kind",
  "existing_connection_id",
  "host",
  "port",
  "system_id",
  "password",
  "bind_type",
  "max_tps",
  "system_type",
  "sessions",
  "window_size",
  "enquire_link_interval_s",
  "multipart_mode",
  "cost_micros",
]);

/**
 * Field errors from an api error body (`details.issues[].path` on 400, `details.field` on
 * 400/409) as form paths (`connections.0.password`), so they show next to the input.
 */
export function serverFieldErrors(details: Record<string, unknown> | undefined, message: string): Array<{ path: string; message: string }> {
  if (!details) return [];
  const out: Array<{ path: string; message: string }> = [];
  const known = (p: string) => FORM_FIELDS.has(p.split(".").pop() ?? "");
  // HTTP rows: the api reports connections.<i>.credentials.<key> / settings.<key> / adapter;
  // the form keeps them under connections.<i>.http.
  const httpPath = (p: string) => /^connections\.\d+\.(credentials|settings)\.[^.]+$|^connections\.\d+\.adapter$/.test(p) ? p.replace(/^(connections\.\d+)\./, "$1.http.") : null;
  const issues = Array.isArray(details.issues) ? (details.issues as Array<{ path?: unknown; message?: unknown }>) : [];
  for (const i of issues) {
    if (typeof i.path !== "string" || typeof i.message !== "string") continue;
    const hp = httpPath(i.path);
    if (hp) out.push({ path: hp, message: i.message });
    else if (known(i.path)) out.push({ path: i.path, message: i.message });
  }
  if (typeof details.field === "string" && known(details.field)) out.push({ path: details.field, message });
  return out;
}

/** Route detail: edit an inline connection's endpoint/credentials (PATCH /api/connections/:id). */
export const connectionEndpointSchema = z.object({
  host: hostSchema,
  port: z.number({ invalid_type_error: "Required" }).int("Whole number").min(1, "Port must be 1-65535").max(65535, "Port must be 1-65535"),
  system_id: z.string().trim().min(1, "Required").max(15, "Max 15 characters (SMPP 3.4)"),
  /** Empty = keep the current password. */
  password: z.string().max(8, "Max 8 characters (SMPP 3.4)"),
});

export type ConnectionEndpointValues = z.infer<typeof connectionEndpointSchema>;

/** Only the changed fields; an empty password is omitted (write-only, keep current). */
export function toEndpointPatch(
  v: ConnectionEndpointValues,
  current: { host: string; port: number; system_id: string },
): Partial<{ host: string; port: number; system_id: string; password: string }> {
  const out: Partial<{ host: string; port: number; system_id: string; password: string }> = {};
  if (v.host.trim() !== current.host) out.host = v.host.trim();
  if (v.port !== current.port) out.port = v.port;
  if (v.system_id.trim() !== current.system_id) out.system_id = v.system_id.trim();
  if (v.password) out.password = v.password;
  return out;
}
