import type { Adapter, AdapterSettingField, Connection, CreateHttpConnectionRequest, UpdateConnectionRequest } from "./api/types";

/**
 * HTTP API connections (docs/providers/HTTP-CONNECTIONS-CONTRACT.md): everything the forms need
 * from the engine adapter catalogue (GET /api/connections/adapters), kept pure for tests.
 *
 * Form representation: credentials are strings (write-only; "" = not entered), settings are
 * strings (numbers/urls/selects/json typed as text) or booleans (bool settings).
 */

export type SettingFormValue = string | boolean;

export interface HttpFormValues {
  adapter: string;
  credentials: Record<string, string>;
  settings: Record<string, SettingFormValue>;
}

export interface FieldIssue {
  /** relative to the HTTP block: `adapter`, `credentials.<key>`, `settings.<key>` */
  path: string;
  message: string;
}

export const GENERIC_HTTP_ID = "generic_http";

/** Placeholders a generic_http template may use (besides any credential key, e.g. {token}). */
export const TEMPLATE_PLACEHOLDERS = ["{to}", "{to_local}", "{to_e164}", "{text}", "{sender}", "{message_id}"] as const;

/** Short worked example shown next to the generic_http template editor. */
export const GENERIC_HTTP_EXAMPLE = {
  method: "POST",
  url: "https://api.example-sms.com/v1/send",
  body_type: "json",
  params_template: '{\n  "api_key": "{token}",\n  "to": "{to_local}",\n  "from": "{sender}",\n  "message": "{text}"\n}',
  success: 'HTTP 200 and JSON "status" equals "success"; message id at "data.id"',
} as const;

const COUNTRY_NAMES: Record<string, string> = { NP: "Nepal", IN: "India", BD: "Bangladesh", PK: "Pakistan", LK: "Sri Lanka" };

export function countryLabel(code: string | null | undefined): string {
  if (!code) return "Any country";
  return COUNTRY_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}

/** Adapter dropdown groups: by country (alphabetical), country-less adapters (generic_http) last. */
export function groupAdaptersByCountry(adapters: Adapter[]): Array<{ country: string | null; label: string; adapters: Adapter[] }> {
  const groups = new Map<string, Adapter[]>();
  for (const a of adapters) {
    const k = a.country ?? "";
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : countryLabel(a).localeCompare(countryLabel(b))))
    .map(([k, list]) => ({
      country: k || null,
      label: k ? countryLabel(k) : "Other providers (any country)",
      adapters: [...list].sort((x, y) => x.name.localeCompare(y.name)),
    }));
}

export function isLikely(a: Pick<Adapter, "confidence">): boolean {
  return a.confidence === "LIKELY";
}

export function dlrModeText(mode: Adapter["dlr_mode"]): string {
  switch (mode) {
    case "callback":
      return "Delivery reports: the provider calls our callback URL (set it in the provider's dashboard).";
    case "poll":
      return "Delivery reports: fetched from the provider's report API periodically.";
    default:
      return "Delivery reports: none. Messages show as “Sent (provider gives no delivery report)”.";
  }
}

export type SettingInput = "switch" | "select" | "number" | "textarea" | "url" | "text";

export function settingInput(f: AdapterSettingField): SettingInput {
  if (f.type === "bool") return "switch";
  if (f.type === "select") return "select";
  if (f.type === "number") return "number";
  if (f.type === "json" || f.key.includes("template")) return "textarea";
  if (f.type === "url") return "url";
  return "text";
}

export function selectOptions(f: AdapterSettingField): Array<{ value: string; label: string }> {
  return (f.options ?? []).map((o) => (typeof o === "string" ? { value: o, label: o } : { value: String(o.value), label: o.label ?? String(o.value) }));
}

function hasDefault(f: AdapterSettingField): boolean {
  return f.default !== undefined && f.default !== null && f.default !== "";
}

/** Placeholder text showing the default the engine applies when the field is left blank. */
export function settingPlaceholder(f: AdapterSettingField): string | undefined {
  if (f.placeholder) return f.placeholder;
  if (!hasDefault(f)) return undefined;
  const d = typeof f.default === "string" ? f.default : JSON.stringify(f.default);
  return d.includes("\n") || d.length > 60 ? undefined : `Default: ${d}`;
}

function toFormValue(f: AdapterSettingField, v: unknown): SettingFormValue {
  if (f.type === "bool") return v === true || v === "true";
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}

/** Blank values for a newly picked adapter. Selects, switches and templates start at their default. */
export function initialHttpValues(adapter: Adapter | undefined, adapterId = adapter?.id ?? ""): HttpFormValues {
  const credentials: Record<string, string> = {};
  const settings: Record<string, SettingFormValue> = {};
  for (const c of adapter?.credentials ?? []) credentials[c.key] = "";
  for (const s of adapter?.settings ?? []) {
    const prefill = s.type === "bool" || s.type === "select" || settingInput(s) === "textarea";
    settings[s.key] = prefill && hasDefault(s) ? toFormValue(s, s.default) : s.type === "bool" ? false : "";
  }
  return { adapter: adapterId, credentials, settings };
}

/** Edit form values from a stored connection (credentials are never returned: all blank). */
export function httpValuesFromConnection(adapter: Adapter | undefined, adapterId: string, stored: Record<string, unknown>): HttpFormValues {
  const base = initialHttpValues(adapter, adapterId);
  for (const s of adapter?.settings ?? []) {
    if (stored[s.key] !== undefined) base.settings[s.key] = toFormValue(s, stored[s.key]);
  }
  return base;
}

/** http(s) URL that may contain {placeholders} (generic_http url template). */
export function isHttpUrlTemplate(v: string): boolean {
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    const u = new URL(v.replace(/\{[A-Za-z0-9_:./ -]*\}/g, "x"));
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.length > 0;
  } catch {
    return false;
  }
}

function settingError(f: AdapterSettingField, raw: SettingFormValue): string | null {
  if (typeof raw === "boolean") return null;
  const v = raw.trim();
  if (v === "") return null;
  const kind = settingInput(f);
  if (f.type === "number") return Number.isFinite(Number(v)) ? null : "Must be a number";
  if (f.type === "select") return selectOptions(f).some((o) => o.value === v) ? null : "Pick one of the options";
  if (f.type === "json" || (kind === "textarea" && v.startsWith("{"))) {
    try {
      const parsed: unknown = JSON.parse(v);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? null : "Must be a JSON object";
    } catch {
      return "Must be valid JSON (check quotes and commas)";
    }
  }
  if ((f.type === "url" || f.key === "url" || f.key.endsWith("_url")) && !isHttpUrlTemplate(v)) return "Must start with http:// or https://";
  return null;
}

/**
 * Validates the HTTP block against the catalogue. On edit, `credentialsSet` lists the stored
 * credentials: a required one left blank keeps its stored value (unless it is in `cleared`).
 */
export function validateHttpValues(
  adapters: Adapter[],
  v: HttpFormValues,
  opts: { credentialsSet?: string[]; cleared?: string[] } = {},
): FieldIssue[] {
  if (!v.adapter) return [{ path: "adapter", message: "Pick a provider" }];
  const adapter = adapters.find((a) => a.id === v.adapter);
  if (!adapter) return [{ path: "adapter", message: adapters.length ? "Unknown provider" : "Provider list is still loading" }];
  const issues: FieldIssue[] = [];
  const stored = new Set((opts.credentialsSet ?? []).filter((k) => !(opts.cleared ?? []).includes(k)));
  for (const c of adapter.credentials) {
    const val = v.credentials[c.key] ?? "";
    if (c.required && !val && !stored.has(c.key)) issues.push({ path: `credentials.${c.key}`, message: "Required" });
    else if (val.length > 4096) issues.push({ path: `credentials.${c.key}`, message: "Too long" });
  }
  for (const s of adapter.settings) {
    const raw = v.settings[s.key] ?? (s.type === "bool" ? false : "");
    const empty = typeof raw === "string" && raw.trim() === "";
    if (s.required && empty && !hasDefault(s)) {
      issues.push({ path: `settings.${s.key}`, message: "Required" });
      continue;
    }
    const err = settingError(s, raw);
    if (err) issues.push({ path: `settings.${s.key}`, message: err });
  }
  return issues;
}

/**
 * Request `credentials`: create → every entered value; edit → only newly entered values
 * (blank = keep) plus `""` for each explicitly cleared key (PATCH merge semantics).
 */
export function buildCredentials(adapter: Adapter, v: HttpFormValues, opts: { cleared?: string[] } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of adapter.credentials) {
    const val = v.credentials[c.key] ?? "";
    if (val) out[c.key] = val;
    else if (opts.cleared?.includes(c.key)) out[c.key] = "";
  }
  return out;
}

function toApiValue(f: AdapterSettingField, raw: SettingFormValue): unknown {
  if (f.type === "bool") return raw === true;
  const v = String(raw).trim();
  if (f.type === "number") return Number(v);
  if (f.type === "json") return JSON.parse(v) as unknown;
  return f.key.includes("template") ? String(raw) : v;
}

/**
 * Request `settings`. Create: every non-blank value (switches only when not at their default). Edit (`original` = stored
 * settings): only changed values; a value blanked on edit becomes `null` (back to the default).
 */
export function buildSettings(adapter: Adapter, v: HttpFormValues, opts: { original?: Record<string, unknown> } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of adapter.settings) {
    const raw = v.settings[s.key] ?? (s.type === "bool" ? false : "");
    const blank = typeof raw === "string" && raw.trim() === "";
    if (!opts.original) {
      // A switch left at its default need not be sent (the engine applies defaults).
      if (s.type === "bool" && raw === (s.default ?? false)) continue;
      if (!blank) out[s.key] = toApiValue(s, raw);
      continue;
    }
    const had = opts.original[s.key] !== undefined;
    if (blank) {
      if (had) out[s.key] = null;
      continue;
    }
    const next = toApiValue(s, raw);
    if (JSON.stringify(next) !== JSON.stringify(opts.original[s.key])) {
      // A bool equal to the default that was never stored need not be sent.
      if (!had && s.type === "bool" && next === (s.default ?? false)) continue;
      out[s.key] = next;
    }
  }
  return out;
}

/** The provider DLR callback URL to show: the api's absolute URL, else this panel's origin + path. */
export function callbackUrl(c: { dlr_callback_url: string | null; dlr_callback_path: string | null }, origin?: string): string | null {
  if (c.dlr_callback_url) return c.dlr_callback_url;
  if (!c.dlr_callback_path) return null;
  return `${(origin ?? "").replace(/\/+$/, "")}${c.dlr_callback_path}`;
}

export function adapterName(adapters: Adapter[] | undefined, id: string | null | undefined): string {
  if (!id) return "";
  return adapters?.find((a) => a.id === id)?.name ?? id;
}

/** Standalone HTTP connection form (connections page, route status card Edit). */
export interface HttpConnectionFormValues {
  name: string;
  max_tps: number | null;
  enabled: boolean;
  http: HttpFormValues;
}

export function validateHttpConnectionForm(
  adapters: Adapter[],
  v: HttpConnectionFormValues,
  opts: { credentialsSet?: string[]; cleared?: string[] } = {},
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (!v.name.trim()) issues.push({ path: "name", message: "Required" });
  else if (v.name.trim().length > 100) issues.push({ path: "name", message: "Max 100 characters" });
  if (v.max_tps !== null && (!Number.isInteger(v.max_tps) || v.max_tps < 1)) issues.push({ path: "max_tps", message: "≥ 1" });
  for (const i of validateHttpValues(adapters, v.http, opts)) issues.push({ path: `http.${i.path}`, message: i.message });
  return issues;
}

export function toHttpCreateRequest(adapter: Adapter, v: HttpConnectionFormValues): CreateHttpConnectionRequest {
  const settings = buildSettings(adapter, v.http);
  return {
    kind: "HTTP",
    name: v.name.trim(),
    adapter: adapter.id,
    credentials: buildCredentials(adapter, v.http),
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(v.max_tps !== null ? { max_tps: v.max_tps } : {}),
    enabled: v.enabled,
  };
}

/** PATCH body with only what changed (credentials: new values + cleared keys; settings: diff). */
export function toHttpUpdateRequest(
  adapter: Adapter,
  v: HttpConnectionFormValues,
  original: Pick<Connection, "name" | "max_tps" | "enabled" | "adapter" | "settings">,
  cleared: string[] = [],
): UpdateConnectionRequest {
  const out: UpdateConnectionRequest = {};
  if (v.name.trim() !== original.name) out.name = v.name.trim();
  if (v.max_tps !== null && v.max_tps !== original.max_tps) out.max_tps = v.max_tps;
  if (v.enabled !== original.enabled) out.enabled = v.enabled;
  const switched = adapter.id !== original.adapter;
  if (switched) out.adapter = adapter.id;
  const credentials = buildCredentials(adapter, v.http, { cleared });
  if (Object.keys(credentials).length) out.credentials = credentials;
  const settings = buildSettings(adapter, v.http, { original: switched ? {} : original.settings });
  if (Object.keys(settings).length) out.settings = settings;
  return out;
}

/** dlr_stat the engine sets for providers without delivery reports (dlr_mode "none"). */
export const NO_DLR_STAT = "NODLR";
export const NO_DLR_LABEL = "Sent (provider gives no delivery report)";

/** Badge label for a message: NODLR messages read “Sent (provider gives no delivery report)”. */
export function messageStatusLabel(m: { status: string; dlr_stat: string | null }): string | undefined {
  return m.dlr_stat === NO_DLR_STAT ? NO_DLR_LABEL : undefined;
}
