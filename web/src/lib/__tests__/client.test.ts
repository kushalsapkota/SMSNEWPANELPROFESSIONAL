import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HTTP client: auth header, error mapping and single-flight refresh on 401.
 * Runs in node with a fake fetch; tokenStore falls back to memory (no window).
 */

function jwt(expSecondsFromNow: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "u1", org: "o1", role: "CLIENT", exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("api client", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes once for concurrent 401s and retries every request", async () => {
    const { tokenStore } = await import("@/lib/auth/token-store");
    const { http } = await import("@/lib/api/client");
    const stale = jwt(600);
    const fresh = jwt(900);
    tokenStore.set({ access_token: stale, refresh_token: "r1" });

    let refreshCalls = 0;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/auth/refresh") {
        refreshCalls++;
        expect(JSON.parse(String(init.body))).toEqual({ refresh_token: "r1" });
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { access_token: fresh, refresh_token: "r2" });
      }
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === `Bearer ${fresh}` ? json(200, { ok: url }) : json(401, { error_code: "UNAUTHORIZED", message: "expired" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.all([http.get("/api/a"), http.get("/api/b"), http.get("/api/c")]);
    expect(results).toEqual([{ ok: "/api/a" }, { ok: "/api/b" }, { ok: "/api/c" }]);
    expect(refreshCalls).toBe(1);
    expect(tokenStore.get()).toEqual({ access_token: fresh, refresh_token: "r2" });
  });

  it("clears the session and notifies when refresh fails", async () => {
    const { tokenStore } = await import("@/lib/auth/token-store");
    const { http, onSessionExpired, ApiError } = await import("@/lib/api/client");
    tokenStore.set({ access_token: jwt(600), refresh_token: "bad" });
    const expired = vi.fn();
    onSessionExpired(expired);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/auth/refresh" ? json(401, { error_code: "UNAUTHORIZED", message: "revoked" }) : json(401, { error_code: "UNAUTHORIZED", message: "nope" }),
      ),
    );
    await expect(http.get("/api/x")).rejects.toBeInstanceOf(ApiError);
    expect(tokenStore.get()).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("refreshes proactively when the access token is about to expire", async () => {
    const { tokenStore } = await import("@/lib/auth/token-store");
    const { http } = await import("@/lib/api/client");
    const fresh = jwt(900);
    tokenStore.set({ access_token: jwt(5), refresh_token: "r1" });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return url === "/api/auth/refresh" ? json(200, { access_token: fresh, refresh_token: "r2" }) : json(200, { ok: true });
      }),
    );
    await http.get("/api/me");
    expect(calls).toEqual(["/api/auth/refresh", "/api/me"]);
  });

  it("maps error bodies to ApiError with the contract error_code", async () => {
    const { tokenStore } = await import("@/lib/auth/token-store");
    const { http, ApiError } = await import("@/lib/api/client");
    tokenStore.set({ access_token: jwt(600), refresh_token: "r" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(422, { error_code: "INSUFFICIENT_FUNDS", message: "Balance too low", details: { need: 5 } })),
    );
    const err = await http.post("/api/messages/send", { to: "1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: "INSUFFICIENT_FUNDS", message: "Balance too low", details: { need: 5 } });
  });

  it("serializes query params, skipping empty values", async () => {
    const { buildQuery } = await import("@/lib/api/client");
    expect(buildQuery({ page: 2, q: "", status: undefined, ids: ["a", "b"], flag: true })).toBe("?page=2&ids=a&ids=b&flag=true");
    expect(buildQuery({})).toBe("");
  });
});
