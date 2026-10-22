"use client";

import { Ban, LogIn, Pause, Play, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
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

  if (org.status === "SUSPENDED" || org.status === "CLOSED") {
    const wasClosed = org.status === "CLOSED";
    return (
      <ConfirmDialog
        trigger={
          <Button variant="outline">
            <Play /> {wasClosed ? "Re-open" : "Activate"}
          </Button>
        }
        title={`${wasClosed ? "Re-open" : "Activate"} ${org.name}?`}
        description={
          kind === "reseller"
            ? "The reseller and all of its clients will be able to log in and send again (subject to their own state). Channels that were turned off on close stay off until you re-enable them."
            : "The client will be able to log in and send again. Channels that were turned off on close stay off until you re-enable them."
        }
        confirmLabel={wasClosed ? "Re-open" : "Activate"}
        destructive={false}
        onConfirm={() => activate.mutateAsync()}
      />
    );
  }
  return (
    <ConfirmDialog
      trigger={
        <Button variant="destructive">
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

/**
 * Close (reversible) and permanently delete. Closing turns all channels off and logs everyone
 * out; it is undone by Activate. Permanent delete is gated behind typing the org name and is only
 * allowed once the org is closed/suspended and has no sub-orgs (the api enforces both).
 */
export function DeleteOrgButton({ org, kind }: { org: OrgDetail; kind: OrgKind }) {
  const k = KIND[kind];
  const router = useRouter();
  const invalidate = [qk.orgs.all, qk.auditLogs.all];
  const close = useApiMutation({
    mutationFn: () => api.orgs.remove(org.id),
    success: `${k.singular} closed`,
    invalidate,
  });
  const purge = useApiMutation({
    mutationFn: () => api.orgs.remove(org.id, { purge: true }),
    success: `${k.singular} permanently deleted`,
    invalidate,
  });
  const canPurge = org.status === "CLOSED" || org.status === "SUSPENDED";

  return (
    <>
      {org.status !== "CLOSED" ? (
        <ConfirmDialog
          trigger={
            <Button variant="outline">
              <Ban /> Close
            </Button>
          }
          title={`Close ${org.name}?`}
          description={
            kind === "reseller"
              ? "Turns off sending, API and SMPP for this reseller and all of its clients, and logs everyone out. Billing history is kept and you can re-open it later with Activate."
              : "Turns off sending, API and SMPP for this client and logs everyone out. Billing history is kept and you can re-open it later with Activate."
          }
          confirmLabel="Close"
          onConfirm={() => close.mutateAsync()}
        />
      ) : null}
      <ConfirmDialog
        trigger={
          <Button variant="destructive" disabled={!canPurge} title={canPurge ? undefined : "Close this account first"}>
            <Trash2 /> Delete permanently
          </Button>
        }
        title={`Permanently delete ${org.name}?`}
        description={
          <div className="space-y-2">
            <p>
              This cannot be undone. It removes the {k.singular.toLowerCase()}, its users, balance,
              SMPP accounts, API keys, sender IDs, webhooks and route assignments.
            </p>
            <p className="text-muted-foreground">
              Message history and audit logs are kept for the record.
              {kind === "reseller" ? " A reseller with sub-clients cannot be deleted until those are removed." : ""}
            </p>
          </div>
        }
        confirmText={org.name}
        confirmLabel="Delete permanently"
        onConfirm={async () => {
          await purge.mutateAsync();
          router.push(k.basePath);
        }}
      />
    </>
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
