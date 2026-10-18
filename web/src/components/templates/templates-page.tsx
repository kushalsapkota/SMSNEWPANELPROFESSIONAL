"use client";

import { PageHeader } from "@/components/shared/page-header";
import { useSession } from "@/lib/auth/session";
import { TemplatesTable } from "./templates-table";

export function TemplatesPageView() {
  const { role } = useSession();
  return (
    <>
      <PageHeader
        title="Templates"
        description={
          role === "SUPER_ADMIN"
            ? "Route-wide OTP templates. On routes with template mode on, the OTP is extracted from the client's text and re-rendered with the template."
            : "Per-client template overrides. A client override replaces the route-wide template for that client only."
        }
      />
      <TemplatesTable />
    </>
  );
}
