"use client";

import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, type ReactNode } from "react";
import { ForbiddenState, FullPageSpinner } from "@/components/shared/states";
import { useAuth } from "@/lib/auth/session";
import { canAccess } from "@/lib/nav";
import { Header } from "./header";
import { ImpersonationBanner } from "./impersonation-banner";
import { DesktopSidebar } from "./sidebar";

/**
 * Authenticated shell: redirects anonymous users to /login?next=…, enforces
 * per-role route access (lib/nav ROUTE_ACCESS) and renders sidebar + header.
 * Note: this is UX-level protection; the api enforces authorization.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { status, me } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [status, router, pathname]);

  if (status !== "authenticated" || !me) return <FullPageSpinner />;

  const role = me.org.role;
  const brand = me.brand_name || me.org.brand_name || "SMS Gateway";

  return (
    <div className="flex min-h-screen flex-col">
      <ImpersonationBanner />
      <div className="flex flex-1">
        <DesktopSidebar role={role} brand={brand} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Header brand={brand} />
          <main id="main" className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
            <div className="mx-auto w-full max-w-7xl">
              {canAccess(role, pathname) ? (
                <Suspense fallback={<FullPageSpinner />}>{children}</Suspense>
              ) : (
                <ForbiddenState />
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
