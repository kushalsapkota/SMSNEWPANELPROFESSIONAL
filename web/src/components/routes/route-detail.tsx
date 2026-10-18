"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState, FullPageSpinner } from "@/components/shared/states";
import { BoolBadge } from "@/components/shared/status-badge";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { UpdateRouteRequest } from "@/lib/api/types";
import { RouteConnectionsEditor } from "./route-connections-editor";
import { RouteForm } from "./route-form";

export function RouteDetailView({ id }: { id: string }) {
  const router = useRouter();
  const q = useQuery({ queryKey: qk.routes.detail(id), queryFn: () => api.routes.get(id) });
  const save = useApiMutation({
    mutationFn: (body: UpdateRouteRequest) => api.routes.update(id, body),
    success: "Route saved",
    invalidate: [qk.routes.all],
  });
  const remove = useApiMutation({
    mutationFn: () => api.routes.remove(id),
    success: "Route deleted",
    invalidate: [qk.routes.all, qk.orgs.all, qk.templates.all],
    onSuccess: () => router.push("/routes"),
  });

  if (q.isLoading) return <FullPageSpinner />;
  if (q.isError || !q.data) {
    return (
      <>
        <PageHeader title="Route" back={{ href: "/routes", label: "Routes" }} />
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      </>
    );
  }
  const r = q.data;
  return (
    <>
      <PageHeader
        back={{ href: "/routes", label: "Routes" }}
        title={r.name}
        description={<BoolBadge value={r.enabled} />}
        actions={
          <>
            {r.template_mode ? (
              <Button variant="outline" asChild>
                <Link href={`/templates?route_id=${r.id}`}>
                  <FileText /> Templates
                </Link>
              </Button>
            ) : null}
            <ConfirmDialog
              trigger={
                <Button variant="destructive">
                  <Trash2 /> Delete
                </Button>
              }
              title={`Delete route “${r.name}”?`}
              description="Removes the route, its templates and every reseller/client assignment. Traffic on it is rejected immediately."
              confirmText={r.name}
              confirmLabel="Delete route"
              onConfirm={() => remove.mutateAsync()}
            />
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Settings</CardTitle>
            <CardDescription>Template mode, fallback and forced sender.</CardDescription>
          </CardHeader>
          <CardContent>
            <RouteForm route={r} pending={save.isPending} onSubmit={(b) => save.mutate(b)} submitLabel="Save route" />
          </CardContent>
        </Card>
        <div className="min-w-0 xl:col-span-3">
          <RouteConnectionsEditor route={r} />
        </div>
      </div>
    </>
  );
}
