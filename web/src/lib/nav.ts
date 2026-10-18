import {
  Activity,
  BarChart3,
  Ban,
  Building2,
  FileText,
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Megaphone,
  MessageSquareText,
  Network,
  Route as RouteIcon,
  ScrollText,
  Send,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { OrgRole } from "@/lib/api/types";

/**
 * Sidebar + route access (CONTRACTS §12). One source of truth: the sidebar
 * renders NAV[role] and the (app) layout guard uses `canAccess()`.
 */

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const item = (href: string, label: string, icon: LucideIcon): NavItem => ({ href, label, icon });

export const NAV: Record<OrgRole, NavItem[]> = {
  SUPER_ADMIN: [
    item("/dashboard", "Dashboard", LayoutDashboard),
    item("/resellers", "Resellers", Building2),
    item("/connections", "Connections", Network),
    item("/routes", "Routes", RouteIcon),
    item("/templates", "Templates", FileText),
    item("/monitor", "Monitor", Activity),
    item("/messages", "Messages", MessageSquareText),
    item("/analytics", "Analytics", BarChart3),
    item("/tester", "Tester", FlaskConical),
    item("/sender-ids", "Sender IDs", ShieldCheck),
    item("/blocklist", "Blocklist", Ban),
    item("/audit-log", "Audit log", ScrollText),
    item("/settings", "Settings", Settings),
  ],
  RESELLER: [
    item("/dashboard", "Dashboard", LayoutDashboard),
    item("/clients", "Clients", Users),
    item("/routes", "Routes", RouteIcon),
    item("/templates", "Templates", FileText),
    item("/sender-ids", "Sender IDs", ShieldCheck),
    item("/monitor", "Monitor", Activity),
    item("/messages", "Messages", MessageSquareText),
    item("/analytics", "Analytics", BarChart3),
    item("/tester", "Tester", FlaskConical),
    item("/blocklist", "Blocklist", Ban),
    item("/audit-log", "Audit log", ScrollText),
    item("/settings", "Settings", Settings),
  ],
  CLIENT: [
    item("/dashboard", "Dashboard", LayoutDashboard),
    item("/send", "Send SMS", Send),
    item("/campaigns", "Campaigns", Megaphone),
    item("/messages", "Messages", MessageSquareText),
    item("/analytics", "Analytics", BarChart3),
    item("/developer", "API & SMPP", KeyRound),
    item("/sender-ids", "Sender IDs", ShieldCheck),
    item("/settings", "Settings", Settings),
  ],
};

const ALL: OrgRole[] = ["SUPER_ADMIN", "RESELLER", "CLIENT"];

/** Path prefix → roles allowed. First match wins; unknown paths are allowed for all. */
export const ROUTE_ACCESS: Array<{ prefix: string; roles: OrgRole[] }> = [
  { prefix: "/resellers", roles: ["SUPER_ADMIN"] },
  { prefix: "/connections", roles: ["SUPER_ADMIN"] },
  { prefix: "/monitor", roles: ["SUPER_ADMIN", "RESELLER"] },
  { prefix: "/clients", roles: ["RESELLER"] },
  { prefix: "/routes", roles: ["SUPER_ADMIN", "RESELLER"] },
  { prefix: "/templates", roles: ["SUPER_ADMIN", "RESELLER"] },
  { prefix: "/tester", roles: ["SUPER_ADMIN", "RESELLER"] },
  { prefix: "/blocklist", roles: ["SUPER_ADMIN", "RESELLER"] },
  { prefix: "/audit-log", roles: ["SUPER_ADMIN", "RESELLER"] },
  { prefix: "/send", roles: ["CLIENT"] },
  { prefix: "/campaigns", roles: ["CLIENT"] },
  { prefix: "/developer", roles: ["CLIENT"] },
  { prefix: "/sender-ids", roles: ALL },
  { prefix: "/messages", roles: ALL },
  { prefix: "/analytics", roles: ALL },
  { prefix: "/settings", roles: ALL },
  { prefix: "/dashboard", roles: ALL },
];

export function canAccess(role: OrgRole, pathname: string): boolean {
  const rule = ROUTE_ACCESS.find(
    (r) => pathname === r.prefix || pathname.startsWith(r.prefix + "/"),
  );
  return rule ? rule.roles.includes(role) : true;
}

export const ROLE_LABEL: Record<OrgRole, string> = {
  SUPER_ADMIN: "Super admin",
  RESELLER: "Reseller",
  CLIENT: "Client",
};

/** Label for the child org type the acting role manages. */
export function childKind(role: OrgRole): "reseller" | "client" | null {
  if (role === "SUPER_ADMIN") return "reseller";
  if (role === "RESELLER") return "client";
  return null;
}
