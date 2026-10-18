"use client";

import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState, FullPageSpinner } from "@/components/shared/states";
import { BoolBadge } from "@/components/shared/status-badge";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useTabParam } from "@/hooks/use-tab-param";
import { api, qk } from "@/lib/api";
import type { UpdateConnectionRequest } from "@/lib/api/types";
import { ConnectionForm } from "./connection-form";
import { RatesEditor } from "./rates-editor";

const TABS = ["settings", "rates"] as const;

export function ConnectionDetail({ id }: { id: string }) {
  const router = useRouter();
  const [tab, setTab] = useTabParam(TABS, "settings");
  const q = useQuery({ queryKey: qk.connections.detail(id), queryFn: () => api.connections.get(id) });
  const save = useApiMutation({
    mutationFn: (body: UpdateConnectionRequest) => api.connections.update(id, body),
    success: "Connection saved — the engine will rebind",
    invalidate: [qk.connections.all, qk.monitor.all],
  });
  const remove = useApiMutation({
    mutationFn: () => api.connections.remove(id),
    success: "Connection deleted",
    invalidate: [qk.connections.all, qk.routes.all],
    onSuccess: () => router.push("/connections"),
  });

  if (q.isLoading) return <FullPageSpinner />;
  if (q.isError || !q.data) {
    return (
      <>
        <PageHeader title="Connection" back={{ href: "/connections", label: "Connections" }} />
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      </>
    );
  }
  const c = q.data;
  return (
    <>
      <PageHeader
        back={{ href: "/connections", label: "Connections" }}
        title={c.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <BoolBadge value={c.enabled} />
            <code className="text-xs">
              {c.system_id}@{c.host}:{c.port}
            </code>
          </span>
        }
        actions={
          <ConfirmDialog
            trigger={
              <Button variant="destructive">
                <Trash2 /> Delete
              </Button>
            }
            title={`Delete connection “${c.name}”?`}
            description="The engine unbinds it immediately and it is removed from every route. Routes left without connections stop accepting traffic."
            confirmText={c.name}
            confirmLabel="Delete connection"
            onConfirm={() => remove.mutateAsync()}
          />
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="rates">Rates</TabsTrigger>
        </TabsList>
        <TabsContent value="settings" className="mt-6 space-y-6">
          <Card>
            <CardContent className="pt-6">
              <ConnectionForm connection={c} pending={save.isPending} onSubmit={(b) => save.mutate(b)} submitLabel="Save changes" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Used by routes</CardTitle>
            </CardHeader>
            <CardContent>
              {c.routes && c.routes.length ? (
                <ul className="divide-y text-sm">
                  {c.routes.map((r) => (
                    <li key={r.route_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <Link href={`/routes/${r.route_id}`} className="font-medium hover:underline">
                        {r.route_name}
                      </Link>
                      <span className="text-muted-foreground">
                        priority {r.priority} · weight {r.weight} · {r.enabled ? "enabled" : "disabled"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Not mapped to any route yet.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="rates" className="mt-6">
          <RatesEditor connectionId={c.id} />
        </TabsContent>
      </Tabs>
    </>
  );
}
