import type { OrgRole } from "@/lib/api/types";

export type OrgKind = "reseller" | "client";

export const KIND: Record<
  OrgKind,
  { role: Extract<OrgRole, "RESELLER" | "CLIENT">; singular: string; plural: string; basePath: string }
> = {
  reseller: { role: "RESELLER", singular: "Reseller", plural: "Resellers", basePath: "/resellers" },
  client: { role: "CLIENT", singular: "Client", plural: "Clients", basePath: "/clients" },
};
