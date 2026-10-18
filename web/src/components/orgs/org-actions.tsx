"use client";

import { LogIn, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, errorMessage, qk } from "@/lib/api";
import type { OrgDetail } from "@/lib/api/types";
import { useAuth } from "@/lib/auth/session";
import { toast } from "sonner";
import { KIND, type OrgKind } from "./kind";

/** Suspend (with reason) / Activate toggle. Suspending also kicks SMPP sessions (api side). */
export function SuspendActivateButton({ org, kind }: { org: OrgDetail; kind: OrgKind }) {
  const k = KIND[kind];
  const invalidate = [qk.orgs.all, qk.auditLogs.all];
  const suspend = useApiMutation({
    mutationFn: (reason: string) => api.orgs.suspend(org.id, { reason }),
    success: `${k.singular} suspended`,
    invalidate,
  });
  const activate = useApiMutation({
    mutationFn: () => api.orgs.activate(org.id),
    success: `${k.singular} activated`,
    invalidate,
  });

  if (org.status === "SUSPENDED") {
    return (
      <ConfirmDialog
        trigger={
          <Button variant="outline">
            <Play /> Activate
          </Button>
        }
        title={`Activate ${org.name}?`}
        description={
          kind === "reseller"
            ? "The reseller and all of its clients will be able to log in and send again (subject to their own state)."
            : "The client will be able to log in and send again."
        }
        confirmLabel="Activate"
        destructive={false}
        onConfirm={() => activate.mutateAsync()}
      />
    );
  }
  return (
    <ConfirmDialog
      trigger={
        <Button variant="destructive" disabled={org.status === "CLOSED"}>
          <Pause /> Suspend
        </Button>
      }
      title={`Suspend ${org.name}?`}
      description={
        kind === "reseller"
          ? "Blocks login and sending for this reseller AND all of its clients. Active SMPP sessions are disconnected."
          : "Blocks login and sending for this client. Active SMPP sessions are disconnected."
      }
      reason={{ label: "Reason (shown to the account and in the audit log)", placeholder: "e.g. Unpaid invoice #1042" }}
      confirmLabel="Suspend"
      onConfirm={(reason) => suspend.mutateAsync(reason)}
    />
  );
}

/** Impersonate the org ("Login as"). Audited by the api. */
export function LoginAsButton({ org }: { org: OrgDetail }) {
  const { impersonate } = useAuth();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" disabled={org.status !== "ACTIVE"}>
          <LogIn /> Login as
        </Button>
      }
      title={`Log in as ${org.name}?`}
      description="You'll see the panel exactly as this account does. Every action is recorded in the audit log with you as the impersonator. Use “Return to my account” in the banner to come back."
      confirmLabel="Login as"
      destructive={false}
      onConfirm={async () => {
        try {
          await impersonate(org.id);
          toast.success(`Now acting as ${org.name}`);
        } catch (e) {
          toast.error("Couldn't log in as this account", { description: errorMessage(e) });
          throw e;
        }
      }}
    />
  );
}
