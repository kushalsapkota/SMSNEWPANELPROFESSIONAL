"use client";

import { Ban, Pause, Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { Campaign, CampaignStatus } from "@/lib/api/types";

export const canStart = (s: CampaignStatus) => s === "DRAFT" || s === "PAUSED" || s === "SCHEDULED";
export const canPause = (s: CampaignStatus) => s === "RUNNING" || s === "SCHEDULED";
export const canCancel = (s: CampaignStatus) => s === "DRAFT" || s === "SCHEDULED" || s === "RUNNING" || s === "PAUSED";
export const isActive = (s: CampaignStatus) => s === "RUNNING" || s === "SCHEDULED";

/** Progress (0..100) of a campaign: processed (submitted + failed) / total. */
export function campaignProgress(c: Pick<Campaign, "total" | "submitted" | "failed">): number {
  if (c.total <= 0) return 0;
  return Math.min(100, ((c.submitted + c.failed) / c.total) * 100);
}

/** Start / pause / cancel buttons for one campaign. */
export function CampaignActions({ campaign, size = "sm" }: { campaign: Campaign; size?: "sm" | "default" }) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const invalidate = [qk.campaigns.all];
  const start = useApiMutation({
    mutationFn: () => api.campaigns.start(campaign.id),
    success: campaign.status === "PAUSED" ? "Campaign resumed" : "Campaign started",
    invalidate,
  });
  const pause = useApiMutation({ mutationFn: () => api.campaigns.pause(campaign.id), success: "Campaign paused", invalidate });
  const cancel = useApiMutation({ mutationFn: () => api.campaigns.cancel(campaign.id), success: "Campaign cancelled", invalidate });
  const busy = start.isPending || pause.isPending || cancel.isPending;
  const s = campaign.status;

  return (
    <div className="flex flex-wrap justify-end gap-1">
      {canStart(s) ? (
        <Button size={size} variant="outline" disabled={busy} onClick={() => start.mutate()}>
          <Play aria-hidden /> {s === "PAUSED" ? "Resume" : s === "SCHEDULED" ? "Start now" : "Start"}
        </Button>
      ) : null}
      {canPause(s) ? (
        <Button size={size} variant="outline" disabled={busy} onClick={() => pause.mutate()}>
          <Pause aria-hidden /> Pause
        </Button>
      ) : null}
      {canCancel(s) ? (
        <Button size={size} variant="ghost" className="text-destructive" disabled={busy} onClick={() => setCancelOpen(true)}>
          <Ban aria-hidden /> Cancel
        </Button>
      ) : null}
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={`Cancel “${campaign.name}”?`}
        description="Recipients that haven't been sent yet are skipped. Messages already submitted are not recalled. This can't be undone."
        confirmLabel="Cancel campaign"
        onConfirm={async () => {
          await cancel.mutateAsync();
        }}
      />
    </div>
  );
}

/** Thin progress bar with an accessible value. */
export function ProgressBar({ value, label, className }: { value: number; label: string; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      className={`h-2 w-full overflow-hidden rounded-full bg-muted ${className ?? ""}`}
    >
      <div className="h-full rounded-full bg-[var(--chart-1)] transition-[width]" style={{ width: `${value}%` }} />
    </div>
  );
}
