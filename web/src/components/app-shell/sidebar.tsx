"use client";

import { MessageSquareText } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "@/lib/nav";
import type { OrgRole } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

export function SidebarNav({ role, onNavigate }: { role: OrgRole; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 p-2">
      {NAV[role].map((item) => {
        const active = isActivePath(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              active && "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function BrandMark({ brand }: { brand: string }) {
  return (
    <Link href="/dashboard" className="flex min-w-0 items-center gap-2 font-semibold">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <MessageSquareText className="h-4 w-4" aria-hidden />
      </span>
      <span className="truncate">{brand}</span>
    </Link>
  );
}

export function DesktopSidebar({ role, brand }: { role: OrgRole; brand: string }) {
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
      <div className="flex h-14 items-center border-b px-4">
        <BrandMark brand={brand} />
      </div>
      <div className="flex-1 overflow-y-auto">
        <SidebarNav role={role} />
      </div>
    </aside>
  );
}
