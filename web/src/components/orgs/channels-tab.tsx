"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { OrgDetail, UpdateChannelsRequest } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import type { OrgKind } from "./kind";

type Flag = keyof UpdateChannelsRequest;

const FLAGS: Array<{ key: Flag; label: string; description: string; offWarning: string }> = [
  {
    key: "sending_enabled",
    label: "Sending",
    description: "Master switch. Off = “stop sending” on every channel while login stays possible.",
    offWarning: "All new messages from this account will be rejected with SENDING_DISABLED.",
  },
  {
    key: "api_enabled",
    label: "HTTP API",
    description: "Allow sending through the public /v1 HTTP API.",
    offWarning: "HTTP API requests will be rejected with CHANNEL_DISABLED.",
  },
  {
    key: "smpp_enabled",
    label: "SMPP",
    description: "Allow binding SMPP accounts to the gateway.",
    offWarning: "Active SMPP sessions will be disconnected and new binds refused.",
  },
  {
    key: "web_enabled",
    label: "Web panel sending",
    description: "Allow quick send and campaigns from the web panel.",
    offWarning: "Sending from the web panel (quick send, campaigns) will be blocked.",
  },
];

export function ChannelsTab({ org, kind }: { org: OrgDetail; kind: OrgKind }) {
  const { role } = useSession();
  const [pendingOff, setPendingOff] = useState<Flag | null>(null);
  const [approvalOn, setApprovalOn] = useState(false);
  const update = useApiMutation({
    mutationFn: (body: UpdateChannelsRequest) => api.orgs.updateChannels(org.id, body),
    success: "Channels updated",
    invalidate: [qk.orgs.all],
  });
  const setApproval = useApiMutation({
    mutationFn: (required: boolean) => api.orgs.setContentApproval(org.id, required),
    success: "Content approval updated",
    invalidate: [qk.orgs.all],
  });

  const offFlag = FLAGS.find((f) => f.key === pendingOff);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Channels</CardTitle>
        <CardDescription>
          {kind === "reseller"
            ? "Turning a channel off for a reseller also blocks it for all of its clients."
            : "Per-client channel switches. The reseller's own switches still apply."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {FLAGS.map((f) => {
          const id = `channel-${f.key}`;
          const checked = org[f.key];
          return (
            <div key={f.key} className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor={id}>{f.label}</Label>
                <p className="text-sm text-muted-foreground">{f.description}</p>
              </div>
              <Switch
                id={id}
                checked={checked}
                disabled={update.isPending}
                onCheckedChange={(v) => {
                  if (!v) setPendingOff(f.key);
                  else update.mutate({ [f.key]: true });
                }}
              />
            </div>
          );
        })}
        {role === "SUPER_ADMIN" ? (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-dashed p-3">
            <div className="space-y-0.5">
              <Label htmlFor="content-approval">Require content approval</Label>
              <p className="text-sm text-muted-foreground">
                This account may only send message content a super admin has approved; anything else is rejected
                (CONTENT_NOT_APPROVED). Review content on the Approved content page.
              </p>
            </div>
            <Switch
              id="content-approval"
              checked={org.content_approval_required}
              disabled={setApproval.isPending}
              onCheckedChange={(v) => (v ? setApprovalOn(true) : setApproval.mutate(false))}
            />
          </div>
        ) : null}

        <ConfirmDialog
          open={pendingOff !== null}
          onOpenChange={(o) => !o && setPendingOff(null)}
          title={`Turn off ${offFlag?.label ?? ""}?`}
          description={offFlag?.offWarning}
          confirmLabel="Turn off"
          onConfirm={async () => {
            if (pendingOff) await update.mutateAsync({ [pendingOff]: false });
          }}
        />
        <ConfirmDialog
          open={approvalOn}
          onOpenChange={(o) => !o && setApprovalOn(false)}
          title="Require content approval?"
          destructive={false}
          description="From now on this account can only send message content that a super admin has approved. Approve its content on the Approved content page, or it won't be able to send."
          confirmLabel="Require approval"
          onConfirm={async () => {
            await setApproval.mutateAsync(true);
            setApprovalOn(false);
          }}
        />
      </CardContent>
    </Card>
  );
}
