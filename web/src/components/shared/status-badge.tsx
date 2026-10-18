import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Variant = NonNullable<BadgeProps["variant"]>;

const MAP: Record<string, Variant> = {
  // org
  ACTIVE: "success",
  SUSPENDED: "destructive",
  CLOSED: "muted",
  // sender ids
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "destructive",
  // messages
  ACCEPTED: "secondary",
  QUEUED: "secondary",
  SUBMITTED: "warning",
  DELIVERED: "success",
  UNDELIVERED: "destructive",
  FAILED: "destructive",
  EXPIRED: "destructive",
  UNKNOWN: "muted",
  // campaigns
  DRAFT: "muted",
  SCHEDULED: "secondary",
  RUNNING: "warning",
  PAUSED: "secondary",
  COMPLETED: "success",
  CANCELLED: "muted",
  // connections
  BOUND: "success",
  BOUND_TRX: "success",
  CONNECTING: "warning",
  DOWN: "destructive",
  DISABLED: "muted",
  // template actions
  TEMPLATED: "success",
  SEND_RAW: "secondary",
  REJECT: "destructive",
  SEND_DEFAULT_TEMPLATE: "warning",
  // ledger
  TOPUP: "success",
  DEDUCT: "destructive",
  ADJUSTMENT: "secondary",
  REFUND: "success",
  USAGE_SETTLEMENT: "secondary",
};

export function humanize(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Colored badge for any enum-ish status in the contract. */
export function StatusBadge({
  status,
  label,
  className,
}: {
  status: string;
  label?: string;
  className?: string;
}) {
  return (
    <Badge variant={MAP[status] ?? "outline"} className={cn("whitespace-nowrap", className)}>
      {label ?? humanize(status)}
    </Badge>
  );
}

/** On / off badge for boolean flags (enabled, api_enabled, ...). */
export function BoolBadge({
  value,
  on = "Enabled",
  off = "Disabled",
}: {
  value: boolean;
  on?: string;
  off?: string;
}) {
  return <Badge variant={value ? "success" : "muted"}>{value ? on : off}</Badge>;
}
