"use client";

import { useQuery } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import { Money } from "@/components/shared/money";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, qk } from "@/lib/api";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

/** Acting org's balance. Not shown for SUPER_ADMIN (never billed). */
export function BalanceChip({ orgId }: { orgId: string }) {
  const q = useQuery({
    queryKey: qk.orgs.balance(orgId),
    queryFn: () => api.orgs.balance(orgId),
    refetchInterval: 60_000,
  });
  if (!q.data) return null;
  const b = q.data;
  const available = b.balance_micros + (b.billing_mode === "POSTPAID" ? b.credit_limit_micros : 0);
  const low =
    available <= 0 ||
    (b.low_balance_alert_micros !== null && b.balance_micros <= b.low_balance_alert_micros);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium",
            low && "border-destructive/50 text-destructive",
          )}
          tabIndex={0}
          aria-label={`Balance ${formatMoney(b.balance_micros, b.currency)}`}
        >
          <Wallet className="h-3.5 w-3.5" aria-hidden />
          <Money micros={b.balance_micros} currency={b.currency} decimals={2} />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {b.billing_mode === "POSTPAID"
          ? `Postpaid · credit limit ${formatMoney(b.credit_limit_micros, b.currency)}`
          : "Prepaid balance"}
      </TooltipContent>
    </Tooltip>
  );
}
