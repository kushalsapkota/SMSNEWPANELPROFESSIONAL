"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { api, onSessionExpired, qk } from "@/lib/api";
import type { LoginRequest, LoginResponse, MeResponse, OrgRole, Uuid } from "@/lib/api/types";
import { decodeJwt, tokenStore } from "./token-store";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  me: MeResponse | null;
  role: OrgRole | null;
  /** Returns the login response; when `requires_totp` the caller shows the TOTP step. */
  login: (body: LoginRequest) => Promise<LoginResponse>;
  logout: () => Promise<void>;
  impersonate: (orgId: Uuid) => Promise<void>;
  stopImpersonation: () => Promise<void>;
  refetchMe: () => Promise<unknown>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function useHasTokens(): boolean {
  return useSyncExternalStore(
    (cb) => tokenStore.subscribe(cb),
    () => tokenStore.get() !== null,
    () => false,
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const hasTokens = useHasTokens();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const meQuery = useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => api.auth.me(signal),
    enabled: hydrated && hasTokens,
    staleTime: 60_000,
    retry: (count, err) =>
      count < 2 && !(err && typeof err === "object" && "status" in err && err.status === 401),
  });

  useEffect(
    () =>
      onSessionExpired(() => {
        queryClient.clear();
        const next = pathname && pathname !== "/login" ? `?next=${encodeURIComponent(pathname)}` : "";
        router.replace(`/login${next}`);
      }),
    [queryClient, router, pathname],
  );

  const resetSession = useCallback(async () => {
    queryClient.clear();
    await queryClient.fetchQuery({ queryKey: qk.me, queryFn: ({ signal }) => api.auth.me(signal) });
  }, [queryClient]);

  const login = useCallback(
    async (body: LoginRequest) => {
      const res = await api.auth.login(body);
      if ("access_token" in res) {
        tokenStore.set({ access_token: res.access_token, refresh_token: res.refresh_token });
        queryClient.clear();
        await queryClient.fetchQuery({ queryKey: qk.me, queryFn: ({ signal }) => api.auth.me(signal) });
      }
      return res;
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    const tokens = tokenStore.get();
    if (tokens) {
      try {
        await api.auth.logout({ refresh_token: tokens.refresh_token });
      } catch {
        /* the local session is dropped regardless */
      }
    }
    tokenStore.clear();
    queryClient.clear();
    router.replace("/login");
  }, [queryClient, router]);

  const impersonate = useCallback(
    async (orgId: Uuid) => {
      const pair = await api.auth.impersonate({ org_id: orgId });
      tokenStore.set(pair);
      await resetSession();
      router.push("/dashboard");
    },
    [resetSession, router],
  );

  const stopImpersonation = useCallback(async () => {
    const pair = await api.auth.stopImpersonation();
    tokenStore.set(pair);
    await resetSession();
    router.push("/dashboard");
  }, [resetSession, router]);

  const status: AuthStatus = !hydrated
    ? "loading"
    : !hasTokens
      ? "unauthenticated"
      : meQuery.data
        ? "authenticated"
        : meQuery.isError
          ? "unauthenticated"
          : "loading";

  // A /me failure that is not a transient network error means the session is unusable.
  useEffect(() => {
    if (meQuery.isError && hasTokens) {
      const err = meQuery.error as { status?: number } | null;
      if (err?.status === 401 || err?.status === 403) tokenStore.clear();
    }
  }, [meQuery.isError, meQuery.error, hasTokens]);

  const refetch = meQuery.refetch;
  const me = status === "authenticated" ? (meQuery.data ?? null) : null;
  const role = me?.org.role ?? null;

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      me,
      role,
      login,
      logout,
      impersonate,
      stopImpersonation,
      refetchMe: refetch,
    }),
    [status, me, role, login, logout, impersonate, stopImpersonation, refetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** For pages under the (app) layout, where the session is guaranteed. */
export function useSession(): MeResponse & { role: OrgRole } {
  const { me } = useAuth();
  if (!me) throw new Error("useSession used outside an authenticated layout");
  return { ...me, role: me.org.role };
}

/** True when the current access token carries an impersonator claim. */
export function tokenIsImpersonating(): boolean {
  const t = tokenStore.get();
  return !!(t && decodeJwt(t.access_token)?.imp);
}
