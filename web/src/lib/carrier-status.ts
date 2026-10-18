import type { RouteConnectionState } from "./api/types";

/** Badge tone + label for a connection's live state (route "Carrier status" card). */
export function connectionStateView(state: RouteConnectionState): {
  label: string;
  tone: "success" | "warning" | "destructive" | "muted";
} {
  switch (state) {
    case "BOUND":
      return { label: "Bound", tone: "success" };
    case "CONNECTING":
      return { label: "Connecting", tone: "warning" };
    case "DOWN":
      return { label: "Down", tone: "destructive" };
    case "DISABLED":
      return { label: "Disabled", tone: "muted" };
    case "READY":
      return { label: "Ready", tone: "success" };
    case "ERROR":
      return { label: "Error", tone: "destructive" };
    default:
      return { label: "Waiting for engine", tone: "muted" };
  }
}

/** SMPP bind_resp command_status → what the admin should check. */
const BIND_STATUS: Record<string, string> = {
  ESME_RINVPASWD: "Wrong username or password",
  ESME_RINVSYSID: "Wrong username or password",
  ESME_RBINDFAIL: "The carrier refused the login. Check the username, password, bind type and that the carrier has whitelisted our IP",
  ESME_RALYBND: "The carrier says this account is already bound. Lower the number of sessions or ask the carrier to free the old ones",
  ESME_RINVSYSTYP: "Wrong system type. Ask the carrier for the right value (often empty)",
  ESME_RTHROTTLED: "The carrier is throttling login attempts. It retries automatically",
  ESME_RINVBNDSTS: "The carrier does not accept this bind type. Try TX or TRX",
  ESME_RSYSERR: "The carrier had an internal error while logging in. It retries automatically",
};

/**
 * Turns the engine's raw `last_error` (Go error text, e.g. "smpp client: bind rejected:
 * ESME_RINVPASWD" or "dial: dial tcp 10.0.0.5:2775: connect: connection refused") into
 * plain words. Returns null when there is no error.
 */
export function describeConnectionError(raw: string | null | undefined, ep?: { host: string | null; port: number | null }): string | null {
  if (!raw) return null;
  const e = raw.toLowerCase();
  const endpoint = ep && ep.host ? { host: ep.host, port: ep.port ?? 0 } : undefined;
  const where = endpoint ? `${endpoint.host}:${endpoint.port}` : "the host";

  const bind = /bind rejected: (\S+)/i.exec(raw);
  if (bind) {
    const code = bind[1];
    return BIND_STATUS[code] ?? `The carrier rejected the login (${code})`;
  }
  if (e.includes("password cannot be decrypted")) return "The stored password cannot be decrypted. Enter the password again";
  if (e.includes("no such host") || e.includes("server misbehaving")) {
    return endpoint ? `Host name “${endpoint.host}” not found (DNS)` : "Host name not found (DNS)";
  }
  if (e.includes("connection refused")) return `Cannot reach ${where}: connection refused (wrong port, or the carrier is not listening)`;
  if (e.includes("no route to host") || e.includes("network is unreachable") || e.includes("host is unreachable")) {
    return `Cannot reach ${where}: no network route`;
  }
  if (e.startsWith("dial") && (e.includes("timeout") || e.includes("deadline exceeded"))) {
    return `Cannot reach ${where}: timed out (firewall, wrong IP or our IP is not whitelisted)`;
  }
  if (e.includes("tls") || e.includes("x509") || e.includes("certificate")) {
    return "TLS handshake failed. Check the TLS switch and the port";
  }
  if (e.startsWith("bind") && (e.includes("timeout") || e.includes("deadline exceeded"))) {
    return `Connected to ${where}, but the carrier did not answer the login. Check the port and the TLS switch`;
  }
  if (e.includes("connection reset") || e.endsWith("eof") || e.includes("broken pipe")) {
    return "The carrier closed the connection. Our IP may not be whitelisted, or TLS is on at one end only";
  }
  if (e.includes("client closed")) return "Connection stopped";
  if (e.includes("enquire_link") || e.includes("keepalive")) return "The carrier stopped answering keep-alives. Reconnecting";
  return raw;
}

/**
 * HTTP API connections: the engine's `last_error` (e.g. "HTTP 401: invalid token",
 * "Post \"https://…\": context deadline exceeded") in plain words. Returns null without an error.
 */
export function describeHttpError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.toLowerCase();
  const status = /\b(?:http|status)[ :]*([1-5][0-9]{2})\b/i.exec(raw)?.[1];
  if (e.includes("cannot be decrypted") || e.includes("decrypt")) return "The stored credentials cannot be decrypted. Enter the token again";
  if (/(ip|address)[^a-z]*(not )?(allowed|whitelist|white-list|restricted)|invalid ip/.test(e)) {
    return "The provider refused our IP address. Ask the provider to whitelist the gateway's IP";
  }
  if (/(insufficient|not enough|no) (balance|credit)|insufficient_balance|insufficient_credits/.test(e)) return "Not enough credit at the provider. Top up the provider account";
  if (status === "401" || status === "403" || /(invalid|expired|wrong|bad)[^.]{0,20}(token|api key|key|credential)|(token|key|credentials?) is not valid|unauthori[sz]ed|authentication/.test(e)) {
    return "The provider rejected the token or login. Check the credentials";
  }
  if (status === "429" || e.includes("rate limit") || e.includes("too many requests")) return "The provider is rate limiting us. Lower the TPS; it retries automatically";
  if (e.includes("no such host") || e.includes("server misbehaving")) return "The provider's host name was not found (DNS). Check the API base URL";
  if (e.includes("connection refused")) return "Cannot reach the provider: connection refused. Check the API base URL";
  if (e.includes("deadline exceeded") || e.includes("timeout") || e.includes("timed out")) return "The provider did not answer in time. It retries automatically";
  if (e.includes("x509") || e.includes("certificate") || e.includes("tls")) return "TLS/certificate error talking to the provider. Check the API base URL";
  if (status && status.startsWith("5")) return `The provider had an internal error (HTTP ${status}). It retries automatically`;
  if (status === "404") return "The provider says this API address does not exist (HTTP 404). Check the API base URL";
  if (e.includes("destination") && (e.includes("not supported") || e.includes("country"))) return "This provider does not deliver to that destination country";
  return raw;
}
