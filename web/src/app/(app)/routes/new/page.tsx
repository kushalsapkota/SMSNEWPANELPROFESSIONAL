"use client";

import { NewRouteForm } from "@/components/routes/new-route-form";
import { PageHeader } from "@/components/shared/page-header";
import { ForbiddenState } from "@/components/shared/states";
import { useSession } from "@/lib/auth/session";

export default function Page() {
  const { role } = useSession();
  if (role !== "SUPER_ADMIN") return <ForbiddenState />;
  return (
    <>
      <PageHeader
        back={{ href: "/routes", label: "Routes" }}
        title="New route"
        description="Name the route and add your carrier's SMPP details. It connects as soon as you save."
      />
      <NewRouteForm />
    </>
  );
}
