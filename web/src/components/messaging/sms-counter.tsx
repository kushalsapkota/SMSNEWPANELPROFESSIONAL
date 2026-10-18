"use client";

import { AlertTriangle, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";
import { MAX_PARTS, type SmsAnalysis, analyzeSms, canBecomeGsm, encodingLabel, toGsmSafe, visibleChar } from "@/lib/sms";
import { cn } from "@/lib/utils";

/**
 * Live encoding / length / parts readout for a message body (CONTRACTS §3).
 * Shows which characters forced UCS-2 and offers a one-click fix when they
 * are only typographic look-alikes.
 */
export function SmsCounter({
  text,
  analysis,
  onFix,
  className,
  note,
}: {
  text: string;
  analysis?: SmsAnalysis;
  /** called with the GSM-safe text when the user accepts the fix */
  onFix?: (fixed: string) => void;
  className?: string;
  note?: string;
}) {
  const a = analysis ?? analyzeSms(text);
  const unit = a.encoding === "GSM7" ? "septets" : "UTF-16 units";
  const fixable = onFix && a.encoding === "UCS2" && canBecomeGsm(text);
  return (
    <div className={cn("space-y-2 text-xs", className)} aria-live="polite">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        <Badge variant={a.encoding === "GSM7" ? "secondary" : "warning"}>{encodingLabel(a.encoding)}</Badge>
        <span className="tabular-nums">
          {formatNumber(a.chars)} chars · {formatNumber(a.units)} {unit}
        </span>
        <span className={cn("tabular-nums", a.tooLong ? "font-semibold text-destructive" : "text-foreground")}>
          {a.parts} {a.parts === 1 ? "part" : "parts"}
        </span>
        {a.parts > 0 && !a.tooLong ? (
          <span className="tabular-nums">
            {formatNumber(a.remaining)} left in part {a.parts} ({a.perPart}/part)
          </span>
        ) : null}
        {a.extChars > 0 ? (
          <span title="^ { } \ [ ~ ] | € and form feed take 2 septets each">
            {a.extChars} extended {a.extChars === 1 ? "char" : "chars"} (2 septets each)
          </span>
        ) : null}
        {note ? <span>{note}</span> : null}
      </div>
      {a.tooLong ? (
        <p className="flex items-center gap-1.5 text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Longer than {MAX_PARTS} parts: the gateway will reject it
          (MESSAGE_TOO_LONG).
        </p>
      ) : null}
      {a.nonGsm.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>Unicode because of:</span>
          {a.nonGsm.slice(0, 12).map((ch) => (
            <code key={ch} className="rounded border bg-muted px-1 font-mono text-foreground">
              {visibleChar(ch)}
            </code>
          ))}
          {a.nonGsm.length > 12 ? <span>+{a.nonGsm.length - 12} more</span> : null}
          {fixable ? (
            <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => onFix(toGsmSafe(text))}>
              <Wand2 className="h-3 w-3" aria-hidden /> Replace with GSM characters
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
