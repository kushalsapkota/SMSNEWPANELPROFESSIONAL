import type { JwtClaims, TokenPair } from "@/lib/api/types";

/**
 * Token persistence. Access + refresh tokens live in localStorage so a reload
 * keeps the session, and an in-memory copy avoids hitting storage on every
 * request. Other tabs are kept in sync through the `storage` event.
 */

const ACCESS_KEY = "smsgw.access_token";
const REFRESH_KEY = "smsgw.refresh_token";

type Listener = (tokens: TokenPair | null) => void;

let memory: TokenPair | null | undefined;
const listeners = new Set<Listener>();

function hasStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

function readStorage(): TokenPair | null {
  if (!hasStorage()) return null;
  try {
    const access_token = window.localStorage.getItem(ACCESS_KEY);
    const refresh_token = window.localStorage.getItem(REFRESH_KEY);
    if (access_token && refresh_token) return { access_token, refresh_token };
  } catch {
    /* storage blocked */
  }
  return null;
}

function emit() {
  const value = memory ?? null;
  listeners.forEach((l) => l(value));
}

export const tokenStore = {
  get(): TokenPair | null {
    if (memory === undefined) memory = readStorage();
    return memory;
  },
  set(tokens: TokenPair) {
    memory = tokens;
    if (hasStorage()) {
      try {
        window.localStorage.setItem(ACCESS_KEY, tokens.access_token);
        window.localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
      } catch {
        /* storage blocked: session lasts for this tab only */
      }
    }
    emit();
  },
  clear() {
    memory = null;
    if (hasStorage()) {
      try {
        window.localStorage.removeItem(ACCESS_KEY);
        window.localStorage.removeItem(REFRESH_KEY);
      } catch {
        /* ignore */
      }
    }
    emit();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === ACCESS_KEY || e.key === REFRESH_KEY || e.key === null) {
      memory = readStorage();
      emit();
    }
  });
}

/** Decode (without verifying) the JWT payload. Returns null for malformed tokens. */
export function decodeJwt(token: string): JwtClaims | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json =
      typeof atob === "function"
        ? decodeURIComponent(
            Array.from(atob(padded))
              .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
              .join(""),
          )
        : Buffer.from(padded, "base64").toString("utf8");
    const claims = JSON.parse(json) as Partial<JwtClaims>;
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    return claims as JwtClaims;
  } catch {
    return null;
  }
}

/** True when the access token expires within `skewSeconds`. */
export function isExpiringSoon(token: string, skewSeconds = 30): boolean {
  const claims = decodeJwt(token);
  if (!claims) return false;
  return claims.exp * 1000 - Date.now() < skewSeconds * 1000;
}
