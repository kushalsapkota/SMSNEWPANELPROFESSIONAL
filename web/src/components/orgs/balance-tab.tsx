"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Minus, Plus, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { DataTable, type Column } from "@/components/data-table";
import {
  MoneyField,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@/components/shared/form-fields";
import { Money } from "@/components/shared/money";
import { StatCard } from "@/components/shared/stat-card";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { StatusBadge } from "@/components/shared/status-badge";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useTableState } from "@/hooks/use-table-state";
import { api, isApiError, qk } from "@/lib/api";
import { toast } from "sonner";
import type { BalanceMutationResponse, BalanceTransaction, OrgBalance, OrgDetail } from "@/lib/api/types";
import { formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { newIdempotencyKey } from "@/lib/id";

/**
 * The api records the ledger row first; if the engine is unreachable it answers
 * 502 with details.transaction_id and a reconciler applies the credit later.
 * Treat that as "recorded, pending" rather than a failure.
 */
async function creditOrPending(fn: () => Promise<BalanceMutationResponse>): Promise<BalanceMutationResponse | "PENDING"> {
  try {
    return await fn();
  } catch (e) {
    if (isApiError(e) && e.status === 502 && e.details && "transaction_id" in e.details) {
      toast.warning("Recorded — the balance will update shortly", {
        description: "The billing engine is temporarily unreachable; the transaction is applied automatically.",
      });
      return "PENDING";
    }
    throw e;
  }
}

function balanceInvalidations(orgId: string) {
  return [qk.orgs.balance(orgId), qk.orgs.detail(orgId), ["orgs", "transactions", orgId], ["orgs", "list"], qk.dashboard];
}

/* ------------------------------------------------------------ top-up */

const topupSchema = z.object({
  amount_micros: z
    .number({ invalid_type_error: "Enter an amount" })
    .int()
    .positive("Amount must be greater than zero")
    .nullable()
    .refine((v) => v !== null, "Enter an amount"),
  note: z.string().trim().max(500),
});

function TopupDialog({ orgId, currency }: { orgId: string; currency: string }) {
  const [open, setOpen] = useState(false);
  // One key per dialog session: a double-submit / network retry can't credit twice.
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);
  const form = useForm<z.input<typeof topupSchema>, unknown, z.output<typeof topupSchema>>({
    resolver: zodResolver(topupSchema),
    defaultValues: { amount_micros: null, note: "" },
  });
  const topup = useApiMutation({
    mutationFn: (v: z.output<typeof topupSchema>) =>
      creditOrPending(() =>
        api.orgs.topup(orgId, {
          amount_micros: v.amount_micros as number,
          note: v.note || undefined,
          idempotency_key: idemKey,
        }),
      ),
    success: (d, v) =>
      d === "PENDING"
        ? null
        : d.replay
          ? "This top-up was already recorded"
          : `Added ${formatMoney(v.amount_micros, currency)}`,
    invalidate: balanceInvalidations(orgId),
    onSuccess: () => {
      setOpen(false);
      form.reset();
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setIdemKey(newIdempotencyKey());
        else form.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus /> Top up
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Top up balance</DialogTitle>
          <DialogDescription>Records a payment and credits the balance immediately.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => topup.mutate(v))} className="space-y-4" noValidate>
            <MoneyField control={form.control} name="amount_micros" label="Amount" currency={currency} />
            <TextareaField control={form.control} name="note" label="Note" placeholder="Invoice / payment reference" rows={2} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton pending={topup.isPending}>Top up</SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------ adjust */

const adjustSchema = z.object({
  amount_micros: z
    .number({ invalid_type_error: "Enter an amount" })
    .int()
    .nullable()
    .refine((v) => v !== null && v !== 0, "Enter a non-zero amount (negative to deduct)"),
  note: z.string().trim().min(3, "A note is required for adjustments").max(500),
});

function AdjustDialog({ orgId, currency }: { orgId: string; currency: string }) {
  const [open, setOpen] = useState(false);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);
  const form = useForm<z.input<typeof adjustSchema>, unknown, z.output<typeof adjustSchema>>({
    resolver: zodResolver(adjustSchema),
    defaultValues: { amount_micros: null, note: "" },
  });
  const amount = form.watch("amount_micros");
  const adjust = useApiMutation({
    mutationFn: (v: z.output<typeof adjustSchema>) =>
      creditOrPending(() =>
        api.orgs.adjust(orgId, { amount_micros: v.amount_micros as number, note: v.note, idempotency_key: idemKey }),
      ),
    success: (d) => (d === "PENDING" ? null : d.replay ? "This adjustment was already recorded" : "Balance adjusted"),
    invalidate: balanceInvalidations(orgId),
    onSuccess: () => {
      setOpen(false);
      form.reset();
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setIdemKey(newIdempotencyKey());
        else form.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <SlidersHorizontal /> Adjust
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust balance</DialogTitle>
          <DialogDescription>
            Corrections and goodwill credits. Use a negative amount to deduct.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => adjust.mutate(v))} className="space-y-4" noValidate>
            <MoneyField
              control={form.control}
              name="amount_micros"
              label="Amount (signed)"
              currency={currency}
              allowNegative
              placeholder="-5.00 or 5.00"
            />
            {typeof amount === "number" && amount !== 0 ? (
              <p className="flex items-center gap-1 text-sm text-muted-foreground">
                {amount < 0 ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                This will {amount < 0 ? "deduct" : "add"} <Money micros={Math.abs(amount)} currency={currency} />
              </p>
            ) : null}
            <TextareaField control={form.control} name="note" label="Note (required)" rows={2} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton pending={adjust.isPending} variant={amount !== null && amount !== undefined && amount < 0 ? "destructive" : "default"}>
                Apply adjustment
              </SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------- billing */

const billingSchema = z
  .object({
    billing_mode: z.enum(["PREPAID", "POSTPAID"]),
    credit_limit_micros: z.number().int().min(0, "Cannot be negative").nullable(),
    low_balance_alert_micros: z.number().int().min(0, "Cannot be negative").nullable(),
  })
  .refine((v) => v.billing_mode === "POSTPAID" || !v.credit_limit_micros, {
    path: ["credit_limit_micros"],
    message: "Prepaid accounts have no credit limit",
  });

function BillingCard({ orgId, balance }: { orgId: string; balance: OrgBalance }) {
  const toValues = (b: OrgBalance): z.input<typeof billingSchema> => ({
    billing_mode: b.billing_mode,
    credit_limit_micros: b.credit_limit_micros,
    low_balance_alert_micros: b.low_balance_alert_micros,
  });
  const form = useForm<z.input<typeof billingSchema>, unknown, z.output<typeof billingSchema>>({
    resolver: zodResolver(billingSchema),
    defaultValues: toValues(balance),
  });
  useEffect(() => form.reset(toValues(balance)), [balance, form]);
  const mode = form.watch("billing_mode");
  const save = useApiMutation({
    mutationFn: (v: z.output<typeof billingSchema>) =>
      api.orgs.updateBilling(orgId, {
        billing_mode: v.billing_mode,
        credit_limit_micros: v.billing_mode === "POSTPAID" ? (v.credit_limit_micros ?? 0) : 0,
        low_balance_alert_micros: v.low_balance_alert_micros,
      }),
    success: "Billing settings saved",
    invalidate: balanceInvalidations(orgId),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Billing mode</CardTitle>
        <CardDescription>Postpaid accounts may go negative down to the credit limit.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
            <SelectField
              control={form.control}
              name="billing_mode"
              label="Mode"
              options={[
                { value: "PREPAID", label: "Prepaid" },
                { value: "POSTPAID", label: "Postpaid" },
              ]}
            />
            <MoneyField
              control={form.control}
              name="credit_limit_micros"
              label="Credit limit"
              currency={balance.currency}
              disabled={mode !== "POSTPAID"}
            />
            <MoneyField
              control={form.control}
              name="low_balance_alert_micros"
              label="Low-balance alert at"
              currency={balance.currency}
              placeholder="No alert"
            />
            <div className="flex justify-end">
              <SubmitButton pending={save.isPending} disabled={!form.formState.isDirty}>
                Save
              </SubmitButton>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------ transactions */

function txColumns(currency: string): Column<BalanceTransaction>[] {
  return [
    { id: "created_at", header: "Date", cell: (t) => formatDateTime(t.created_at) },
    { id: "type", header: "Type", cell: (t) => <StatusBadge status={t.type} /> },
    {
      id: "amount_micros",
      header: "Amount",
      align: "right",
     
      cell: (t) => <Money micros={t.amount_micros} currency={currency} signed />,
    },
    {
      id: "balance_after_micros",
      header: "Balance after",
      align: "right",
      hideOnMobile: true,
      cell: (t) => <Money micros={t.balance_after_micros} currency={currency} />,
    },
    {
      id: "note",
      header: "Note",
      hideOnMobile: true,
      cell: (t) => (
        <div className="max-w-xs">
          <div className="truncate">{t.note || t.reference || "—"}</div>
          {t.created_by_email ? <div className="truncate text-xs text-muted-foreground">by {t.created_by_email}</div> : null}
        </div>
      ),
    },
    {
      id: "applied_at",
      header: "Applied",
      hideOnMobile: true,
      cell: (t) => (t.applied_at ? formatDateTime(t.applied_at) : <StatusBadge status="PENDING" label="Pending" />),
    },
  ];
}

function TransactionsCard({ orgId, currency }: { orgId: string; currency: string }) {
  const t = useTableState({ prefix: "tx", defaultPageSize: 10 });
  const q = useQuery({
    queryKey: qk.orgs.transactions(orgId, t.params),
    queryFn: () => api.orgs.transactions(orgId, t.params),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Transactions</CardTitle>
        <CardDescription>Ledger of top-ups, adjustments, refunds and settlements.</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          caption="Transactions"
          columns={txColumns(currency)}
          data={q.data}
          rowKey={(r) => r.id}
          isLoading={q.isLoading}
          isFetching={q.isFetching}
          error={q.error}
          onRetry={() => q.refetch()}
          state={t.state}
          onStateChange={t.setState}
          empty={{ title: "No transactions yet" }}
        />
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------------- tab */

export function BalanceTab({ org }: { org: OrgDetail }) {
  const q = useQuery({
    queryKey: qk.orgs.balance(org.id),
    queryFn: () => api.orgs.balance(org.id),
    initialData: org.balance ?? undefined,
  });
  if (q.isLoading) return <LoadingState />;
  if (!q.data) return <ErrorState error={q.error ?? new Error("No balance account")} onRetry={() => q.refetch()} />;
  const b = q.data;
  const available = b.balance_micros + (b.billing_mode === "POSTPAID" ? b.credit_limit_micros : 0);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <AdjustDialog orgId={org.id} currency={b.currency} />
        <TopupDialog orgId={org.id} currency={b.currency} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          title="Balance"
          tone={b.balance_micros < 0 ? "destructive" : "default"}
          value={<Money micros={b.balance_micros} currency={b.currency} />}
        />
        <StatCard
          title="Credit limit"
          value={<Money micros={b.billing_mode === "POSTPAID" ? b.credit_limit_micros : 0} currency={b.currency} />}
          hint={b.billing_mode === "POSTPAID" ? "Postpaid" : "Prepaid — no credit"}
        />
        <StatCard
          title="Available to spend"
          tone={available <= 0 ? "destructive" : "success"}
          value={<Money micros={available} currency={b.currency} />}
          hint={
            b.low_balance_alert_micros !== null ? (
              <>Alert below <Money micros={b.low_balance_alert_micros} currency={b.currency} /></>
            ) : undefined
          }
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <BillingCard orgId={org.id} balance={b} />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <TransactionsCard orgId={org.id} currency={b.currency} />
        </div>
      </div>
    </div>
  );
}
