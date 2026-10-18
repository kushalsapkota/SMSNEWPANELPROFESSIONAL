"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/shared/status-badge";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { api, errorMessage, qk } from "@/lib/api";
import type { InlineTemplate, TemplatePreviewRequest } from "@/lib/api/types";
import { analyzeSms } from "@/lib/sms";
import { cn } from "@/lib/utils";

export const DEFAULT_SAMPLE = "Your verification code is 849201. Do not share it with anyone.";

/**
 * LIVE preview: posts the in-progress template + sample text to
 * POST /api/templates/preview (debounced) and shows what the engine would do.
 */
export function TemplatePreview({
  template,
  routeId,
  orgId,
  valid,
}: {
  template: InlineTemplate;
  routeId?: string;
  orgId?: string;
  /** false while the form has errors that would make the preview meaningless */
  valid: boolean;
}) {
  const [sample, setSample] = useState(DEFAULT_SAMPLE);
  const body: TemplatePreviewRequest = {
    text: sample,
    route_id: routeId || undefined,
    org_id: orgId || undefined,
    template,
  };
  const bodyKey = JSON.stringify(body);
  const debouncedKey = useDebouncedValue(bodyKey, 400);
  const debounced = useMemo(() => JSON.parse(debouncedKey) as TemplatePreviewRequest, [debouncedKey]);
  const ready = valid && debounced.text.trim() !== "";
  const q = useQuery({
    queryKey: qk.templates.preview(debounced),
    queryFn: ({ signal }) => api.templates.preview(debounced, signal),
    enabled: ready,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
  const pending = bodyKey !== debouncedKey || q.isFetching;
  const r = q.data;
  const local = r?.output ? analyzeSms(r.output) : null;

  return (
    <div className="space-y-4" aria-live="polite">
      <div className="space-y-2">
        <Label htmlFor="preview-sample">Sample incoming message</Label>
        <Textarea
          id="preview-sample"
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          rows={3}
          className="font-mono text-sm"
        />
      </div>

      <div className="rounded-lg border bg-muted/30 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">Engine result</span>
          {pending && ready ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Updating" /> : null}
        </div>
        {!valid ? (
          <p className="text-sm text-muted-foreground">Fix the highlighted fields to see a preview.</p>
        ) : q.isError ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {errorMessage(q.error)}
          </p>
        ) : !r ? (
          <p className="text-sm text-muted-foreground">{ready ? "Evaluating…" : "Type a sample message."}</p>
        ) : (
          <dl className={cn("space-y-3 text-sm", pending && "opacity-60")}>
            <div className="flex flex-wrap items-center gap-2">
              <dt className="text-muted-foreground">Action</dt>
              <dd>
                <StatusBadge status={r.action} />
              </dd>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <dt className="text-muted-foreground">Extracted OTP</dt>
              <dd>
                {r.otp ? (
                  <code className="rounded bg-background px-2 py-0.5 font-mono text-base font-semibold">{r.otp}</code>
                ) : (
                  <span className="text-warning">none found</span>
                )}
              </dd>
            </div>
            {r.matched_pattern ? (
              <div className="flex flex-wrap items-center gap-2">
                <dt className="text-muted-foreground">Matched pattern</dt>
                <dd>
                  <code className="break-all text-xs">{r.matched_pattern}</code>
                </dd>
              </div>
            ) : null}
            <div className="space-y-1">
              <dt className="text-muted-foreground">Final output</dt>
              <dd>
                {r.output !== null ? (
                  <pre className="whitespace-pre-wrap break-words rounded border bg-background p-3 font-mono text-sm">{r.output}</pre>
                ) : (
                  <span className="text-destructive">Message would be rejected (OTP_NOT_FOUND)</span>
                )}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Encoding</dt>
                <dd className="font-medium">{r.encoding}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Parts</dt>
                <dd className={cn("font-medium", r.parts > 1 && "text-warning")}>{r.parts}</dd>
              </div>
              {local ? (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">Length</dt>
                  <dd className="font-medium">
                    {local.units} {local.encoding === "GSM7" ? "septets" : "chars"}
                  </dd>
                </div>
              ) : null}
            </div>
          </dl>
        )}
      </div>
    </div>
  );
}
