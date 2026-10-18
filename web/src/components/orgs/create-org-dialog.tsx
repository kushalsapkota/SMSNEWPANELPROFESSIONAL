"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
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
import { Separator } from "@/components/ui/separator";
import {
  MoneyField,
  NumberField,
  SelectField,
  SubmitButton,
  TextField,
} from "@/components/shared/form-fields";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import { emailSchema, passwordSchema, positiveIntOrNull } from "@/lib/validation";
import { KIND, type OrgKind } from "./kind";

const schema = z
  .object({
    name: z.string().trim().min(2, "At least 2 characters").max(200),
    email: emailSchema,
    password: passwordSchema,
    full_name: z.string().trim().max(200),
    brand_name: z.string().trim().max(100),
    max_tps: z.number().int().positive("Must be > 0").max(100_000),
    daily_limit: positiveIntOrNull,
    monthly_limit: positiveIntOrNull,
    billing_mode: z.enum(["PREPAID", "POSTPAID"]),
    credit_limit_micros: z.number().int().min(0).nullable(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "3-letter ISO code")
      .transform((v) => v.toUpperCase()),
  })
  .refine((v) => v.billing_mode === "POSTPAID" || !v.credit_limit_micros, {
    path: ["credit_limit_micros"],
    message: "Credit limit is only for postpaid accounts",
  });

type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

const defaults: Values = {
  name: "",
  email: "",
  password: "",
  full_name: "",
  brand_name: "",
  max_tps: 10,
  daily_limit: null,
  monthly_limit: null,
  billing_mode: "PREPAID",
  credit_limit_micros: null,
  currency: "USD",
};

export function CreateOrgDialog({ kind }: { kind: OrgKind }) {
  const k = KIND[kind];
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useForm<Values, unknown, Output>({ resolver: zodResolver(schema), defaultValues: defaults });
  const billingMode = form.watch("billing_mode");
  const currency = form.watch("currency");

  const create = useApiMutation({
    mutationFn: (v: Output) =>
      api.orgs.create({
        name: v.name,
        email: v.email,
        password: v.password,
        full_name: v.full_name || undefined,
        brand_name: v.brand_name || undefined,
        max_tps: v.max_tps,
        daily_limit: v.daily_limit ?? undefined,
        monthly_limit: v.monthly_limit ?? undefined,
        billing_mode: v.billing_mode,
        credit_limit_micros: v.billing_mode === "POSTPAID" ? (v.credit_limit_micros ?? 0) : 0,
        currency: v.currency,
      }),
    success: (org) => `${k.singular} “${org.name}” created`,
    invalidate: [qk.orgs.all, qk.dashboard],
    onSuccess: (org) => {
      setOpen(false);
      form.reset(defaults);
      router.push(`${k.basePath}/${org.id}`);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) form.reset(defaults);
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus /> New {k.singular.toLowerCase()}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New {k.singular.toLowerCase()}</DialogTitle>
          <DialogDescription>
            Creates the organization, its owner login and a balance account.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((v) => create.mutate(v))}
            className="space-y-6"
            noValidate
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField control={form.control} name="name" label="Organization name" />
              <TextField
                control={form.control}
                name="brand_name"
                label="Brand name"
                description="Fills {brand} in OTP templates."
              />
            </div>
            <Separator />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField control={form.control} name="full_name" label="Owner full name" />
              <TextField control={form.control} name="email" label="Owner email" type="email" autoComplete="off" />
              <TextField
                control={form.control}
                name="password"
                label="Initial password"
                type="password"
                autoComplete="new-password"
                description="At least 8 characters."
              />
            </div>
            <Separator />
            <div className="grid gap-4 sm:grid-cols-3">
              <NumberField control={form.control} name="max_tps" label="Max TPS" min={1} />
              <NumberField control={form.control} name="daily_limit" label="Daily limit" placeholder="Unlimited" min={1} />
              <NumberField control={form.control} name="monthly_limit" label="Monthly limit" placeholder="Unlimited" min={1} />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <SelectField
                control={form.control}
                name="billing_mode"
                label="Billing mode"
                options={[
                  { value: "PREPAID", label: "Prepaid" },
                  { value: "POSTPAID", label: "Postpaid" },
                ]}
              />
              <MoneyField
                control={form.control}
                name="credit_limit_micros"
                label="Credit limit"
                currency={currency || "USD"}
                disabled={billingMode !== "POSTPAID"}
              />
              <TextField control={form.control} name="currency" label="Currency" placeholder="USD" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton pending={create.isPending}>Create {k.singular.toLowerCase()}</SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
