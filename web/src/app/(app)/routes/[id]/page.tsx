"use client";

import { RouteDetailView } from "@/components/routes/route-detail";
import { ForbiddenState } from "@/components/shared/states";
import { useSession } from "@/lib/auth/session";

export default function Page({ params }: { params: { id: string } }) {
  const { role } = useSession();
  if (role !== "SUPER_ADMIN") return <ForbiddenState />;
  return <RouteDetailView id={params.id} />;
}
